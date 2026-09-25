import type { Meter, PrismaClient, Reading } from "../../generated/prisma/client";
import { ApiError } from "../../shared/errors";
import type { LlmEnv } from "../../shared/domain/llm";
import {
  actionSimpleWasTruncated,
  actionWasTruncated,
  normalizeAction,
  normalizeActionSimple,
  normalizeReason,
  normalizeReasonSimple,
  reasonSimpleWasTruncated,
  reasonWasTruncated,
} from "../../shared/domain/llm-format";
import { logger } from "../../shared/logger";
import { computeBaseline } from "./stages/analysis.baseline.calculator";
import { classifyAnomaly, coveringEvent, type MeterEvent } from "./stages/analysis.classifier";
import { consolidateDetections, detectMeter } from "./stages/analysis.detector";
import {
  DEFAULT_ANALYSIS_CONFIG,
  FALLBACK_ACTION,
  FALLBACK_ACTION_SIMPLE,
  FALLBACK_REASON,
  FALLBACK_REASON_SIMPLE,
  LLM_CONCURRENCY,
  SEVERITY_CONFIDENCE,
  type AnalysisConfig,
} from "./analysis.domain";
import type { LlmClient } from "./llm/analysis.llm.client";
import {
  createAnalysisRepository,
  type AnalysisFinding,
  type AnalysisRepository,
} from "./analysis.repository";

/**
 * Orquestación del análisis (tasks 3.7/3.8):
 *  - start(): crea un AnalysisRun RUNNING con lockToken='single'
 *    (P2002 → 409 ANALYSIS_IN_PROGRESS) y lanza el runner desacoplado.
 *  - runAnalysis(): ejecuta el pipeline de 3 etapas sobre cada medidor con
 *    concurrencia acotada (LLM_CONCURRENCY) y persiste UNA anomalía consolidada
 *    por medidor afectado + el status de medidor recalculado en una sola
 *    transacción. Si una anomalía OPEN previa tiene la MISMA evidencia
 *    (detectionType + signals) y su texto proviene del LLM (llmGenerated=true),
 *    se reutilizan sus explicaciones y NO se llama al LLM (llm_used=false):
 *    re-runs sobre datos sin cambios son casi instantáneos. Los textos de
 *    fallback por reglas NUNCA se cachean (F2): un LLM recuperado vuelve a
 *    explicar. Fallback por reglas POR MEDIDOR si el LLM falla (explicación en
 *    español, llmGenerated=false para esa fila): un timeout en un medidor no
 *    borra los hallazgos del resto.
 *  - getStatus(): contrato de polling para GET /ai/analysis/:id. F4+:
 *    anomaly_count = anomalías DETECTADAS en el run (newCount + refreshedCount),
 *    con desglose new_anomalies/refreshed_anomalies y explanation_source
 *    ("llm" | "llm_cached" | "rules" | null). El refresh no re-parenta
 *    analysisRunId; el resumen distingue "(X new, Y refreshed)".
 *
 * Solo orquestación: toda la persistencia vive en analysis.repository, los
 * tipos/constantes de dominio puro en analysis.domain, y las reglas compartidas
 * en shared/domain.
 */

export type AnalysisDeps = LlmEnv;

/**
 * Origen de las explicaciones del run (contrato de status):
 *  - "llm": el LLM fue llamado y respondió en este run (clasificación/explicación).
 *  - "llm_cached": no hubo llamada al LLM; los textos se reutilizaron de
 *    anomalías OPEN previas originadas por el LLM con evidencia idéntica.
 *  - "rules": textos de fallback por reglas (proveedor caído o mixto sin LLM).
 *  - null: run RUNNING/FAILED o sin hallazgos.
 */
export type ExplanationSource = "llm" | "llm_cached" | "rules";

export interface AnalysisRunStatus {
  id: string;
  status: string;
  summary: string | null;
  /** Anomalías DETECTADAS en este run = nuevas + refrescadas (no solo creadas). */
  anomaly_count: number;
  /** Anomalías creadas nuevas por este run. */
  new_anomalies: number;
  /** Anomalías OPEN existentes refrescadas por este run. */
  refreshed_anomalies: number;
  /** Origen de las explicaciones (null mientras RUNNING/FAILED o sin hallazgos). */
  explanation_source: ExplanationSource | null;
  /** Alcance del run: código del medidor si fue por medidor (?meter_id=), null si global. */
  meter_id: string | null;
  /** Backward compat: true si el LLM fue llamado en este run (caché → false). */
  llm_used: boolean;
  started_at: string;
  completed_at: string | null;
}

