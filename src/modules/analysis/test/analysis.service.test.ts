import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAnalysisService, type AnalysisService } from "../analysis.service";
import type { LlmClient } from "../llm/analysis.llm.client";
import {
  createTestPrisma,
  provisionTestDb,
  seedTestDb,
} from "../../../testing/analysisTestDb";

const prisma = createTestPrisma();
const FIXTURE_METERS = ["M-PZ1", "M-PZ2", "M-PZ3", "M-PZ4"];

/**
 * Fake LLM (design D8): deterministic Spanish outputs, no network. The fixture
 * meters mirror the four ground-truth shapes so the runner exercises the full
 * 3-stage pipeline against the isolated test database.
 */
function createFakeLlm(overrides?: Partial<LlmClient>): LlmClient {
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
    ...overrides,
  };
}

let service: AnalysisService;
const createdRunIds: string[] = [];

beforeAll(async () => {
  await provisionTestDb();
  await seedTestDb(prisma);

  // Fixture meters mirroring the four ground-truth shapes on isolated codes.
  const meters = await prisma.$transaction(
    FIXTURE_METERS.map((code, index) =>
      prisma.meter.create({
        data: { meterId: code, name: `Pipeline ${code}`, location: `Site ${80 + index}` },
      }),
    ),
  );
  const meterByCode = new Map(meters.map((m) => [m.meterId, m.id]));

  const readings = [];
  for (const code of FIXTURE_METERS) {
    const meterId = meterByCode.get(code)!;
    for (let day = 0; day < 14; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const ts = new Date(Date.UTC(2026, 8, 1 + day, hour, 0, 0));
        const noise = hour % 2 === 0 ? 1 : -1;
        let c = 50 + noise; // baseline 50
        if (code === "M-PZ1") {
          // REAL_ANOMALY-like: spike from day 11 (09-12) 14:00 sustained.
          if (day >= 11 && hour >= 14) c = 110;
        } else if (code === "M-PZ2") {
          // EXPLAINABLE-like: step to 71 from day 10 (09-11).
          if (day >= 10) c = 71 + noise;
        } else if (code === "M-PZ3") {
          // FALSE_POSITIVE-like: 12h drop on day 7 (09-08) then recovery.
          if (day === 7 && hour < 12) c = 10;
        } else {
          // DATA_QUALITY-like: stable consumption, wild voltage/pf on day 12-13.
          c = 27.6;
        }
        readings.push({
          meterId,
          timestamp: ts,
          consumptionKwh: c,
          voltageV: code === "M-PZ4" && day >= 12 ? 220 + (hour % 2 === 0 ? 10 : -10) : 220,
          currentA: c * 0.5,
          powerFactor:
            code === "M-PZ4" && day >= 12 ? 0.95 + (hour % 2 === 0 ? 0.13 : -0.13) : 0.95,
          status: "ok",
        });
      }
    }
  }
  await prisma.reading.createMany({ data: readings });

  // Events for coverage classification.
  await prisma.event.createMany({
    data: [
      {
        meterId: meterByCode.get("M-PZ1")!,
        eventTimestamp: new Date("2026-09-12T14:00:00.000Z"),
        eventType: "UNKNOWN",
        description: "Sin evento registrado",
      },
      {
        meterId: meterByCode.get("M-PZ2")!,
        eventTimestamp: new Date("2026-09-11T00:00:00.000Z"),
        eventType: "OPERATIONAL_CHANGE",
        description: "Nueva línea de producción",
      },
      {
        meterId: meterByCode.get("M-PZ3")!,
        eventTimestamp: new Date("2026-09-08T00:00:00.000Z"),
        eventType: "SCHEDULED_OUTAGE",
        description: "Mantenimiento programado",
      },
      {
        meterId: meterByCode.get("M-PZ4")!,
        eventTimestamp: new Date("2026-09-13T00:00:00.000Z"),
        eventType: "DATA_QUALITY",
        description: "Lecturas intermitentes",
      },
    ],
  });

  service = createAnalysisService(prisma, createFakeLlm(), {
    AI_API_KEY: "test-key",
    AI_BASE_URL: "https://fake/v1",
    AI_MODEL: "test",
  });
});

afterAll(async () => {
  await prisma.anomaly.deleteMany({ where: { meter: { meterId: { in: FIXTURE_METERS } } } });
  await prisma.event.deleteMany({ where: { meter: { meterId: { in: FIXTURE_METERS } } } });
  await prisma.reading.deleteMany({ where: { meter: { meterId: { in: FIXTURE_METERS } } } });
  if (createdRunIds.length > 0) {
    await prisma.analysisRun.deleteMany({ where: { id: { in: createdRunIds } } });
  }
  await prisma.meter.deleteMany({ where: { meterId: { in: FIXTURE_METERS } } });
  await prisma.$disconnect();
});

