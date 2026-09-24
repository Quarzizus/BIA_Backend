import type { Meter, PrismaClient, Reading } from "../../generated/prisma/client";
import { ApiError } from "../../shared/errors";
import type { LlmEnv } from "../../shared/domain/llm";
import { logger } from "../../shared/logger";
import { computeBaseline } from "./analysis.baseline.calculator";
import { classifyAnomaly, coveringEvent, type MeterEvent } from "./analysis.classifier";
import { consolidateDetections, detectMeter } from "./analysis.detector";
import { SEVERITY_CONFIDENCE } from "./analysis.domain";
import type { LlmClient } from "./analysis.llm.client";
import {
  createAnalysisRepository,
  type AnalysisFinding,
  type AnalysisRepository,
} from "./analysis.repository";

/**
 * Analysis orchestration (tasks 3.7/3.8):
 *  - start(): creates a RUNNING AnalysisRun holding the lockToken='single'
 *    (P2002 → 409 ANALYSIS_IN_PROGRESS) and launches the detached runner.
 *  - runAnalysis(): executes the 3-stage pipeline over every meter and persists
 *    ONE consolidated anomaly per affected meter + recomputed meter status in a
 *    single transaction. LLM failure → run FAILED, llm_used=false (no degrade).
 *  - getStatus(): polling contract for GET /ai/analysis/:id.
 *
 * Orchestration only: all persistence lives in analysis.repository, pure domain
 * types/constants in analysis.domain, and shared rules in shared/domain.
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

  /**
   * Per-meter pipeline step: baseline → detection → consolidation →
   * classification (rule-based or LLM) → related-event lookup → finding.
   * Pure-ish: no persistence.
   */
  async function processMeter(
    meter: Meter,
    meterReadings: Reading[],
    events: MeterEvent[],
  ): Promise<AnalysisFinding | null> {
    if (meterReadings.length === 0) return null;

    const baseline = computeBaseline(meterReadings);
    if (baseline.consumption_kwh.mean === null) return null;

    const consolidated = consolidateDetections(detectMeter(meterReadings, baseline));
    if (!consolidated) return null;

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

    if (classification.needsLlm) {
      // Borderline: the LLM classifies the ambiguous case.
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
    } else {
      // Confirmed anomaly: LLM generates the Spanish explanation.
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
    }

    // Related event: reuse the classifier's covering rule (single source of
    // truth) and resolve the persisted event via the repository.
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
    };
  }

  /** Full 3-stage pipeline over every (or selected) meter, persisted atomically. */
  async function runPipeline(runId: string, meterCodes?: string[]) {
    const { meters, readingsByMeter, eventsByMeter } = await repository.loadPipelineData();
    const selectedMeters = meterCodes
      ? meters.filter((meter) => meterCodes.includes(meter.meterId))
      : meters;

    const findings: AnalysisFinding[] = [];
    for (const meter of selectedMeters) {
      const finding = await processMeter(
        meter,
        readingsByMeter.get(meter.id) ?? [],
        eventsByMeter.get(meter.id) ?? [],
      );
      if (finding) findings.push(finding);
    }

    const summary = `Detected ${findings.length} anomaly(ies) across ${new Set(findings.map((finding) => finding.meterId)).size} meter(s)`;
    await repository.persistFindings(runId, findings, summary);
  }

  return {
    async start() {
      assertConfigured();
      const run = await repository.createRun();
      // Detached async execution: respond 202 first, then run the pipeline.
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