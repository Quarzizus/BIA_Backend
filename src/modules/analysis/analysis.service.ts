import type { PrismaClient } from "../../generated/prisma/client";
import { ApiError } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { deriveMeterStatus } from "../anomalies/anomaly.meter-status";
import { computeBaseline } from "./analysis.baseline.calculator";
import { classifyAnomaly, type MeterEvent } from "./analysis.classifier";
import { consolidateDetections, detectMeter } from "./analysis.detector";
import type { LlmClient } from "./analysis.llm.client";

/**
 * Analysis orchestration (tasks 3.7/3.8):
 *  - start(): creates a RUNNING AnalysisRun holding the lockToken='single'
 *    (P2002 → 409 ANALYSIS_IN_PROGRESS) and launches the detached runner.
 *  - runAnalysis(): executes the 3-stage pipeline over every meter and persists
 *    ONE consolidated anomaly per affected meter + recomputed meter status in a
 *    single transaction. LLM failure → run FAILED, llm_used=false (no degrade).
 *  - getStatus(): polling contract for GET /ai/analysis/:id.
 */

export interface AnalysisDeps {
  AI_API_KEY: string;
  AI_BASE_URL: string;
  AI_MODEL: string;
}

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
  const assertConfigured = () => {
    if (!env.AI_API_KEY || !env.AI_BASE_URL || !env.AI_MODEL) {
      throw new ApiError(
        503,
        "AI_NOT_CONFIGURED",
        "LLM is not configured: AI_API_KEY, AI_BASE_URL and AI_MODEL are required",
      );
    }
  };

  async function loadPipelineData() {
    const [meters, readings, events] = await Promise.all([
      prisma.meter.findMany({ orderBy: { meterId: "asc" } }),
      prisma.reading.findMany({ orderBy: { timestamp: "asc" } }),
      prisma.event.findMany(),
    ]);
    const readingsByMeter = new Map<string, typeof readings>();
    for (const reading of readings) {
      const bucket = readingsByMeter.get(reading.meterId) ?? [];
      bucket.push(reading);
      readingsByMeter.set(reading.meterId, bucket);
    }
    const eventsByMeter = new Map<string, MeterEvent[]>();
    for (const event of events) {
      const bucket = eventsByMeter.get(event.meterId) ?? [];
      bucket.push({ eventTimestamp: event.eventTimestamp, eventType: event.eventType });
      eventsByMeter.set(event.meterId, bucket);
    }
    return { meters, readingsByMeter, eventsByMeter };
  }

  return {
    async start() {
      assertConfigured();
      const run = await prisma.analysisRun.create({
        data: { status: "RUNNING", lockToken: "single" },
      });
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
      const run = await prisma.analysisRun.findUnique({ where: { id: runId } });
      if (!run || run.status !== "RUNNING") return;

      try {
        assertConfigured();
        const { meters, readingsByMeter, eventsByMeter } = await loadPipelineData();
        const selectedMeters = options.meterCodes
          ? meters.filter((m) => options.meterCodes!.includes(m.meterId))
          : meters;

        const findings: {
          meterId: string;
          detectionType: string;
          rangeStart: Date;
          rangeEnd: Date;
          type: string;
          severity: string;
          confidence: number;
          signals: object;
          reason: string;
          recommendedAction: string;
          relatedEventId: string | null;
        }[] = [];

        for (const meter of selectedMeters) {
          const meterReadings = readingsByMeter.get(meter.id) ?? [];
          if (meterReadings.length === 0) continue;

          const baseline = computeBaseline(meterReadings);
          if (baseline.consumption_kwh.mean === null) continue;

          const detections = detectMeter(meterReadings, baseline);
          const consolidated = consolidateDetections(detections);
          if (!consolidated) continue;

          const events = eventsByMeter.get(meter.id) ?? [];
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

          const coveringEvent = events.find(
            (e) =>
              e.eventTimestamp.getTime() >= consolidated.rangeStart.getTime() &&
              e.eventTimestamp.getTime() <= consolidated.rangeEnd.getTime(),
          );
          const relatedEvent = coveringEvent
            ? await prisma.event.findFirst({
                where: {
                  meterId: meter.id,
                  eventTimestamp: coveringEvent.eventTimestamp,
                  eventType: coveringEvent.eventType,
                },
              })
            : null;

          findings.push({
            meterId: meter.id,
            detectionType: consolidated.detectionType,
            rangeStart: consolidated.rangeStart,
            rangeEnd: consolidated.rangeEnd,
            type,
            severity,
            confidence: severity === "HIGH" ? 0.99 : severity === "MEDIUM" ? 0.9 : 0.8,
            signals: consolidated.signals,
            reason,
            recommendedAction,
            relatedEventId: relatedEvent?.id ?? null,
          });
        }

        // Persist anomalies + meter status recompute + run completion atomically.
        await prisma.$transaction(async (tx) => {
          for (const finding of findings) {
            await tx.anomaly.create({
              data: {
                meterId: finding.meterId,
                analysisRunId: runId,
                relatedEventId: finding.relatedEventId,
                type: finding.type as never,
                severity: finding.severity as never,
                confidence: finding.confidence,
                reason: finding.reason,
                recommendedAction: finding.recommendedAction,
                status: "OPEN",
                rangeStart: finding.rangeStart,
                rangeEnd: finding.rangeEnd,
                detectionType: finding.detectionType,
                signals: finding.signals,
              },
            });
            // D4: meter status reflects the most severe OPEN anomaly of this run.
            const meterStatus = deriveMeterStatus([finding.severity]);
            await tx.meter.update({
              where: { id: finding.meterId },
              data: { status: meterStatus },
            });
          }
          await tx.analysisRun.update({
            where: { id: runId },
            data: {
              status: "COMPLETED",
              summary: `Detected ${findings.length} anomaly(ies) across ${new Set(findings.map((f) => f.meterId)).size} meter(s)`,
              completedAt: new Date(),
              lockToken: null,
              llmUsed: true,
            },
          });
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("analysis run failed", { runId, error: message });
        await prisma.analysisRun.update({
          where: { id: runId },
          data: {
            status: "FAILED",
            summary: message,
            completedAt: new Date(),
            lockToken: null,
            llmUsed: false,
          },
        });
      }
    },

    async getStatus(runId: string): Promise<AnalysisRunStatus> {
      const run = await prisma.analysisRun.findUnique({ where: { id: runId } });
      if (!run) {
        throw new ApiError(404, "NOT_FOUND", `Analysis run ${runId} not found`);
      }
      const anomalyCount = await prisma.anomaly.count({ where: { analysisRunId: runId } });
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