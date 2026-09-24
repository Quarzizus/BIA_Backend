import { afterEach, describe, expect, test } from "bun:test";
import { createLlmClient, type LlmEnv } from "../analysis.llm.client";

const env: LlmEnv = {
  AI_API_KEY: "test-key",
  AI_BASE_URL: "https://llm.example.com/v1",
  AI_MODEL: "test-model",
};

const classifyInput = {
  meterId: "M-LLM1",
  detectionType: "SPIKE",
  signals: { max_z: 2.8, variables: ["consumption_kwh"] },
  rangeStart: "2026-09-12T14:00:00.000Z",
  rangeEnd: "2026-09-12T18:00:00.000Z",
};

const explainInput = {
  meterId: "M-109",
  type: "REAL_ANOMALY" as const,
  severity: "HIGH" as const,
  detectionType: "SPIKE,PERSISTENT_CHANGE",
  signals: { max_z: 8.79, variation_pct: 152.5 },
  rangeStart: "2026-09-12T14:00:00.000Z",
  rangeEnd: "2026-09-14T23:00:00.000Z",
};

let fetchCalls: { url: string; init: RequestInit }[] = [];

function mockFetch(response: Response | Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    fetchCalls.push({ url: String(input), init: init ?? {} });
    return response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  fetchCalls = [];
});

describe("createLlmClient — classify", () => {
  test("posts to {AI_BASE_URL}/chat/completions with Bearer auth, model and messages", async () => {
    const restore = mockFetch(
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                type: "REAL_ANOMALY",
                severity: "HIGH",
                reason: "Consumo anómalo detectado",
                recommended_action: "Revisar instalación",
              }),
            },
          },
        ],
      }),
    );
    try {
      const client = createLlmClient(env);
      const result = await client.classify(classifyInput);
      expect(result.type).toBe("REAL_ANOMALY");
      expect(result.severity).toBe("HIGH");
      expect(result.reason).toContain("anómalo");
      expect(result.recommended_action).toBe("Revisar instalación");

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]!.url).toBe("https://llm.example.com/v1/chat/completions");
      const headers = fetchCalls[0]!.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-key");
      const body = JSON.parse(fetchCalls[0]!.init.body as string);
      expect(body.model).toBe("test-model");
      expect(body.messages.length).toBeGreaterThanOrEqual(1);
    } finally {
      restore();
    }
  });

  test("throws on malformed JSON in the LLM response", async () => {
    const restore = mockFetch(
      jsonResponse({ choices: [{ message: { content: "not-json" } }] }),
    );
    try {
      const client = createLlmClient(env);
      await expect(client.classify(classifyInput)).rejects.toThrow();
    } finally {
      restore();
    }
  });

  test("throws when the response does not match the zod schema", async () => {
    const restore = mockFetch(
      jsonResponse({
        choices: [{ message: { content: JSON.stringify({ type: "BOGUS" }) } }],
      }),
    );
    try {
      const client = createLlmClient(env);
      await expect(client.classify(classifyInput)).rejects.toThrow();
    } finally {
      restore();
    }
  });

  test("throws on an HTTP 500 provider error", async () => {
    const restore = mockFetch(jsonResponse({ error: "boom" }, 500));
    try {
      const client = createLlmClient(env);
      await expect(client.classify(classifyInput)).rejects.toThrow();
    } finally {
      restore();
    }
  });

  test("throws on network failure (fetch rejects)", async () => {
    const restore = mockFetch(Promise.reject(new Error("network down")));
    try {
      const client = createLlmClient(env);
      await expect(client.classify(classifyInput)).rejects.toThrow();
    } finally {
      restore();
    }
  });
});

describe("createLlmClient — explain", () => {
  test("returns Spanish reason + recommended_action for a confirmed anomaly", async () => {
    const restore = mockFetch(
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                reason: "Consumo muy por encima de la línea base durante un periodo sostenido.",
                recommended_action: "Revisar la instalación eléctrica del medidor.",
              }),
            },
          },
        ],
      }),
    );
    try {
      const client = createLlmClient(env);
      const result = await client.explain(explainInput);
      expect(result.reason).toContain("línea base");
      expect(result.recommended_action).toContain("medidor");
      const body = JSON.parse(fetchCalls[0]!.init.body as string);
      expect(body.model).toBe("test-model");
    } finally {
      restore();
    }
  });

  test("throws on malformed explanation response", async () => {
    const restore = mockFetch(
      jsonResponse({ choices: [{ message: { content: "no json" } }] }),
    );
    try {
      const client = createLlmClient(env);
      await expect(client.explain(explainInput)).rejects.toThrow();
    } finally {
      restore();
    }
  });
});