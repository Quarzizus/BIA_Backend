import { afterEach, describe, expect, test } from "bun:test";
import { createLlmClient, type LlmEnv } from "../llm/analysis.llm.client";

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
  // F3: los eventos viajan al modelo — son la razón de la ambigüedad.
  events: [
    { eventType: "OPERATIONAL_CHANGE", eventTimestamp: "2026-09-12T12:00:00.000Z" },
  ],
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
                confidence: 0.9,
                reason: "Consumo anómalo detectado",
                recommended_action: "Revisar instalación",
                reason_simple: "El consumo subió de forma notoria.",
                recommended_action_simple: "Revisa la instalación del medidor.",
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
      expect(result.confidence).toBe(0.9);
      expect(result.reason).toContain("anómalo");
      expect(result.recommended_action).toBe("Revisar instalación");
      expect(result.reason_simple).toContain("consumo");
      expect(result.recommended_action_simple).toContain("medidor");

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

  test("embeds the meter events in the classify prompt (F3)", async () => {
    const restore = mockFetch(
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                type: "FALSE_POSITIVE",
                severity: "LOW",
                confidence: 0.8,
                reason: "El evento explica la señal.",
                recommended_action: "Confirmar el evento.",
                reason_simple: "El evento programado explica la caída.",
                recommended_action_simple: "Confirmar el evento.",
              }),
            },
          },
        ],
      }),
    );
    try {
      const client = createLlmClient(env);
      await client.classify(classifyInput);
      const body = JSON.parse(fetchCalls[0]!.init.body as string);
      const userContent = body.messages.find((m: any) => m.role === "user").content as string;
      // El caso (payload) incluye los eventos y el prompt los señala como causa
      // de la ambigüedad.
      expect(userContent).toContain("OPERATIONAL_CHANGE");
      expect(userContent).toContain("2026-09-12T12:00:00.000Z");
      expect(userContent).toContain("eventos");
    } finally {
      restore();
    }
  });

  test("rejects a confidence out of range 0-1 in the response (F5)", async () => {
    const restore = mockFetch(
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                type: "REAL_ANOMALY",
                severity: "HIGH",
                confidence: 1.5,
                reason: "Consumo anómalo detectado",
                recommended_action: "Revisar instalación",
                reason_simple: "El consumo subió de forma notoria.",
                recommended_action_simple: "Revisa la instalación del medidor.",
              }),
            },
          },
        ],
      }),
    );
    try {
      const client = createLlmClient(env);
      await expect(client.classify(classifyInput)).rejects.toThrow(/failed validation/);
    } finally {
      restore();
    }
  });

  test("rejects classify input with a malformed events array (F3)", async () => {
    const restore = mockFetch(
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                type: "REAL_ANOMALY",
                severity: "HIGH",
                confidence: 0.9,
                reason: "r",
                recommended_action: "a",
                reason_simple: "s",
                recommended_action_simple: "s",
              }),
            },
          },
        ],
      }),
    );
    try {
      const client = createLlmClient(env);
      await expect(
        client.classify({
          ...classifyInput,
          events: [{ eventType: "", eventTimestamp: "not-a-date" }],
        }),
      ).rejects.toThrow(/input failed validation/);
      // Fail-fast: la request nunca llega al proveedor.
      expect(fetchCalls).toHaveLength(0);
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

  test("throws when the response omits the simple explanation fields", async () => {
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
                // reason_simple / recommended_action_simple faltan → schema fail-fast.
              }),
            },
          },
        ],
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
  test("returns the 4 Spanish explanations (technical + simple) for a confirmed anomaly", async () => {
    const restore = mockFetch(
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                reason: "Consumo muy por encima de la línea base durante un periodo sostenido.",
                recommended_action: "Revisar la instalación eléctrica del medidor.",
                reason_simple:
                  "El medidor está consumiendo casi el doble de lo normal desde septiembre.",
                recommended_action_simple: "Llama a un electricista para revisar la instalación.",
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
      expect(result.reason_simple).toContain("doble de lo normal");
      expect(result.recommended_action_simple).toContain("electricista");
      const body = JSON.parse(fetchCalls[0]!.init.body as string);
      expect(body.model).toBe("test-model");
    } finally {
      restore();
    }
  });

  test("throws when the explanation omits the simple fields", async () => {
    const restore = mockFetch(
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                reason: "Consumo muy por encima de la línea base.",
                recommended_action: "Revisar la instalación.",
              }),
            },
          },
        ],
      }),
    );
    try {
      const client = createLlmClient(env);
      await expect(client.explain(explainInput)).rejects.toThrow();
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