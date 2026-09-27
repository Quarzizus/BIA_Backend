import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAnalysisService, type AnalysisRunStatus, type AnalysisService } from "../analysis.service";
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
    ...overrides,
  };
}

let service: AnalysisService;
const createdRunIds: string[] = [];

/**
 * Limpia las anomalías OPEN del fixture: cada test que necesita un run "de
 * verdad" (LLM o fallback) parte con el caché de evidencia vacío. Las RESOLVED
 * quedan intactas (son historial y no entran en el set activo).
 */
async function clearOpenAnomalies(): Promise<void> {
  await prisma.anomaly.deleteMany({
    where: { meter: { meterId: { in: FIXTURE_METERS } }, status: "OPEN" },
  });
}

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
    // Caché de evidencia vacío: este run SÍ usa el LLM (llm_used=true).
    await clearOpenAnomalies();
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

  test("fallback texts are NOT cached: a recovered LLM re-explains on the next run (F2)", async () => {
    // Estado limpio: sin anomalías OPEN previas, el fallback se produce de verdad.
    await clearOpenAnomalies();

    const calls = { explain: 0 };
    // LLM contador que puede fallar o responder según `healthy`.
    const countingLlm = (healthy: boolean) =>
      createFakeLlm({
        async explain() {
          calls.explain++;
          if (!healthy) throw new Error("provider 500");
          return {
            reason: "Consumo anómalo detectado por el análisis estadístico.",
            recommended_action: "Revisar la instalación del medidor.",
            reason_simple:
              "El consumo subió de forma notoria. Algo se conectó o se dañó en la instalación.",
            recommended_action_simple:
              "Revisa la instalación del medidor. Llama a un electricista si persiste.",
          };
        },
      });
    const env = { AI_API_KEY: "test-key", AI_BASE_URL: "https://fake/v1", AI_MODEL: "test" };

    // Run 1: el LLM falla en los 4 medidores → explicaciones por reglas con
    // llmGenerated=false (los textos de fallback NUNCA entran a la caché).
    const run1 = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    createdRunIds.push(run1.id);
    const failing = createAnalysisService(prisma, countingLlm(false), env);
    await failing.runAnalysis(run1.id, { meterCodes: FIXTURE_METERS });
    expect(calls.explain).toBe(4);

    const after1 = await prisma.analysisRun.findUnique({ where: { id: run1.id } });
    expect(after1!.status).toBe("COMPLETED");
    expect(after1!.llmUsed).toBe(false);
    expect(after1!.summary).toContain("Detected 4");

    // Run 1 (fallback): 4 hallazgos creados por reglas → explanation_source "rules".
    const status1 = await failing.getStatus(run1.id);
    expect(status1.anomaly_count).toBe(4);
    expect(status1.new_anomalies).toBe(4);
    expect(status1.refreshed_anomalies).toBe(0);
    expect(status1.explanation_source).toBe("rules");
    expect(status1.llm_used).toBe(false);

    const anomalies1 = await prisma.anomaly.findMany({
      where: { meter: { meterId: { in: FIXTURE_METERS } } },
      include: { meter: true },
      orderBy: { meter: { meterId: "asc" } },
    });
    expect(anomalies1).toHaveLength(4);
    // Fallback persistido con origen por reglas: llmGenerated=false.
    expect(anomalies1.every((a) => a.llmGenerated === false)).toBe(true);
    for (const anomaly of anomalies1) {
      expect(anomaly.reason).toContain("por reglas");
      expect(anomaly.reasonSimple).toContain("asistente automático");
    }

    // Run 2 con el LLM SANO: la caché NO reutiliza los textos del fallback —
    // el LLM se vuelve a llamar para cada medidor (4 llamadas nuevas) y sus
    // textos reemplazan a los de reglas, con llmGenerated=true.
    const run2 = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    createdRunIds.push(run2.id);
    const healthy = createAnalysisService(prisma, countingLlm(true), env);
    await healthy.runAnalysis(run2.id, { meterCodes: FIXTURE_METERS });
    expect(calls.explain).toBe(8);

    const after2 = await prisma.analysisRun.findUnique({ where: { id: run2.id } });
    expect(after2!.status).toBe("COMPLETED");
    expect(after2!.llmUsed).toBe(true);

    const anomalies2 = await prisma.anomaly.findMany({
      where: { meter: { meterId: { in: FIXTURE_METERS } } },
      include: { meter: true },
      orderBy: { meter: { meterId: "asc" } },
    });
    expect(anomalies2).toHaveLength(4);
    expect(anomalies2.map((a) => a.id)).toEqual(anomalies1.map((a) => a.id));
    // Los textos del LLM reemplazaron a los de reglas y ahora son cacheables.
    for (const anomaly of anomalies2) {
      expect(anomaly.llmGenerated).toBe(true);
      expect(anomaly.reason).toContain("anómalo");
      expect(anomaly.reason).not.toContain("por reglas");
    }

    // F4+: el run 2 refrescó (no creó) las 4 filas con textos LLM frescos —
    // anomaly_count 4 (detectadas), new 0, refreshed 4, source "llm"; el
    // resumen distingue "0 new, 4 refreshed".
    const status2 = await healthy.getStatus(run2.id);
    expect(status2.anomaly_count).toBe(4);
    expect(status2.new_anomalies).toBe(0);
    expect(status2.refreshed_anomalies).toBe(4);
    expect(status2.explanation_source).toBe("llm");
    expect(status2.llm_used).toBe(true);
    expect(after2!.summary).toContain("0 new, 4 refreshed");
  });

  test("an LLM failure on ONE meter does not erase the other meters' findings", async () => {
    // Caché vacío: el run ejerce el LLM en los medidores sanos y el fallback en M-PZ1.
    await clearOpenAnomalies();
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
    // Caché vacío para M-PZ1: la fila previa (textos por reglas) no debe reutilizarse.
    await clearOpenAnomalies();
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

  test("getStatus returns status, summary, detected-anomaly counts and explanation source", async () => {
    // Caché limpio: el run CREA las 4 anomalías (anomaly_count = 4, new = 4).
    await clearOpenAnomalies();
    const run = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    createdRunIds.push(run.id);
    await service.runAnalysis(run.id, { meterCodes: FIXTURE_METERS });
    const status = await service.getStatus(run.id);
    expect(status.status).toBe("COMPLETED");
    expect(status.anomaly_count).toBe(4);
    expect(status.new_anomalies).toBe(4);
    expect(status.refreshed_anomalies).toBe(0);
    expect(status.explanation_source).toBe("llm");
    expect(status.llm_used).toBe(true);
    expect(typeof status.summary).toBe("string");
    // Run global sobre el fixture: readings_count = suma de las lecturas de
    // TODOS los medidores procesados (los 4 del fixture).
    const fixtureReadings = await prisma.reading.count({
      where: { meter: { meterId: { in: FIXTURE_METERS } } },
    });
    expect(status.readings_count).toBe(fixtureReadings);
  });

  test("getStatus exposes a null explanation source and zero counts while RUNNING", async () => {
    const run = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    createdRunIds.push(run.id);
    const status = await service.getStatus(run.id);
    expect(status.status).toBe("RUNNING");
    expect(status.anomaly_count).toBe(0);
    expect(status.new_anomalies).toBe(0);
    expect(status.refreshed_anomalies).toBe(0);
    expect(status.explanation_source).toBeNull();
    // Sin pipeline ejecutado aún → readings_count en su default (0).
    expect(status.readings_count).toBe(0);
    expect(status.completed_at).toBeNull();
    // El run queda RUNNING con lockToken='single': se elimina de inmediato para
    // NO bloquear la garantía de run único (P2002) de los demás tests.
    await prisma.analysisRun.delete({ where: { id: run.id } });
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

    // Evento near-miss (a ±6h del final del rango): el classify debe recibir los
    // eventos del medidor (F3) — son la razón de la ambigüedad del caso.
    await prisma.event.create({
      data: {
        meterId: meter.id,
        eventTimestamp: new Date("2026-09-15T00:00:00.000Z"),
        eventType: "OPERATIONAL_CHANGE",
        description: "Cambio operativo cercano al rango",
      },
    });

    // El LLM falso registra las llamadas a classify y devuelve una clasificación
    // distinta con su propia confianza (F5).
    let classifyCalls = 0;
    let classifyInput: Parameters<NonNullable<LlmClient["classify"]>>[0] | null = null;
    const llm = createFakeLlm({
      async classify(input) {
        classifyCalls++;
        classifyInput = input;
        return {
          type: "EXPLAINABLE_ANOMALY",
          severity: "MEDIUM",
          confidence: 0.65,
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
    // F3: el service pasa los eventos del medidor al clasificador del LLM.
    expect(classifyInput!.events).toEqual([
      { eventType: "OPERATIONAL_CHANGE", eventTimestamp: "2026-09-15T00:00:00.000Z" },
    ]);
    const anomaly = await prisma.anomaly.findFirst({ where: { analysisRunId: run.id } });
    expect(anomaly).not.toBeNull();
    // El LLM decidió la clasificación (distinta del default basado en reglas).
    expect(anomaly!.type).toBe("EXPLAINABLE_ANOMALY");
    expect(anomaly!.severity).toBe("MEDIUM");
    // F5: la confianza del LLM se persiste (0.65), no la fabricada por severidad.
    expect(anomaly!.confidence).toBe(0.65);
    expect(anomaly!.reason).toContain("Caso límite");
    // La clasificación del LLM también persiste la versión simple.
    expect(anomaly!.reasonSimple).toContain("consumo");
    expect(anomaly!.recommendedActionSimple).toContain("medidor");

    await prisma.anomaly.deleteMany({ where: { analysisRunId: run.id } });
    await prisma.event.deleteMany({ where: { meterId: meter.id } });
    await prisma.reading.deleteMany({ where: { meterId: meter.id } });
    await prisma.meter.delete({ where: { id: meter.id } });
  });

  test("cache hit on second run: same evidence reuses LLM texts with ZERO new calls", async () => {
    // Caché vacío: el run 1 ejerce el LLM (4 llamadas) y persiste sus textos.
    await clearOpenAnomalies();

    const calls = { classify: 0, explain: 0 };
    const countingLlm = createFakeLlm({
      async classify() {
        calls.classify++;
        return {
          type: "REAL_ANOMALY",
          severity: "HIGH",
          confidence: 0.9,
          reason: "Caso límite clasificado por el modelo.",
          recommended_action: "Revisar manualmente.",
          reason_simple: "El consumo subió de forma notoria.",
          recommended_action_simple: "Revisa la instalación del medidor.",
        };
      },
      async explain() {
        calls.explain++;
        return {
          reason: "Consumo anómalo detectado por el análisis estadístico.",
          recommended_action: "Revisar la instalación del medidor.",
          reason_simple: "El consumo subió de forma notoria. Algo se conectó o se dañó en la instalación.",
          recommended_action_simple:
            "Revisa la instalación del medidor. Llama a un electricista si persiste.",
        };
      },
    });
    const countingService = createAnalysisService(prisma, countingLlm, {
      AI_API_KEY: "test-key",
      AI_BASE_URL: "https://fake/v1",
      AI_MODEL: "test",
    });

    const run1 = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    createdRunIds.push(run1.id);
    await countingService.runAnalysis(run1.id, { meterCodes: FIXTURE_METERS });
    // Run 1: 4 llamadas al LLM (una explicación por medidor afectado).
    expect(calls.explain).toBe(4);
    expect(calls.classify).toBe(0);

    const before = await prisma.anomaly.findMany({
      where: { meter: { meterId: { in: FIXTURE_METERS } } },
      include: { meter: true },
      orderBy: { meter: { meterId: "asc" } },
    });
    expect(before).toHaveLength(4);
    expect(before.every((a) => a.status === "OPEN")).toBe(true);
    const idsBefore = before.map((a) => a.id);
    const reasonsBefore = before.map((a) => a.reason);

    // Garantiza detectedAt estrictamente mayor que el del primer run.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const run2 = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    createdRunIds.push(run2.id);
    await countingService.runAnalysis(run2.id, { meterCodes: FIXTURE_METERS });

    // Caché: el LLM NO se llamó en el run 2 (evidencia idéntica) → 0 llamadas nuevas.
    expect(calls.explain).toBe(4);
    expect(calls.classify).toBe(0);

    const after = await prisma.analysisRun.findUnique({ where: { id: run2.id } });
    expect(after!.status).toBe("COMPLETED");
    expect(after!.llmUsed).toBe(false);
    expect(after!.lockToken).toBeNull();

    const anomalies = await prisma.anomaly.findMany({
      where: { meter: { meterId: { in: FIXTURE_METERS } } },
      include: { meter: true },
      orderBy: { meter: { meterId: "asc" } },
    });
    // N runs NO acumulan filas: total se mantiene en 4 (una por medidor).
    expect(anomalies).toHaveLength(4);
    expect(anomalies.map((a) => a.id)).toEqual(idsBefore);

    // Cada medidor conserva exactamente UNA anomalía OPEN (misma id, refrescada).
    const openByMeter = new Map<string, number>();
    for (const anomaly of anomalies) {
      expect(anomaly.status).toBe("OPEN");
      const code = anomaly.meter!.meterId;
      openByMeter.set(code, (openByMeter.get(code) ?? 0) + 1);
    }
    expect(openByMeter.size).toBe(4);
    for (const count of openByMeter.values()) expect(count).toBe(1);

    // La fila se REFRESCÓ (detectedAt del run actual) pero los TEXTOS se
    // reutilizan del run 1: misma razón, misma evidencia. F4: el analysisRunId
    // NO se re-parenta — sigue apuntando al run que CREÓ la fila (run1).
    for (let i = 0; i < anomalies.length; i++) {
      expect(anomalies[i]!.analysisRunId).toBe(run1.id);
      expect(anomalies[i]!.reason).toBe(reasonsBefore[i]!);
      expect(anomalies[i]!.detectedAt.getTime()).toBeGreaterThan(
        before[i]!.detectedAt.getTime(),
      );
    }

    // F4+: anomaly_count = detectadas en el run 2 = 4 (0 creadas + 4 refrescadas,
    // todas con textos LLM reutilizados sin llamada) → explanation_source
    // "llm_cached"; el resumen distingue "0 new, 4 refreshed".
    const status2 = await countingService.getStatus(run2.id);
    expect(status2.anomaly_count).toBe(4);
    expect(status2.new_anomalies).toBe(0);
    expect(status2.refreshed_anomalies).toBe(4);
    expect(status2.explanation_source).toBe("llm_cached");
    expect(status2.llm_used).toBe(false);
    expect(after!.summary).toContain("0 new, 4 refreshed");
  });

  test("cache miss on changed evidence triggers a new LLM call only for the affected meter", async () => {
    await clearOpenAnomalies();

    let explainCalls = 0;
    const countingLlm = createFakeLlm({
      async explain() {
        explainCalls++;
        return {
          reason: "Consumo anómalo detectado por el análisis estadístico.",
          recommended_action: "Revisar la instalación del medidor.",
          reason_simple: "El consumo subió de forma notoria. Algo se conectó o se dañó en la instalación.",
          recommended_action_simple:
            "Revisa la instalación del medidor. Llama a un electricista si persiste.",
        };
      },
    });
    const countingService = createAnalysisService(prisma, countingLlm, {
      AI_API_KEY: "test-key",
      AI_BASE_URL: "https://fake/v1",
      AI_MODEL: "test",
    });

    const run1 = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    createdRunIds.push(run1.id);
    await countingService.runAnalysis(run1.id, { meterCodes: FIXTURE_METERS });
    expect(explainCalls).toBe(4);

    const before = await prisma.anomaly.findMany({
      where: { meter: { meterId: { in: FIXTURE_METERS } } },
      include: { meter: true },
      orderBy: { meter: { meterId: "asc" } },
    });
    expect(before).toHaveLength(4);
    const signalsBefore = new Map(before.map((a) => [a.meter!.meterId, JSON.stringify(a.signals)]));
    const mPz1Before = before.find((a) => a.meter!.meterId === "M-PZ1")!;

    // Cambia la evidencia de M-PZ1: un día extra de spike MÁS severo (150 vs 110)
    // → recent_mean/max_z cambian → el fingerprint signals deja de coincidir.
    const mPz1 = await prisma.meter.findFirst({ where: { meterId: "M-PZ1" } });
    const extraReadings = [];
    for (let hour = 0; hour < 24; hour++) {
      extraReadings.push({
        meterId: mPz1!.id,
        timestamp: new Date(Date.UTC(2026, 8, 15, hour, 0, 0)),
        consumptionKwh: 150,
        voltageV: 220,
        currentA: 75,
        powerFactor: 0.95,
        status: "ok",
      });
    }
    await prisma.reading.createMany({ data: extraReadings });

    const run2 = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    createdRunIds.push(run2.id);
    await countingService.runAnalysis(run2.id, { meterCodes: FIXTURE_METERS });

    // Solo M-PZ1 falló el caché (su signals cambió): UNA llamada nueva al LLM.
    expect(explainCalls).toBe(5);

    const after = await prisma.analysisRun.findUnique({ where: { id: run2.id } });
    expect(after!.status).toBe("COMPLETED");
    expect(after!.llmUsed).toBe(true);

    const anomalies = await prisma.anomaly.findMany({
      where: { meter: { meterId: { in: FIXTURE_METERS } } },
      include: { meter: true },
      orderBy: { meter: { meterId: "asc" } },
    });
    expect(anomalies).toHaveLength(4);
    const byMeter = new Map(anomalies.map((a) => [a.meter!.meterId, a]));

    // M-PZ1: nueva evidencia persistida (spike más severo, rango extendido).
    const mPz1After = byMeter.get("M-PZ1")!;
    expect(JSON.stringify(mPz1After.signals)).not.toBe(signalsBefore.get("M-PZ1"));
    expect(mPz1After.rangeEnd.toISOString()).toBe("2026-09-15T23:00:00.000Z");
    const recentBefore = (
      mPz1Before.signals as { per_variable: Record<string, { recent_mean: number }> }
    ).per_variable.consumption_kwh!.recent_mean;
    const recentAfter = (
      mPz1After.signals as { per_variable: Record<string, { recent_mean: number }> }
    ).per_variable.consumption_kwh!.recent_mean;
    expect(recentAfter).toBeGreaterThan(recentBefore);

    // Los demás medidores acertaron el caché: misma evidencia y mismos textos.
    for (const code of ["M-PZ2", "M-PZ3", "M-PZ4"]) {
      expect(JSON.stringify(byMeter.get(code)!.signals)).toBe(signalsBefore.get(code)!);
      expect(byMeter.get(code)!.reason).toBe("Consumo anómalo detectado por el análisis estadístico.");
    }
  });

  test("a RESOLVED anomaly is history: the next run creates a NEW row for that meter", async () => {
    // Caché limpio: el baselineRun CREA las 4 anomalías (con F4, un run sin
    // caché vacío solo refrescaría filas de tests anteriores y el análisis de
    // analysisRunId de abajo no sería determinista).
    await clearOpenAnomalies();
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

    // Los demás medidores refrescan su misma fila OPEN — F4: el analysisRunId
    // conserva el run que la CREÓ (baselineRun), no el run de refresco.
    for (const code of ["M-PZ2", "M-PZ3", "M-PZ4"]) {
      const rows = anomalies.filter((a) => a.meter!.meterId === code);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("OPEN");
      expect(rows[0]!.analysisRunId).toBe(baselineRun.id);
    }

    // F4+: anomaly_count = detectadas en el run = 4 (1 creada nueva para M-PZ1
    // + 3 refrescadas). M-PZ1 falló el caché (la RESOLVED es historial) → el
    // LLM se llamó → explanation_source "llm".
    const status = await service.getStatus(run.id);
    expect(status.anomaly_count).toBe(4);
    expect(status.new_anomalies).toBe(1);
    expect(status.refreshed_anomalies).toBe(3);
    expect(status.explanation_source).toBe("llm");
    expect(status.llm_used).toBe(true);
  });

  test("meter status stays CRITICAL when a run produces MEDIUM while an OPEN HIGH anomaly is active (F1)", async () => {
    // Estado limpio: sin anomalías OPEN del fixture.
    await clearOpenAnomalies();
    const mPz2 = await prisma.meter.findFirst({ where: { meterId: "M-PZ2" } });
    expect(mPz2).not.toBeNull();

    // HIGH pre-existente (tipo distinto) en el medidor que este run clasifica
    // como MEDIUM (EXPLAINABLE_ANOMALY por el evento OPERATIONAL_CHANGE).
    const extraRun = await prisma.analysisRun.create({
      data: { status: "COMPLETED", summary: "F1 fixture" },
    });
    createdRunIds.push(extraRun.id);
    await prisma.anomaly.create({
      data: {
        meterId: mPz2!.id,
        analysisRunId: extraRun.id,
        type: "REAL_ANOMALY",
        severity: "HIGH",
        confidence: 0.99,
        status: "OPEN",
        rangeStart: new Date("2026-09-10T00:00:00.000Z"),
        rangeEnd: new Date("2026-09-11T00:00:00.000Z"),
        detectionType: "SPIKE",
        signals: {},
        reason: "HIGH previa aún activa",
      },
    });

    const run = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    createdRunIds.push(run.id);
    await service.runAnalysis(run.id, { meterCodes: ["M-PZ2"] });

    // F1: el recompute agrega TODAS las severidades activas del medidor
    // ([HIGH, MEDIUM]) → CRITICAL; antes solo miraba la del run ([MEDIUM] → ALERT).
    const meter = await prisma.meter.findUnique({ where: { id: mPz2!.id } });
    expect(meter!.status).toBe("CRITICAL");
  });

  test("a meter with an unexpected pipeline error is reported in the run summary (F6)", async () => {
    await clearOpenAnomalies();
    // LLM que viola el contrato solo para M-PZ1: reason undefined → el
    // normalizador lanza un error inesperado que el catch defensivo captura.
    const broken = createAnalysisService(
      prisma,
      createFakeLlm({
        async explain(input) {
          if (input.meterId === "M-PZ1") {
            return {
              reason: undefined as unknown as string,
              recommended_action: "Revisar.",
              reason_simple: "Revisar.",
              recommended_action_simple: "Revisar.",
            } as never;
          }
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
    await broken.runAnalysis(run.id, { meterCodes: FIXTURE_METERS });

    // El run COMPLETA y el resumen menciona el medidor que falló (F6).
    const after = await prisma.analysisRun.findUnique({ where: { id: run.id } });
    expect(after!.status).toBe("COMPLETED");
    expect(after!.summary).toContain("1 meter failed");
    expect(after!.summary).toContain("Detected 3");

    // Los hallazgos de los demás medidores se persisten igual.
    const anomalies = await prisma.anomaly.findMany({
      where: { analysisRunId: run.id },
      include: { meter: true },
    });
    expect(anomalies).toHaveLength(3);
    const codes = anomalies.map((a) => a.meter!.meterId).sort();
    expect(codes).toEqual(["M-PZ2", "M-PZ3", "M-PZ4"]);
  });

  test("a config override changes detection thresholds (F7)", async () => {
    // Medidor sintético: baseline 100±10 (110/90 alternado), luego un paso
    // suave a 115/85 (|z| 1.5) — invisible con zThreshold 3, detectable con 1.
    const meter = await prisma.meter.create({
      data: { meterId: "M-PZ9", name: "Pipeline Config", location: "Site 89" },
    });
    const readings = [];
    for (let day = 0; day < 14; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const stepped = day >= 7;
        const c = stepped ? (hour % 2 === 0 ? 115 : 85) : hour % 2 === 0 ? 110 : 90;
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
    const env = { AI_API_KEY: "test-key", AI_BASE_URL: "https://fake/v1", AI_MODEL: "test" };

    // Default (zThreshold 3): sin anomalía.
    const runDefault = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    createdRunIds.push(runDefault.id);
    await service.runAnalysis(runDefault.id, { meterCodes: ["M-PZ9"] });
    expect(await prisma.anomaly.count({ where: { meterId: meter.id } })).toBe(0);

    // Override zThreshold 1: el spike suave se detecta y se persiste.
    const tuned = createAnalysisService(prisma, createFakeLlm(), env, { zThreshold: 1 });
    const runTuned = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    createdRunIds.push(runTuned.id);
    await tuned.runAnalysis(runTuned.id, { meterCodes: ["M-PZ9"] });
    expect(await prisma.anomaly.count({ where: { meterId: meter.id } })).toBe(1);

    await prisma.anomaly.deleteMany({ where: { meterId: meter.id } });
    await prisma.reading.deleteMany({ where: { meterId: meter.id } });
    await prisma.meter.delete({ where: { id: meter.id } });
  });
});

describe("start({ meterCodes }) — análisis por medidor", () => {
  /** Espera a que el run async (disparado por start) complete. */
  async function waitCompleted(runId: string): Promise<AnalysisRunStatus> {
    for (let i = 0; i < 50; i++) {
      const status = await service.getStatus(runId);
      if (status.status === "COMPLETED" || status.status === "FAILED") return status;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("run did not complete in time");
  }

  test("con meterCodes el run solo produce anomalías de ESE medidor", async () => {
    await clearOpenAnomalies();
    const { id } = await service.start({ meterCodes: ["M-PZ1"] });
    createdRunIds.push(id);

    const status = await waitCompleted(id);
    expect(status.anomaly_count).toBe(1);
    expect(status.new_anomalies).toBe(1);
    expect(status.refreshed_anomalies).toBe(0);
    expect(status.summary).toContain("1 meter(s)");
    expect(status.meter_id).toBe("M-PZ1");
    // Run POR MEDIDOR: readings_count = solo las lecturas de M-PZ1 (fixture
    // base 14 días × 24 h = 336; el conteo se toma de la base por robustez
    // frente al orden de los tests).
    const mPz1Readings = await prisma.reading.count({
      where: { meter: { meterId: "M-PZ1" } },
    });
    expect(status.readings_count).toBe(mPz1Readings);

    const rows = await prisma.anomaly.findMany({
      where: { analysisRunId: id },
      include: { meter: { select: { meterId: true } } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meter!.meterId).toBe("M-PZ1");
  });

  test("meterCodes con un medidor inexistente → 404 antes de crear el run", async () => {
    await expect(service.start({ meterCodes: ["M-NOPE"] })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });
});
describe("explain recibe el evento relacionado (prompt con contexto)", () => {
  test("un FALSE_POSITIVE por mantenimiento pasa el evento al LLM", async () => {
    await clearOpenAnomalies();
    let captured: any = null;
    const capturing = createAnalysisService(
      prisma,
      createFakeLlm({
        async explain(input: any) {
          captured = input;
          return {
            reason: "Caída por mantenimiento programado.",
            recommended_action: "No requiere acción.",
            reason_simple: "Fue una parada prevista.",
            recommended_action_simple: "No hacer nada.",
          };
        },
      }),
      { AI_API_KEY: "test-key", AI_BASE_URL: "https://fake/v1", AI_MODEL: "test" },
    );
    const run = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    createdRunIds.push(run.id);
    await capturing.runAnalysis(run.id, { meterCodes: ["M-PZ3"] });

    expect(captured).not.toBeNull();
    expect(captured.related_event).not.toBeNull();
    expect(captured.related_event.event_type).toBe("SCHEDULED_OUTAGE");
    expect(captured.related_event.description).toBe("Mantenimiento programado");
    await prisma.anomaly.deleteMany({ where: { meter: { meterId: "M-PZ3" }, status: "OPEN" } });
  });
});
