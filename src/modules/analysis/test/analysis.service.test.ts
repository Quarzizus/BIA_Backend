import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAnalysisService, type AnalysisService } from "../analysis.service";
import type { LlmClient } from "../llm/analysis.llm.client";
import {
  createTestPrisma,
  provisionTestDb,
  seedTestDb,
} from "../../../testing/testDb";

const prisma = createTestPrisma("bia_test_analysis");
const FIXTURE_METERS = ["M-PZ1", "M-PZ2", "M-PZ3", "M-PZ4"];

/**
 * LLM falso (diseño D8): salidas deterministas en español, sin red. Los meters
 * del fixture reflejan las cuatro formas ground-truth para que el runner
 * ejercite el pipeline completo de 3 etapas contra la base de test aislada.
 * Devuelve las 4 explicaciones (técnica + simple), como el contrato dual.
 */
function createFakeLlm(overrides?: Partial<LlmClient>): LlmClient {
  return {
    async classify() {
      return {
        type: "REAL_ANOMALY",
        severity: "HIGH",
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
    ...overrides,
  };
}

let service: AnalysisService;
const createdRunIds: string[] = [];

beforeAll(async () => {
  await provisionTestDb("bia_test_analysis");
  await seedTestDb(prisma);

  // Meters del fixture que reflejan las cuatro formas ground-truth sobre códigos aislados.
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
        let c = 50 + noise;
        if (code === "M-PZ1") {
          // Estilo REAL_ANOMALY: spike desde el día 11 (09-12) 14:00 sostenido.
          if (day >= 11 && hour >= 14) c = 110;
        } else if (code === "M-PZ2") {
          // Estilo EXPLAINABLE: paso a 71 desde el día 10 (09-11).
          if (day >= 10) c = 71 + noise;
        } else if (code === "M-PZ3") {
          // Estilo FALSE_POSITIVE: caída de 12h el día 7 (09-08) y luego recuperación.
          if (day === 7 && hour < 12) c = 10;
        } else {
          // Estilo DATA_QUALITY: consumo estable, voltaje/pf salvajes en los días 12-13.
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

  // Eventos para la clasificación por cobertura.
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
    // Se crea el run RUNNING directamente (start() también dispararía un runner
    // desacoplado que competiría con este runAnalysis explícito en los tests).
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

    // Explicación en español persistida para cada anomalía confirmada: tanto la
    // versión técnica como la simple (contrato dual de 4 campos).
    for (const anomaly of anomalies) {
      expect(anomaly.reason).toContain("anómalo");
      expect(anomaly.recommendedAction).toContain("medidor");
      expect(anomaly.reasonSimple).toContain("consumo");
      expect(anomaly.recommendedActionSimple).toContain("medidor");
    }
  });

  test("completes the run with rule-based fallback explanations when the LLM fails", async () => {
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
    // El run COMPLETA con llm_used=false: el fallback por reglas preserva el resultado.
    expect(after!.status).toBe("COMPLETED");
    expect(after!.llmUsed).toBe(false);
    expect(after!.lockToken).toBeNull();
    expect(after!.summary).toContain("Detected 4");

    const anomalies = await prisma.anomaly.findMany({
      where: { analysisRunId: run.id },
      include: { meter: true },
    });
    expect(anomalies).toHaveLength(4);
    // Cada anomalía conserva su clasificación determinista con explicación por reglas
    // siguiendo el mismo contrato de formato que el LLM: reason en 2 párrafos
    // separados por línea en blanco y recommended_action con bullets "- ".
    // El fallback también genera la versión simple (contrato dual).
    for (const anomaly of anomalies) {
      expect(anomaly.reason).toContain("por reglas");
      expect(anomaly.reason).toContain(anomaly.type);
      expect(anomaly.reason).toContain("\n\n");
      expect(anomaly.recommendedAction!.startsWith("- ")).toBe(true);
      expect(anomaly.recommendedAction!.length).toBeGreaterThan(0);
      expect(anomaly.reasonSimple).toContain("asistente automático");
      expect(anomaly.reasonSimple!.startsWith("El consumo")).toBe(true);
      expect(anomaly.recommendedActionSimple!.startsWith("- ")).toBe(true);
      expect(anomaly.recommendedActionSimple!.length).toBeGreaterThan(0);
    }
  });

  test("an LLM failure on ONE meter does not erase the other meters' findings", async () => {
    const partial = createAnalysisService(
      prisma,
      createFakeLlm({
        async explain(input) {
          if (input.meterId === "M-PZ1") throw new Error("timeout");
          return {
            reason: "Consumo anómalo detectado por el análisis estadístico.",
            recommended_action: "Revisar la instalación del medidor.",
            reason_simple:
              "El consumo subió de forma notoria. Algo se conectó o se dañó en la instalación.",
            recommended_action_simple:
              "Revisa la instalación del medidor. Llama a un electricista si persiste.",
          };
        },
      }),
      { AI_API_KEY: "test-key", AI_BASE_URL: "https://fake/v1", AI_MODEL: "test" },
    );
    const run = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    createdRunIds.push(run.id);
    await partial.runAnalysis(run.id, { meterCodes: FIXTURE_METERS });

    const after = await prisma.analysisRun.findUnique({ where: { id: run.id } });
    expect(after!.status).toBe("COMPLETED");
    // El resto de medidores sí usó el LLM, así que el run reporta llm_used=true.
    expect(after!.llmUsed).toBe(true);

    const anomalies = await prisma.anomaly.findMany({
      where: { analysisRunId: run.id },
      include: { meter: true },
    });
    expect(anomalies).toHaveLength(4);
    const byMeter = new Map(anomalies.map((a) => [a.meter!.meterId, a]));
    // El medidor con timeout usa el fallback por reglas; los demás conservan la explicación del LLM.
    expect(byMeter.get("M-PZ1")!.reason).toContain("por reglas");
    expect(byMeter.get("M-PZ1")!.reasonSimple).toContain("asistente automático");
    for (const code of ["M-PZ2", "M-PZ3", "M-PZ4"]) {
      expect(byMeter.get(code)!.reason).toContain("anómalo");
      expect(byMeter.get(code)!.reasonSimple).toContain("consumo");
    }
  });

  test("persisted anomalies from the LLM path are normalized (wall-of-text input)", async () => {
    // El LLM falso ignora el contrato de formato: reason en un muro de texto
    // sin párrafos y recommended_action numerada. El normalizador del servicio
    // debe garantizar el formato canónico ANTES de persistir.
    const wallOfText = createAnalysisService(
      prisma,
      createFakeLlm({
        async explain() {
          return {
            reason:
              "El consumo pasó de 43.7 a 92.8 kWh/h (+112.3%), con un pico de |z| 9.73 a las 14:00 del 12-sep. No hay evento que explique la señal: el medidor no registró mantenimiento ni cambios operativos. El impacto es alto: el consumo se duplicó y se mantiene elevado. Se recomienda inspeccionar el medidor y verificar la carga conectada.",
            recommended_action:
              "1) Inspeccionar el medidor y sus conexiones.\n2) Verificar la carga conectada al circuito.\n3) Revisar el historial de las últimas 48 horas.",
            reason_simple:
              "El medidor consume el doble de lo normal desde septiembre. Algo se conectó o se dañó en la instalación. Conviene llamar a un electricista.",
            recommended_action_simple:
              "1) Llama a un electricista.\n2) Verifica si se conectó un equipo nuevo.\n3) Pide revisar el medidor.\n4) Escala a mantenimiento.",
          };
        },
      }),
      { AI_API_KEY: "test-key", AI_BASE_URL: "https://fake/v1", AI_MODEL: "test" },
    );
    const run = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    createdRunIds.push(run.id);
    await wallOfText.runAnalysis(run.id, { meterCodes: ["M-PZ1"] });

    const anomalies = await prisma.anomaly.findMany({
      where: { analysisRunId: run.id },
      include: { meter: true },
    });
    expect(anomalies).toHaveLength(1);
    const anomaly = anomalies[0]!;

    // El muro de texto se normalizó a 2-3 párrafos separados por línea en
    // blanco, sin romper los decimales/porcentajes de la evidencia.
    const paragraphs = anomaly.reason!.split("\n\n");
    expect(paragraphs.length).toBeGreaterThanOrEqual(2);
    expect(paragraphs.length).toBeLessThanOrEqual(3);
    expect(anomaly.reason).toContain("43.7 a 92.8 kWh/h (+112.3%)");

    // La acción numerada se normalizó a bullets "- ", uno por línea.
    const actionLines = anomaly.recommendedAction!.split("\n");
    expect(actionLines.length).toBeGreaterThanOrEqual(2);
    expect(actionLines.length).toBeLessThanOrEqual(4);
    for (const line of actionLines) {
      expect(line.startsWith("- ")).toBe(true);
    }

    // La versión simple también se normalizó: 1-2 párrafos y máx. 3 bullets.
    const simpleParagraphs = anomaly.reasonSimple!.split("\n\n");
    expect(simpleParagraphs.length).toBeGreaterThanOrEqual(1);
    expect(simpleParagraphs.length).toBeLessThanOrEqual(2);
    const simpleActionLines = anomaly.recommendedActionSimple!.split("\n");
    expect(simpleActionLines.length).toBeLessThanOrEqual(3);
    for (const line of simpleActionLines) {
      expect(line.startsWith("- ")).toBe(true);
    }
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
    // Un paso persistente cuyas lecturas caen en la banda límite: media de
    // baseline 100 con std 8 (108/92 alternados), luego un paso de +22% a ~122
    // → maxZ ≈ 2.75 ∈ [2.5, 3). Sin evento de cobertura → clasifica vía LLM.
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

    // El LLM falso registra las llamadas a classify y devuelve una clasificación distinta.
    let classifyCalls = 0;
    const llm = createFakeLlm({
      async classify() {
        classifyCalls++;
        return {
          type: "EXPLAINABLE_ANOMALY",
          severity: "MEDIUM",
          reason: "Caso límite: cambio moderado sostenido clasificado por el modelo.",
          recommended_action: "Monitorear durante 48 horas.",
          reason_simple: "El consumo subió de forma notoria. Algo se conectó o se dañó en la instalación.",
          recommended_action_simple:
            "Revisa la instalación del medidor. Llama a un electricista si persiste.",
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
    // El LLM decidió la clasificación (distinta del default basado en reglas).
    expect(anomaly!.type).toBe("EXPLAINABLE_ANOMALY");
    expect(anomaly!.severity).toBe("MEDIUM");
    expect(anomaly!.reason).toContain("Caso límite");
    // La clasificación del LLM también persiste la versión simple.
    expect(anomaly!.reasonSimple).toContain("consumo");
    expect(anomaly!.recommendedActionSimple).toContain("medidor");

    await prisma.anomaly.deleteMany({ where: { analysisRunId: run.id } });
    await prisma.reading.deleteMany({ where: { meterId: meter.id } });
    await prisma.meter.delete({ where: { id: meter.id } });
  });

  test("a second run REFRESHES the same OPEN anomalies instead of duplicating them", async () => {
    // Upsert por (meter + type + status=OPEN): el segundo run sobre los mismos
    // hallazgos debe ACTUALIZAR las 4 filas, no crear 4 nuevas.
    const run1 = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    createdRunIds.push(run1.id);
    await service.runAnalysis(run1.id, { meterCodes: FIXTURE_METERS });

    const before = await prisma.anomaly.findMany({
      where: { meter: { meterId: { in: FIXTURE_METERS } } },
      include: { meter: true },
      orderBy: { meter: { meterId: "asc" } },
    });
    expect(before).toHaveLength(4);
    expect(before.every((a) => a.status === "OPEN")).toBe(true);
    const idsBefore = before.map((a) => a.id);

    // Segundo run con otro LLM: la explicación cambia → prueba que la fila se refrescó.
    const secondLlm = createFakeLlm({
      async explain() {
        return {
          reason: "Explicación renovada por el segundo análisis.",
          recommended_action: "Revisar la instalación del medidor.",
          reason_simple: "Explicación simple renovada por el segundo análisis.",
          recommended_action_simple: "Revisa la instalación del medidor. Llama a un electricista.",
        };
      },
    });
    const secondService = createAnalysisService(prisma, secondLlm, {
      AI_API_KEY: "test-key",
      AI_BASE_URL: "https://fake/v1",
      AI_MODEL: "test",
    });
    // Garantiza detectedAt estrictamente mayor que el del primer run.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const run2 = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    createdRunIds.push(run2.id);
    await secondService.runAnalysis(run2.id, { meterCodes: FIXTURE_METERS });

    const after = await prisma.anomaly.findMany({
      where: { meter: { meterId: { in: FIXTURE_METERS } } },
      include: { meter: true },
      orderBy: { meter: { meterId: "asc" } },
    });
    // N runs NO acumulan filas: total se mantiene en 4 (una por medidor).
    expect(after).toHaveLength(4);
    expect(after.map((a) => a.id)).toEqual(idsBefore);

    // Cada medidor conserva exactamente UNA anomalía OPEN (misma id, refrescada).
    const openByMeter = new Map<string, number>();
    for (const anomaly of after) {
      expect(anomaly.status).toBe("OPEN");
      const code = anomaly.meter!.meterId;
      openByMeter.set(code, (openByMeter.get(code) ?? 0) + 1);
    }
    expect(openByMeter.size).toBe(4);
    for (const count of openByMeter.values()) expect(count).toBe(1);

    // La fila se REFRESCÓ: analysisRunId del run actual, explicación nueva y detectedAt actualizado.
    const beforeByMeter = new Map(before.map((a) => [a.meter!.meterId, a]));
    for (const anomaly of after) {
      expect(anomaly.analysisRunId).toBe(run2.id);
      expect(anomaly.reason).toBe("Explicación renovada por el segundo análisis.");
      // Las versiones simples también se refrescan con el run actual.
      expect(anomaly.reasonSimple).toBe("Explicación simple renovada por el segundo análisis.");
      expect(anomaly.detectedAt.getTime()).toBeGreaterThan(
        beforeByMeter.get(anomaly.meter!.meterId)!.detectedAt.getTime(),
      );
    }

    // countAnomalies(run2) sigue reportando las 4 (creadas o refrescadas por el run).
    const status2 = await secondService.getStatus(run2.id);
    expect(status2.anomaly_count).toBe(4);
  });

  test("a RESOLVED anomaly is history: the next run creates a NEW row for that meter", async () => {
    // Baseline propio: un run garantiza 4 anomalías OPEN (una por medidor),
    // independiente del estado que dejen otros tests del archivo.
    const baselineRun = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    createdRunIds.push(baselineRun.id);
    await service.runAnalysis(baselineRun.id, { meterCodes: FIXTURE_METERS });

    // Se resuelve M-PZ1 → sale del set OPEN (queda como historial).
    const mPz1Open = await prisma.anomaly.findFirst({
      where: { meter: { meterId: "M-PZ1" }, status: "OPEN" },
    });
    expect(mPz1Open).not.toBeNull();
    const resolved = await prisma.anomaly.update({
      where: { id: mPz1Open!.id },
      data: { status: "RESOLVED" },
    });

    const run = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    createdRunIds.push(run.id);
    await service.runAnalysis(run.id, { meterCodes: FIXTURE_METERS });

    const anomalies = await prisma.anomaly.findMany({
      where: { meter: { meterId: { in: FIXTURE_METERS } } },
      include: { meter: true },
      orderBy: { meter: { meterId: "asc" } },
    });
    // 5 filas en total: 4 OPEN (3 refrescadas + 1 nueva de M-PZ1) + la RESOLVED de historial.
    expect(anomalies).toHaveLength(5);
    const open = anomalies.filter((a) => a.status === "OPEN");
    expect(open).toHaveLength(4);

    // M-PZ1: la RESOLVED sigue existiendo y el nuevo run creó una fila NUEVA (otra id).
    const mPz1Rows = anomalies.filter((a) => a.meter!.meterId === "M-PZ1");
    expect(mPz1Rows).toHaveLength(2);
    const resolvedRow = mPz1Rows.find((a) => a.status === "RESOLVED")!;
    const newOpenRow = mPz1Rows.find((a) => a.status === "OPEN")!;
    expect(resolvedRow.id).toBe(resolved.id);
    expect(newOpenRow.id).not.toBe(resolved.id);
    expect(newOpenRow.analysisRunId).toBe(run.id);

    // Los demás medidores refrescan su misma fila OPEN con el run actual.
    for (const code of ["M-PZ2", "M-PZ3", "M-PZ4"]) {
      const rows = anomalies.filter((a) => a.meter!.meterId === code);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("OPEN");
      expect(rows[0]!.analysisRunId).toBe(run.id);
    }

    const status = await service.getStatus(run.id);
    expect(status.anomaly_count).toBe(4);
  });
});