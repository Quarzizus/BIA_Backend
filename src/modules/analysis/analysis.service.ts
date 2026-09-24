import type { Meter, PrismaClient, Reading } from "../../generated/prisma/client";
import { ApiError } from "../../shared/errors";
import type { LlmEnv } from "../../shared/domain/llm";
import { logger } from "../../shared/logger";
import { computeBaseline } from "./stages/analysis.baseline.calculator";
import { classifyAnomaly, coveringEvent, type MeterEvent } from "./stages/analysis.classifier";
import { consolidateDetections, detectMeter } from "./stages/analysis.detector";
import { FALLBACK_ACTION, FALLBACK_REASON, SEVERITY_CONFIDENCE } from "./analysis.domain";
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
 *  - runAnalysis(): ejecuta el pipeline de 3 etapas sobre cada medidor y
 *    persiste UNA anomalía consolidada por medidor afectado + el status de
 *    medidor recalculado en una sola transacción. Fallback por reglas POR
 *    MEDIDOR si el LLM falla (explicación en español, llm_used=false para esa
 *    llamada): un timeout en un medidor no borra los hallazgos del resto.
 *  - getStatus(): contrato de polling para GET /ai/analysis/:id.
 *
 * Solo orquestación: toda la persistencia vive en analysis.repository, los
 * tipos/constantes de dominio puro en analysis.domain, y las reglas compartidas
 * en shared/domain.
 */

export type AnalysisDeps = LlmEnv;

export interface AnalysisRunStatus {
  id: string;
  status: string;
  summary: string | null;
  anomaly_count: number;
  llm_used: boolean;
  started_at: string;
  completed_at: string | null;
}

export interface AnalysisService {
  start(): Promise<{ id: string; status: string }>;
  runAnalysis(runId: string, options?: { meterCodes?: string[] }): Promise<void>;
  getStatus(runId: string): Promise<AnalysisRunStatus>;
}

export function createAnalysisService(
  prisma: PrismaClient,
  llm: LlmClient,
  env: AnalysisDeps,
): AnalysisService {
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
      detectMeter(meterReadings, baseline),
      meterReadings,
      baseline,
    );
    if (!consolidated) return { finding: null, llmUsed: false };

    const classification = classifyAnomaly({
      detectionType: consolidated.detectionType,
      rangeStart: consolidated.rangeStart,
      rangeEnd: consolidated.rangeEnd,
      maxZ: consolidated.maxZ,
      events,
    });

    let type = classification.type;
    let severity = classification.severity;
    let reason: string;
    let recommendedAction: string;
    let llmUsed = false;

    if (classification.needsLlm) {
      // Caso límite: el LLM clasifica la situación ambigua. Si el proveedor
      // falla, se conserva la clasificación determinista por reglas.
      try {
        const llmResult = await llm.classify({
          meterId: meter.meterId,
          detectionType: consolidated.detectionType,
          signals: consolidated.signals,
          rangeStart: consolidated.rangeStart.toISOString(),
          rangeEnd: consolidated.rangeEnd.toISOString(),
        });
        type = llmResult.type;
        severity = llmResult.severity;
        reason = llmResult.reason;
        recommendedAction = llmResult.recommended_action;
        llmUsed = true;
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
        llmUsed = true;
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
      }
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
        confidence: SEVERITY_CONFIDENCE[severity],
        signals: consolidated.signals,
        reason,
        recommendedAction,
        relatedEventId: relatedEvent?.id ?? null,
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
    // llm_used del run: true si CUALQUIER llamada al LLM tuvo éxito.
    let llmUsed = false;
    for (const meter of selectedMeters) {
      try {
        const { finding, llmUsed: meterLlmUsed } = await processMeter(
          meter,
          readingsByMeter.get(meter.id) ?? [],
          eventsByMeter.get(meter.id) ?? [],
        );
        llmUsed = llmUsed || meterLlmUsed;
        if (finding) findings.push(finding);
      } catch (err) {
        // Defensivo: un fallo inesperado en un medidor no debe matar el run.
        logger.warn("medidor omitido por error inesperado durante el análisis", {
          meterId: meter.meterId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const summary = `Detected ${findings.length} anomaly(ies) across ${new Set(findings.map((finding) => finding.meterId)).size} meter(s)`;
    await repository.persistFindings(runId, findings, summary, llmUsed);
  }

  return {
    async start() {
      assertConfigured();
      const run = await repository.createRun();
      // Ejecución asíncrona desacoplada: responder 202 primero, luego correr el pipeline.
      void this.runAnalysis(run.id).catch((err) => {
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
      const anomalyCount = await repository.countAnomalies(runId);
      return {
        id: run.id,
        status: run.status,
        summary: run.summary,
        anomaly_count: anomalyCount,
        llm_used: run.llmUsed,
        started_at: run.startedAt.toISOString(),
        completed_at: run.completedAt?.toISOString() ?? null,
      };
    },
  };
}