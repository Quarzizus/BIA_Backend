import type { AnalysisRun, Meter, PrismaClient, Reading } from "../../generated/prisma/client";
import type { AnomalyType, Severity } from "../../generated/prisma/enums";
import { deriveMeterStatus } from "../../shared/domain/meter-status";
import type { MeterEvent } from "./analysis.domain";

/**
 * Analysis persistence layer — ALL Prisma access for the analysis module.
 *
 * Owns AnalysisRun CRUD, pipeline data loading, the event lookup and the
 * atomic anomaly + meter-status write that completes a run. Pure persistence:
 * business derivation (e.g. meter status) comes from shared/domain.
 */

/** One consolidated anomaly to persist for a meter (payload for Prisma). */
export interface AnalysisFinding {
  meterId: string;
  detectionType: string;
  rangeStart: Date;
  rangeEnd: Date;
  type: AnomalyType;
  severity: Severity;
  confidence: number;
  signals: object;
  reason: string;
  recommendedAction: string;
  relatedEventId: string | null;
}

export interface PipelineData {
  meters: Meter[];
  readingsByMeter: Map<string, Reading[]>;
  eventsByMeter: Map<string, MeterEvent[]>;
}

export interface AnalysisRepository {
  createRun(): Promise<{ id: string; status: string }>;
  findRun(runId: string): Promise<AnalysisRun | null>;
  loadPipelineData(): Promise<PipelineData>;
  findEvent(
    meterId: string,
    eventTimestamp: Date,
    eventType: MeterEvent["eventType"],
  ): Promise<{ id: string } | null>;
  /** Persists findings + recomputed meter status + run completion atomically. */
  persistFindings(runId: string, findings: AnalysisFinding[], summary: string): Promise<void>;
  failRun(runId: string, message: string): Promise<void>;
  countAnomalies(runId: string): Promise<number>;
}

export function createAnalysisRepository(prisma: PrismaClient): AnalysisRepository {
  return {
    async createRun() {
      const run = await prisma.analysisRun.create({
        data: { status: "RUNNING", lockToken: "single" },
      });
      return { id: run.id, status: run.status };
    },

    async findRun(runId) {
      return prisma.analysisRun.findUnique({ where: { id: runId } });
    },

    async loadPipelineData() {
      const [meters, readings, events] = await Promise.all([
        prisma.meter.findMany({ orderBy: { meterId: "asc" } }),
        prisma.reading.findMany({ orderBy: { timestamp: "asc" } }),
        prisma.event.findMany(),
      ]);
      const readingsByMeter = new Map<string, Reading[]>();
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
    },

    async findEvent(meterId, eventTimestamp, eventType) {
      return prisma.event.findFirst({
        where: { meterId, eventTimestamp, eventType },
        select: { id: true },
      });
    },

    async persistFindings(runId, findings, summary) {
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
            summary,
            completedAt: new Date(),
            lockToken: null,
            llmUsed: true,
          },
        });
      });
    },

    async failRun(runId, message) {
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
    },

    async countAnomalies(runId) {
      return prisma.anomaly.count({ where: { analysisRunId: runId } });
    },
  };
}