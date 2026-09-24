import type { AnalysisRun, Meter, PrismaClient, Reading } from "../../generated/prisma/client";
import type { AnomalyType, Severity } from "../../generated/prisma/enums";
import { deriveMeterStatus } from "../../shared/domain/meter-status";
import type { MeterEvent } from "./analysis.domain";

/**
 * Capa de persistencia del análisis — TODO el acceso a Prisma del módulo.
 *
 * Tiene el CRUD de AnalysisRun, la carga de datos del pipeline, la búsqueda de
 * eventos y la escritura atómica de anomalías + status de medidor que completa
 * un run. Persistencia pura: la derivación de negocio (p. ej. status de
 * medidor) viene de shared/domain.
 */

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
  /** Persiste hallazgos + status de medidor recalculado + finalización del run, atómicamente. */
  persistFindings(
    runId: string,
    findings: AnalysisFinding[],
    summary: string,
    llmUsed: boolean,
  ): Promise<void>;
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

    async persistFindings(runId, findings, summary, llmUsed) {
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
          // D4: el status del medidor refleja la anomalía OPEN más severa de este run.
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
            llmUsed,
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