export interface AnalysisService {
  start(options?: { meterCodes?: string[] }): Promise<{ id: string; status: string }>;
  runAnalysis(runId: string, options?: { meterCodes?: string[] }): Promise<void>;
  getStatus(runId: string): Promise<AnalysisRunStatus>;
}

export function createAnalysisService(
  prisma: PrismaClient,
  llm: LlmClient,
  env: AnalysisDeps,
  config: Partial<AnalysisConfig> = {},
): AnalysisService {
  // F7: los umbrales por defecto viven en DEFAULT_ANALYSIS_CONFIG; un override
  // parcial del caller solo cambia los que especifica.
  const resolvedConfig: AnalysisConfig = { ...DEFAULT_ANALYSIS_CONFIG, ...config };
  const repository: AnalysisRepository = createAnalysisRepository(prisma);

  const assertConfigured = () => {
    if (!env.AI_API_KEY || !env.AI_BASE_URL || !env.AI_MODEL) {
      throw new ApiError(
        503,
        "AI_NOT_CONFIGURED",
        "LLM is not configured: AI_API_KEY, AI_BASE_URL and AI_MODEL are required",
      );
    }
  };

  async function processMeter(
    meter: Meter,
    meterReadings: Reading[],
    events: MeterEvent[],
  ): Promise<{ finding: AnalysisFinding | null; llmUsed: boolean }> {
    if (meterReadings.length === 0) return { finding: null, llmUsed: false };

    const baseline = computeBaseline(meterReadings);
    if (baseline.consumption_kwh.mean === null) return { finding: null, llmUsed: false };

    const consolidated = consolidateDetections(
      detectMeter(meterReadings, baseline, resolvedConfig),
      meterReadings,
      baseline,
    );
    if (!consolidated) return { finding: null, llmUsed: false };

    const classification = classifyAnomaly(
      {
        detectionType: consolidated.detectionType,
        rangeStart: consolidated.rangeStart,
        rangeEnd: consolidated.rangeEnd,
        maxZ: consolidated.maxZ,
        events,
      },
      resolvedConfig,
    );

    let type = classification.type;
    let severity = classification.severity;
    // F5: por defecto la confianza de la clasificación POR REGLAS (no hay
    // confianza de un modelo); si el LLM clasifica, se usa su confidence.
    let confidence = SEVERITY_CONFIDENCE[severity];
    let reason: string;
    let recommendedAction: string;
    let reasonSimple: string;
    let recommendedActionSimple: string;
    let llmUsed = false;
    // F2: origen de los textos persistidos — true solo si vienen del LLM
    // (producidos este run o reutilizados de una fila LLM cacheada).
    let llmGenerated = false;

    // Caché de explicaciones: si una anomalía OPEN previa tiene la MISMA
    // evidencia (mismo detectionType + mismo signals) y su texto proviene del
    // LLM (llmGenerated=true), se reutilizan sus textos y NO se llama al LLM
    // (llm_used=false): re-runs sobre datos sin cambios son casi instantáneos.
    // El fingerprint ignora rangos/eventos a propósito: la evidencia persistida
    // es la que define la anomalía. Los textos de fallback por reglas NUNCA se
    // cachean (F2): un LLM recuperado vuelve a explicar el caso.
    const cached = await repository.findOpenMatchingEvidence(
      meter.id,
      consolidated.detectionType,
      consolidated.signals,
    );

    if (cached) {
      type = cached.type;
      severity = cached.severity;
      confidence = cached.confidence;
      reason = cached.reason;
      recommendedAction = cached.recommendedAction;
      reasonSimple = cached.reasonSimple;
      recommendedActionSimple = cached.recommendedActionSimple;
      llmGenerated = true;
    } else if (classification.needsLlm) {
      // Caso límite: el LLM clasifica la situación ambigua. Si el proveedor
      // falla, se conserva la clasificación determinista por reglas.
      try {
        const llmResult = await llm.classify({
          meterId: meter.meterId,
          detectionType: consolidated.detectionType,
          signals: consolidated.signals,
          rangeStart: consolidated.rangeStart.toISOString(),
          rangeEnd: consolidated.rangeEnd.toISOString(),
          // F3: los eventos del medidor viajan al clasificador — son la razón
          // de la ambigüedad del caso límite.
          events: events.map((event) => ({
            eventType: event.eventType,
            eventTimestamp: event.eventTimestamp.toISOString(),
          })),
        });
        type = llmResult.type;
        severity = llmResult.severity;
        confidence = llmResult.confidence;
        reason = llmResult.reason;
        recommendedAction = llmResult.recommended_action;
        reasonSimple = llmResult.reason_simple;
        recommendedActionSimple = llmResult.recommended_action_simple;
        llmUsed = true;
        llmGenerated = true;
      } catch (err) {
        logger.warn("LLM no disponible para clasificar; se usa la clasificación por reglas", {
          meterId: meter.meterId,
          error: err instanceof Error ? err.message : String(err),
        });
        reason = FALLBACK_REASON(
          type,
          consolidated.detectionType,
          consolidated.maxZ,
          consolidated.variationPct,
        );
        recommendedAction = FALLBACK_ACTION[type];
        reasonSimple = FALLBACK_REASON_SIMPLE(
          type,
          consolidated.detectionType,
          consolidated.maxZ,
          consolidated.variationPct,
        );
        recommendedActionSimple = FALLBACK_ACTION_SIMPLE[type];
      }
    } else {
      // Anomalía confirmada: el LLM genera la explicación en español. Si el
      // proveedor falla, se genera una explicación por reglas con la evidencia.
      try {
        const explanation = await llm.explain({
          meterId: meter.meterId,
          type,
          severity,
          detectionType: consolidated.detectionType,
          signals: consolidated.signals,
          rangeStart: consolidated.rangeStart.toISOString(),
          rangeEnd: consolidated.rangeEnd.toISOString(),
        });
        reason = explanation.reason;
        recommendedAction = explanation.recommended_action;
        reasonSimple = explanation.reason_simple;
        recommendedActionSimple = explanation.recommended_action_simple;
        llmUsed = true;
        llmGenerated = true;
      } catch (err) {
        logger.warn("LLM no disponible para explicar; se genera una explicación por reglas", {
          meterId: meter.meterId,
          error: err instanceof Error ? err.message : String(err),
        });
        reason = FALLBACK_REASON(
          type,
          consolidated.detectionType,
          consolidated.maxZ,
          consolidated.variationPct,
        );
        recommendedAction = FALLBACK_ACTION[type];
        reasonSimple = FALLBACK_REASON_SIMPLE(
          type,
          consolidated.detectionType,
          consolidated.maxZ,
          consolidated.variationPct,
        );
        recommendedActionSimple = FALLBACK_ACTION_SIMPLE[type];
      }
    }

    // Punto único de normalización: garantiza el contrato de formato para
    // TANTO la salida del LLM como el fallback por reglas (idempotente).
    const normalizedReason = normalizeReason(reason);
    const normalizedAction = normalizeAction(recommendedAction);
    const normalizedReasonSimple = normalizeReasonSimple(reasonSimple);
    const normalizedActionSimple = normalizeActionSimple(recommendedActionSimple);

    // F9: si el crudo excedía el tope del contrato y el normalizador descartó
    // contenido, se avisa con el contexto de la anomalía (observabilidad).
    if (
      reasonWasTruncated(reason, normalizedReason) ||
      reasonSimpleWasTruncated(reasonSimple, normalizedReasonSimple) ||
      actionWasTruncated(recommendedAction, normalizedAction) ||
      actionSimpleWasTruncated(recommendedActionSimple, normalizedActionSimple)
    ) {
      logger.warn("texto del LLM truncado por el normalizador de formato", {
        meterId: meter.meterId,
        detectionType: consolidated.detectionType,
        llmGenerated,
      });
    }

    // Evento relacionado: se reutiliza la regla de cobertura del clasificador
    // (fuente única de verdad) y se resuelve el evento persistido vía repository.
    const covering = coveringEvent({
      detectionType: consolidated.detectionType,
      rangeStart: consolidated.rangeStart,
      rangeEnd: consolidated.rangeEnd,
      maxZ: consolidated.maxZ,
      events,
    });
    const relatedEvent = covering
      ? await repository.findEvent(meter.id, covering.eventTimestamp, covering.eventType)
      : null;

    return {
      finding: {
        meterId: meter.id,
        detectionType: consolidated.detectionType,
        rangeStart: consolidated.rangeStart,
        rangeEnd: consolidated.rangeEnd,
        type,
        severity,
        confidence,
        signals: consolidated.signals,
        reason: normalizedReason,
        recommendedAction: normalizedAction,
        reasonSimple: normalizedReasonSimple,
        recommendedActionSimple: normalizedActionSimple,
        relatedEventId: relatedEvent?.id ?? null,
        llmUsed,
        llmGenerated,
      },
      llmUsed,
    };
  }

  async function runPipeline(runId: string, meterCodes?: string[]) {
    const { meters, readingsByMeter, eventsByMeter } = await repository.loadPipelineData();
    const selectedMeters = meterCodes
      ? meters.filter((meter) => meterCodes.includes(meter.meterId))
      : meters;

    const findings: AnalysisFinding[] = [];
    // F6: medidores que fallaron con un error inesperado (catch defensivo) —
    // se registran en el resumen del run para no silenciarlos.
    let failedMeters = 0;
    // Concurrencia acotada: el LLM es el cuello de botella (rate limits del
    // proveedor), así que los medidores se procesan en lotes de LLM_CONCURRENCY
    // con Promise.all. El orden de findings se conserva (lotes en orden, medidor
    // por medidor dentro del lote) y el persist sigue siendo atómico al final.
    for (let i = 0; i < selectedMeters.length; i += LLM_CONCURRENCY) {
      const batch = selectedMeters.slice(i, i + LLM_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (meter) => {
          try {
            return await processMeter(
              meter,
              readingsByMeter.get(meter.id) ?? [],
              eventsByMeter.get(meter.id) ?? [],
            );
          } catch (err) {
            // Defensivo: un fallo inesperado en un medidor no debe matar el run.
            failedMeters++;
            logger.warn("medidor omitido por error inesperado durante el análisis", {
              meterId: meter.meterId,
              error: err instanceof Error ? err.message : String(err),
            });
            return { finding: null, llmUsed: false };
          }
        }),
      );
      for (const result of results) {
        if (result.finding) findings.push(result.finding);
      }
    }

    // llm_used del run: true si CUALQUIER hallazgo usó el LLM en este run.
    const llmUsed = findings.some((finding) => finding.llmUsed);
    // explanation_source del run: "llm" si se llamó al LLM; si NO se llamó y
    // todos los textos provienen del LLM (reutilizados de un run previo con la
    // misma evidencia) → "llm_cached"; si hubo hallazgos pero alguno es fallback
    // por reglas → "rules"; sin hallazgos → null (no hay explicaciones que
    // reportar; "rules" sería engañoso).
    const explanationSource: ExplanationSource | null = (() => {
      if (findings.length === 0) return null;
      if (findings.some((finding) => finding.llmUsed)) return "llm";
      if (findings.every((finding) => finding.llmGenerated)) return "llm_cached";
      return "rules";
    })();
    let summary = `Detected ${findings.length} anomaly(ies) across ${new Set(findings.map((finding) => finding.meterId)).size} meter(s)`;
    // F6: los fallos por medidor se reflejan en el resumen (persistFindings
    // añade después "(X new, Y refreshed)").
    if (failedMeters > 0) {
      summary += `; ${failedMeters} meter${failedMeters === 1 ? "" : "s"} failed`;
    }
    await repository.persistFindings(runId, findings, summary, llmUsed, explanationSource);
  }

  return {
    async start(options: { meterCodes?: string[] } = {}) {
      assertConfigured();
      // Análisis por medidor: validar existencia antes de crear el run (404
      // claro en vez de un run que termina con 0 anomalías).
      if (options.meterCodes) {
        for (const code of options.meterCodes) {
          if (!(await repository.meterExistsByCode(code))) {
            throw new ApiError(404, "NOT_FOUND", `Meter ${code} not found`);
          }
        }
      }
      const run = await repository.createRun(
        options.meterCodes && options.meterCodes.length === 1 ? options.meterCodes[0] : undefined,
      );
      // Ejecución asíncrona desacoplada: responder 202 primero, luego correr el pipeline.
      void this.runAnalysis(run.id, options).catch((err) => {
        logger.error("analysis run crashed outside FAILED handler", {
          runId: run.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return { id: run.id, status: "RUNNING" };
    },

    async runAnalysis(runId: string, options: { meterCodes?: string[] } = {}): Promise<void> {
      const run = await repository.findRun(runId);
      if (!run || run.status !== "RUNNING") return;

      try {
        assertConfigured();
        await runPipeline(runId, options.meterCodes);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("analysis run failed", { runId, error: message });
        await repository.failRun(runId, message);
      }
    },

    async getStatus(runId: string): Promise<AnalysisRunStatus> {
      const run = await repository.findRun(runId);
      if (!run) {
        throw new ApiError(404, "NOT_FOUND", `Analysis run ${runId} not found`);
      }
      // F4+: anomaly_count = detectadas en ESTE run (nuevas + refrescadas), no
      // solo las creadas. Un re-run sobre datos idénticos reporta las 4 con
      // new_anomalies 0 y refreshed_anomalies 4 (antes reportaba 0).
      const anomalyCount = run.newCount + run.refreshedCount;
      return {
        id: run.id,
        status: run.status,
        summary: run.summary,
        anomaly_count: anomalyCount,
        new_anomalies: run.newCount,
        refreshed_anomalies: run.refreshedCount,
        explanation_source: run.explanationSource as ExplanationSource | null,
        meter_id: run.meterId ?? null,
        llm_used: run.llmUsed,
        started_at: run.startedAt.toISOString(),
        completed_at: run.completedAt?.toISOString() ?? null,
      };
    },
  };
}