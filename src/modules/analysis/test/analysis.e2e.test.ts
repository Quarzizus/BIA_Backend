import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../../../app";
import type { LlmClient } from "../llm/analysis.llm.client";
import {
  createTestPrisma,
  provisionTestDb,
  seedTestDb,
} from "../../../testing/analysisTestDb";

const prisma = createTestPrisma();

/**
 * Fake LLM (design D8): deterministic Spanish outputs, no network. The E2E runs
 * against the isolated bia_test DB seeded with the real 12/4032/4 dataset, so
 * the four spec ground truths (M-109/104/106/112) are exercised on real data.
 */
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

const VALID_ENV = {
  AI_API_KEY: "test-key",
  AI_BASE_URL: "https://fake/v1",
  AI_MODEL: "test",
};

let baseUrl: string;
let server: import("node:http").Server;
const CLEAN_METERS = ["M-101", "M-102", "M-103", "M-105", "M-107", "M-108", "M-110", "M-111"];

async function waitForCompletion(runId: string, timeoutMs = 15000): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/ai/analysis/${runId}`);
    const body = (await res.json()) as Record<string, any>;
    if (body.status === "COMPLETED" || body.status === "FAILED") return body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`analysis run ${runId} did not finish within ${timeoutMs}ms`);
}

beforeAll(async () => {
  await provisionTestDb();
  await seedTestDb(prisma);
  const app = createApp(prisma, { analysis: { ...VALID_ENV, llm: fakeLlm() } });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe("E2E pipeline on real seeded data (spec analysis-pipeline)", () => {
  test("POST /ai/analyze → 202; run completes with the 4 ground-truth anomalies", async () => {
    const res = await fetch(`${baseUrl}/ai/analyze`, { method: "POST" });
    expect(res.status).toBe(202);
    const { analysis_id } = (await res.json()) as { analysis_id: string };

    const completed = await waitForCompletion(analysis_id);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.anomaly_count).toBe(4);
    expect(completed.llm_used).toBe(true);

    // 4 anomalies, one per affected meter (spec anomalies-api scenario).
    const anomalies = await prisma.anomaly.findMany({
      where: { analysisRunId: analysis_id },
      include: { meter: true, relatedEvent: true },
      orderBy: { meter: { meterId: "asc" } },
    });
    expect(anomalies).toHaveLength(4);
    const byMeter = new Map(anomalies.map((a) => [a.meter!.meterId, a]));

    // M-109 → REAL_ANOMALY/HIGH (spike z=8.79 + persistent, event UNKNOWN).
    const m109 = byMeter.get("M-109")!;
    expect(m109.type).toBe("REAL_ANOMALY");
    expect(m109.severity).toBe("HIGH");
    expect(m109.detectionType).toContain("SPIKE");
    expect(m109.detectionType).toContain("PERSISTENT_CHANGE");
    expect(m109.rangeStart.toISOString()).toBe("2026-09-12T14:00:00.000Z");
    expect(m109.rangeEnd.toISOString()).toBe("2026-09-14T23:00:00.000Z");
    expect(m109.relatedEvent?.eventType).toBe("UNKNOWN");
    expect((m109.signals as { max_z: number }).max_z).toBeGreaterThan(8);
    expect((m109.signals as { variables: string[] }).variables).toContain("consumption_kwh");
    expect((m109.signals as { variables: string[] }).variables).toContain("power_factor");

    // M-104 → EXPLAINABLE_ANOMALY/MEDIUM, change point 09-11 00:00.
    const m104 = byMeter.get("M-104")!;
    expect(m104.type).toBe("EXPLAINABLE_ANOMALY");
    expect(m104.severity).toBe("MEDIUM");
    expect(m104.rangeStart.toISOString()).toBe("2026-09-11T00:00:00.000Z");
    expect(m104.relatedEvent?.eventType).toBe("OPERATIONAL_CHANGE");

    // M-106 → FALSE_POSITIVE/LOW, drop window covers 09-08 (two-tailed rule).
    const m106 = byMeter.get("M-106")!;
    expect(m106.type).toBe("FALSE_POSITIVE");
    expect(m106.severity).toBe("LOW");
    expect(m106.rangeStart.toISOString()).toBe("2026-09-08T00:00:00.000Z");
    expect(m106.rangeEnd.toISOString()).toBe("2026-09-08T11:00:00.000Z");
    expect(m106.relatedEvent?.eventType).toBe("SCHEDULED_OUTAGE");

    // M-112 → DATA_QUALITY/HIGH.
    const m112 = byMeter.get("M-112")!;
    expect(m112.type).toBe("DATA_QUALITY");
    expect(m112.severity).toBe("HIGH");
    expect(m112.detectionType).toBe("DATA_QUALITY");
    expect(m112.rangeStart.toISOString()).toBe("2026-09-13T00:00:00.000Z");
    expect(m112.rangeEnd.toISOString()).toBe("2026-09-14T23:00:00.000Z");
    expect(m112.relatedEvent?.eventType).toBe("DATA_QUALITY");

    // Spanish explanations for every anomaly.
    for (const anomaly of anomalies) {
      expect(anomaly.reason).toContain("anómalo");
      expect(anomaly.recommendedAction).toContain("medidor");
    }

    // Meter status recomputed (D4): HIGH→CRITICAL, MEDIUM→ALERT.
    const m109Status = await prisma.meter.findUnique({ where: { id: m109.meterId } });
    expect(m109Status!.status).toBe("CRITICAL");
    const m104Status = await prisma.meter.findUnique({ where: { id: m104.meterId } });
    expect(m104Status!.status).toBe("ALERT");
  });

  test("8 clean meters produce zero anomalies", async () => {
    const count = await prisma.anomaly.count({
      where: { meter: { meterId: { in: CLEAN_METERS } } },
    });
    expect(count).toBe(0);
  });

  test("GET /anomalies exposes the 4 anomalies through the API (spec anomalies-api)", async () => {
    const res = await fetch(`${baseUrl}/anomalies`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, any>>;
    const real = body.find((a) => a.meter_id === "M-109");
    expect(real).toBeDefined();
    expect(real!.type).toBe("REAL_ANOMALY");
    expect(real!.severity).toBe("HIGH");
    expect(real!.recommended_action).toBe("Revisar la instalación del medidor.");
  });

  test("dashboard summary reflects the recomputed meter statuses (spec dashboard)", async () => {
    const res = await fetch(`${baseUrl}/dashboard/summary`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.meters_critical).toBeGreaterThanOrEqual(1);
    expect(body.open_by_severity.HIGH).toBeGreaterThanOrEqual(2);
    expect(body.open_by_severity.MEDIUM).toBeGreaterThanOrEqual(1);
  });

  test("second POST while a run is RUNNING → 409 ANALYSIS_IN_PROGRESS", async () => {
    // Occupy the single-running lock directly.
    const lockRun = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    try {
      const res = await fetch(`${baseUrl}/ai/analyze`, { method: "POST" });
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, any>;
      expect(body.error.code).toBe("ANALYSIS_IN_PROGRESS");
    } finally {
      await prisma.analysisRun.delete({ where: { id: lockRun.id } });
    }
  });

  test("POST /ai/analyze with an empty key → 503 AI_NOT_CONFIGURED (fail-fast)", async () => {
    const app = createApp(prisma, {
      analysis: {
        AI_API_KEY: "",
        AI_BASE_URL: "",
        AI_MODEL: "",
        llm: fakeLlm(),
      },
    });
    const isolated = app.listen(0);
    await new Promise<void>((resolve) => isolated.once("listening", resolve));
    const url = `http://localhost:${(isolated.address() as { port: number }).port}`;
    try {
      const res = await fetch(`${url}/ai/analyze`, { method: "POST" });
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, any>;
      expect(body.error.code).toBe("AI_NOT_CONFIGURED");
    } finally {
      await new Promise<void>((resolve) => isolated.close(() => resolve()));
    }
  });
});