describe("runAnalysis pipeline", () => {
  test("creates one consolidated anomaly per affected meter with correct classification", async () => {
    // Create the RUNNING run directly (start() would also fire a detached
    // runner that races this explicit runAnalysis in tests).
    const run = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    createdRunIds.push(run.id);

    await service.runAnalysis(run.id, { meterCodes: FIXTURE_METERS });

    const completed = await prisma.analysisRun.findUnique({ where: { id: run.id } });
    expect(completed!.status).toBe("COMPLETED");
    expect(completed!.llmUsed).toBe(true);
    expect(completed!.lockToken).toBeNull();

    const anomalies = await prisma.anomaly.findMany({
      where: { analysisRunId: run.id },
      include: { meter: true, relatedEvent: true },
    });
    expect(anomalies).toHaveLength(4);

    const byMeter = new Map(anomalies.map((a) => [a.meter!.meterId, a]));
    expect(byMeter.get("M-PZ1")!.type).toBe("REAL_ANOMALY");
    expect(byMeter.get("M-PZ1")!.severity).toBe("HIGH");
    expect(byMeter.get("M-PZ1")!.detectionType).toContain("SPIKE");
    expect(byMeter.get("M-PZ1")!.relatedEvent?.eventType).toBe("UNKNOWN");

    expect(byMeter.get("M-PZ2")!.type).toBe("EXPLAINABLE_ANOMALY");
    expect(byMeter.get("M-PZ2")!.severity).toBe("MEDIUM");
    expect(byMeter.get("M-PZ2")!.rangeStart.toISOString()).toBe("2026-09-11T00:00:00.000Z");
    expect(byMeter.get("M-PZ2")!.relatedEvent?.eventType).toBe("OPERATIONAL_CHANGE");

    expect(byMeter.get("M-PZ3")!.type).toBe("FALSE_POSITIVE");
    expect(byMeter.get("M-PZ3")!.severity).toBe("LOW");
    expect(byMeter.get("M-PZ3")!.rangeStart.toISOString()).toBe("2026-09-08T00:00:00.000Z");
    expect(byMeter.get("M-PZ3")!.relatedEvent?.eventType).toBe("SCHEDULED_OUTAGE");

    expect(byMeter.get("M-PZ4")!.type).toBe("DATA_QUALITY");
    expect(byMeter.get("M-PZ4")!.severity).toBe("HIGH");
    expect(byMeter.get("M-PZ4")!.relatedEvent?.eventType).toBe("DATA_QUALITY");

    // Spanish explanation persisted for every confirmed anomaly.
    for (const anomaly of anomalies) {
      expect(anomaly.reason).toContain("anómalo");
      expect(anomaly.recommendedAction).toContain("medidor");
    }
  });

  test("marks the run FAILED and clears the lock when the LLM fails (no degrade)", async () => {
    const failing = createAnalysisService(
      prisma,
      createFakeLlm({
        async explain() {
          throw new Error("provider 500");
        },
      }),
      { AI_API_KEY: "test-key", AI_BASE_URL: "https://fake/v1", AI_MODEL: "test" },
    );
    const run = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    createdRunIds.push(run.id);
    await failing.runAnalysis(run.id, { meterCodes: FIXTURE_METERS });

    const after = await prisma.analysisRun.findUnique({ where: { id: run.id } });
    expect(after!.status).toBe("FAILED");
    expect(after!.llmUsed).toBe(false);
    expect(after!.lockToken).toBeNull();
    expect(after!.summary).toContain("provider 500");

    const anomalies = await prisma.anomaly.count({ where: { analysisRunId: run.id } });
    expect(anomalies).toBe(0);
  });

  test("getStatus returns status, summary and anomaly count", async () => {
    const run = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    createdRunIds.push(run.id);
    await service.runAnalysis(run.id, { meterCodes: FIXTURE_METERS });
    const status = await service.getStatus(run.id);
    expect(status.status).toBe("COMPLETED");
    expect(status.anomaly_count).toBe(4);
    expect(typeof status.summary).toBe("string");
  });

  test("getStatus throws 404 NOT_FOUND for an unknown run", async () => {
    await expect(service.getStatus("cuid_nonexistent")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  test("borderline |z| in [2.5, 3) routes to the LLM classifier (synthetic fixture)", async () => {
    // A persistent step whose readings land in the borderline band: baseline
    // mean 100 with std 8 (alternating 108/92), then a +22% step to ~122
    // → maxZ ≈ 2.75 ∈ [2.5, 3). No covering event → classify via LLM.
    const meter = await prisma.meter.create({
      data: { meterId: "M-PZ5", name: "Pipeline Borderline", location: "Site 85" },
    });
    const readings = [];
    for (let day = 0; day < 14; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const stepped = day >= 7;
        const c = stepped ? (hour % 2 === 0 ? 123 : 121) : hour % 2 === 0 ? 108 : 92;
        readings.push({
          meterId: meter.id,
          timestamp: new Date(Date.UTC(2026, 8, 1 + day, hour, 0, 0)),
          consumptionKwh: c,
          voltageV: 220,
          currentA: c * 0.5,
          powerFactor: 0.95,
          status: "ok",
        });
      }
    }
    await prisma.reading.createMany({ data: readings });

    // Fake LLM records classify calls and returns a distinct classification.
    let classifyCalls = 0;
    const llm = createFakeLlm({
      async classify() {
        classifyCalls++;
        return {
          type: "EXPLAINABLE_ANOMALY",
          severity: "MEDIUM",
          reason: "Caso límite: cambio moderado sostenido clasificado por el modelo.",
          recommended_action: "Monitorear durante 48 horas.",
        };
      },
    });
    const borderlineService = createAnalysisService(prisma, llm, {
      AI_API_KEY: "test-key",
      AI_BASE_URL: "https://fake/v1",
      AI_MODEL: "test",
    });
    const run = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    createdRunIds.push(run.id);
    await borderlineService.runAnalysis(run.id, { meterCodes: ["M-PZ5"] });

    expect(classifyCalls).toBe(1);
    const anomaly = await prisma.anomaly.findFirst({ where: { analysisRunId: run.id } });
    expect(anomaly).not.toBeNull();
    // The LLM decided the classification (distinct from the rule-based default).
    expect(anomaly!.type).toBe("EXPLAINABLE_ANOMALY");
    expect(anomaly!.severity).toBe("MEDIUM");
    expect(anomaly!.reason).toContain("Caso límite");

    await prisma.anomaly.deleteMany({ where: { analysisRunId: run.id } });
    await prisma.reading.deleteMany({ where: { meterId: meter.id } });
    await prisma.meter.delete({ where: { id: meter.id } });
  });
});