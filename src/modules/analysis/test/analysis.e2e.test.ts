import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../../../app";
import type { LlmClient } from "../llm/analysis.llm.client";
import {
  createTestPrisma,
  provisionTestDb,
  seedTestDb,
} from "../../../testing/testDb";
import { ensureAdminUser, signInAndGetCookie } from "../../../testing/authTestHelper";

const prisma = createTestPrisma("bia_test_analysis");

/**
 * LLM falso (diseño D8): salidas deterministas en español, sin red. El E2E corre
 * contra la base aislada bia_test_analysis sembrada con el dataset real
 * 12/4032/4, de modo que los cuatro ground truths de la spec (M-109/104/106/112)
 * se ejercitan sobre datos reales.
 */
function fakeLlm(): LlmClient {
  return {
    async classify() {
      return {
        type: "REAL_ANOMALY",
        severity: "HIGH",
        confidence: 0.9,
        reason: "Caso límite clasificado por el modelo.",
        recommended_action: "Revisar manualmente.",
        reason_simple: "El consumo subió de forma notoria. Algo se conectó o se dañó en la instalación.",
        recommended_action_simple:
          "Revisa la instalación del medidor. Llama a un electricista si persiste.",
      };
    },
    async explain() {
      return {
        reason: "Consumo anómalo detectado por el análisis estadístico.",
        recommended_action: "Revisar la instalación del medidor.",
        reason_simple: "El consumo subió de forma notoria. Algo se conectó o se dañó en la instalación.",
        recommended_action_simple:
          "Revisa la instalación del medidor. Llama a un electricista si persiste.",
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
let cookie: string;
const CLEAN_METERS = ["M-101", "M-102", "M-103", "M-105", "M-107", "M-108", "M-110", "M-111"];
const GROUND_TRUTH_METERS = ["M-109", "M-104", "M-106", "M-112"];

async function waitForCompletion(runId: string, timeoutMs = 15000): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/ai/analysis/${runId}`, { headers: { cookie } });
    const body = (await res.json()) as Record<string, any>;
    if (body.status === "COMPLETED" || body.status === "FAILED") return body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`analysis run ${runId} did not finish within ${timeoutMs}ms`);
}

beforeAll(async () => {
  await provisionTestDb("bia_test_analysis");
  await seedTestDb(prisma);
  // Caché de evidencia limpia: sin anomalías OPEN previas de los ground truths,
  // el run de esta invocación SÍ usa el LLM (llm_used=true) y no reutiliza
  // textos de una ejecución anterior del archivo.
  await prisma.anomaly.deleteMany({
    where: { meter: { meterId: { in: GROUND_TRUTH_METERS } } },
  });
  const app = createApp(prisma, { analysis: { ...VALID_ENV, llm: fakeLlm() } });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`;
  // Opción A: el pipeline de análisis está protegido — sesión admin para todo el archivo.
  await ensureAdminUser(prisma);
  cookie = await signInAndGetCookie(baseUrl);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe("E2E pipeline on real seeded data (spec analysis-pipeline)", () => {
  test("POST /ai/analyze → 202; run completes with the 4 ground-truth anomalies", async () => {
    const res = await fetch(`${baseUrl}/ai/analyze`, { method: "POST", headers: { cookie } });
    expect(res.status).toBe(202);
    const { analysis_id } = (await res.json()) as { analysis_id: string };

    const completed = await waitForCompletion(analysis_id);
    expect(completed.status).toBe("COMPLETED");
    // Run fresco con caché vacío: 4 detectadas, todas nuevas, LLM llamado.
    expect(completed.anomaly_count).toBe(4);
    expect(completed.new_anomalies).toBe(4);
    expect(completed.refreshed_anomalies).toBe(0);
    expect(completed.explanation_source).toBe("llm");
    expect(completed.llm_used).toBe(true);

    // 4 anomalías, una por medidor afectado (escenario anomalies-api de la spec).
    const anomalies = await prisma.anomaly.findMany({
      where: { analysisRunId: analysis_id },
      include: { meter: true, relatedEvent: true },
      orderBy: { meter: { meterId: "asc" } },
    });
    expect(anomalies).toHaveLength(4);
    const byMeter = new Map(anomalies.map((a) => [a.meter!.meterId, a]));

    // M-109 → REAL_ANOMALY/HIGH (spike z=8.79 + persistente, evento UNKNOWN).
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

    // Evidencia enriquecida: per_variable compara baseline (primeros 7 días) vs
    // el rango afectado [09-12 14:00, 09-14 23:00] con números reales del dataset.
    const m109Signals = m109.signals as {
      variables: string[];
      per_variable: Record<
        string,
        { baseline_mean: number; recent_mean: number; variation_pct: number; max_z: number }
      >;
    };
    expect(m109Signals.variables).toContain("current_a");
    expect(m109Signals.per_variable.consumption_kwh!.baseline_mean).toBeCloseTo(43.7, 1);
    expect(m109Signals.per_variable.consumption_kwh!.recent_mean).toBeGreaterThan(80);
    expect(m109Signals.per_variable.consumption_kwh!.variation_pct).toBeGreaterThan(100);
    expect(m109Signals.per_variable.consumption_kwh!.max_z).toBeCloseTo(9.73, 1);

    // M-104 → EXPLAINABLE_ANOMALY/MEDIUM, punto de cambio 09-11 00:00.
    const m104 = byMeter.get("M-104")!;
    expect(m104.type).toBe("EXPLAINABLE_ANOMALY");
    expect(m104.severity).toBe("MEDIUM");
    expect(m104.rangeStart.toISOString()).toBe("2026-09-11T00:00:00.000Z");
    expect(m104.relatedEvent?.eventType).toBe("OPERATIONAL_CHANGE");

    // M-106 → FALSE_POSITIVE/LOW, la ventana de caída cubre 09-08 (regla de dos colas).
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

    // M-112: per_variable cubre voltage_v/power_factor y los extras de DQ siguen intactos.
    const m112Signals = m112.signals as {
      per_variable: Record<
        string,
        { baseline_mean: number; recent_mean: number; variation_pct: number; max_z: number }
      >;
      voltage_sd_ratio: number;
      power_factor_sd_ratio: number;
    };
    expect(m112Signals.per_variable.voltage_v).toBeDefined();
    expect(m112Signals.per_variable.power_factor).toBeDefined();
    expect(m112Signals.per_variable.voltage_v!.baseline_mean).toBeCloseTo(220.97, 1);
    expect(m112Signals.per_variable.voltage_v!.max_z).toBeGreaterThan(10);
    expect(m112Signals.per_variable.power_factor!.max_z).toBeGreaterThan(10);
    expect(m112Signals.voltage_sd_ratio).toBeGreaterThan(5);
    expect(m112Signals.power_factor_sd_ratio).toBeGreaterThan(5);

    // Explicaciones en español para cada anomalía.
    for (const anomaly of anomalies) {
      expect(anomaly.reason).toContain("anómalo");
      expect(anomaly.recommendedAction).toContain("medidor");
    }

    // Status de medidor recalculado (D4): HIGH→CRITICAL, MEDIUM→ALERT.
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
    const res = await fetch(`${baseUrl}/anomalies`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, any>> };
    const real = body.items.find((a) => a.meter_id === "M-109");
    expect(real).toBeDefined();
    expect(real!.type).toBe("REAL_ANOMALY");
    expect(real!.severity).toBe("HIGH");
    // El normalizador garantiza el contrato de formato en lo expuesto por la API.
    expect(real!.recommended_action).toBe("- Revisar la instalación del medidor.");
    // La lista expone la versión simple de la acción (legible para el público).
    expect(real!.recommended_action_simple).toBeDefined();
    expect(real!.recommended_action_simple!.length).toBeGreaterThan(0);
  });

  test("GET /anomalies/:id exposes the 4 explanations (toggle simple/técnica)", async () => {
    const res = await fetch(`${baseUrl}/anomalies`, { headers: { cookie } });
    const body = (await res.json()) as { items: Array<Record<string, any>> };
    const real = body.items.find((a) => a.meter_id === "M-109");
    expect(real).toBeDefined();

    const detailRes = await fetch(`${baseUrl}/anomalies/${real!.id}`, { headers: { cookie } });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as Record<string, any>;
    expect(detail.reason).toContain("anómalo");
    expect(detail.recommended_action).toBe("- Revisar la instalación del medidor.");
    // Detalle: las 4 explicaciones (técnica + simple) tras un run con LLM.
    expect(detail.reason_simple).toBeDefined();
    expect(detail.reason_simple!.length).toBeGreaterThan(0);
    expect(detail.recommended_action_simple).toBeDefined();
    expect(detail.recommended_action_simple!.length).toBeGreaterThan(0);
  });

  test("dashboard summary reflects the recomputed meter statuses (spec dashboard)", async () => {
    const res = await fetch(`${baseUrl}/dashboard/summary`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    // Cotas inferiores (no exactas): analysis.service.test.ts comparte la base
    // bia_test_analysis y corre en paralelo, así que sus fixtures (p. ej. el
    // M-PZ1 CRITICAL de su run) pueden sumarse a estos conteos en cualquier
    // instante.
    expect(body.meters_critical).toBeGreaterThanOrEqual(1);
    expect(body.open_by_severity.HIGH).toBeGreaterThanOrEqual(2);
    expect(body.open_by_severity.MEDIUM).toBeGreaterThanOrEqual(1);
  });

  test("second POST while a run is RUNNING → 409 ANALYSIS_IN_PROGRESS", async () => {
    // Ocupar el lock de run único directamente.
    const lockRun = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    try {
      const res = await fetch(`${baseUrl}/ai/analyze`, { method: "POST", headers: { cookie } });
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
      // La cookie del servidor principal es válida aquí: misma base y mismo
      // secreto por proceso → misma sesión en la tabla `session`.
      const res = await fetch(`${url}/ai/analyze`, { method: "POST", headers: { cookie } });
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, any>;
      expect(body.error.code).toBe("AI_NOT_CONFIGURED");
    } finally {
      await new Promise<void>((resolve) => isolated.close(() => resolve()));
    }
  });
});