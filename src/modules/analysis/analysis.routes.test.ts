import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "../../testing/testServer";
import { createAnalysisRouter } from "./routes";
import type { LlmClient } from "./llm.client";
import {
  createTestPrisma,
  provisionTestDb,
  seedTestDb,
} from "../../testing/analysisTestDb";

const prisma = createTestPrisma();

function fakeLlm(): LlmClient {
  return {
    async classify() {
      return {
        type: "REAL_ANOMALY",
        severity: "HIGH",
        reason: "Caso límite clasificado por el modelo.",
        recommended_action: "Revisar manualmente.",
      };
    },
    async explain() {
      return {
        reason: "Consumo anómalo detectado por el análisis estadístico.",
        recommended_action: "Revisar la instalación del medidor.",
      };
    },
  };
}

let server: TestServer;
let createdRunIds: string[] = [];

const VALID_ENV = {
  AI_API_KEY: "test-key",
  AI_BASE_URL: "https://fake/v1",
  AI_MODEL: "test",
};

beforeAll(async () => {
  await provisionTestDb();
  await seedTestDb(prisma);

  const router = createAnalysisRouter(prisma, { ...VALID_ENV, llm: fakeLlm() });
  server = await startTestServer([{ path: "/ai", router }]);
});

afterAll(async () => {
  await server.close();
  if (createdRunIds.length > 0) {
    await prisma.analysisRun.deleteMany({ where: { id: { in: createdRunIds } } });
  }
  await prisma.$disconnect();
});

describe("POST /ai/analyze", () => {
  test("returns 202 with analysis_id and completes the run asynchronously", async () => {
    const res = await fetch(`${server.baseUrl}/ai/analyze`, { method: "POST" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, string>;
    expect(typeof body.analysis_id).toBe("string");
    createdRunIds.push(body.analysis_id!);

    // Poll until COMPLETED (fake LLM → fast).
    let status = "RUNNING";
    for (let i = 0; i < 100 && status === "RUNNING"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const poll = (await (await fetch(`${server.baseUrl}/ai/analysis/${body.analysis_id}`)).json()) as Record<string, any>;
      status = poll.status;
    }
    expect(status).toBe("COMPLETED");
  });
});

describe("GET /ai/analysis/:id", () => {
  test("returns 404 NOT_FOUND for an unknown run id", async () => {
    const res = await fetch(`${server.baseUrl}/ai/analysis/cuid_nonexistent`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("returns status, summary and anomaly_count for a completed run", async () => {
    // Create a run directly (fixtures only) then read it through the API.
    const run = await prisma.analysisRun.create({
      data: { status: "COMPLETED", summary: "Detected 0 anomaly(ies)", llmUsed: false, completedAt: new Date() },
    });
    createdRunIds.push(run.id);
    const res = await fetch(`${server.baseUrl}/ai/analysis/${run.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.status).toBe("COMPLETED");
    expect(body.anomaly_count).toBe(0);
    expect(body.summary).toContain("0 anomaly");
  });
});