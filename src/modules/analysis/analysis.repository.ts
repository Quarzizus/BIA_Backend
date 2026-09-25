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
  reasonSimple: string;
  recommendedActionSimple: string;
  relatedEventId: string | null;
  /** true si el LLM fue llamado y respondió en ESTE run; false en fallback y caché. */
  llmUsed: boolean;
  /** Origen de los textos persistidos: true si el LLM los produjo (o se reutilizan de una fila LLM), false si son fallback por reglas. */
  llmGenerated: boolean;
}

/**
 * Explicaciones reutilizables de una anomalía OPEN previa con la misma evidencia
 * (mismo detectionType + mismo signals). Evita una llamada al LLM en re-runs.
 */
export interface AnomalyEvidenceCache {
  type: AnomalyType;
  severity: Severity;
  confidence: number;
  reason: string;
  reasonSimple: string;
  recommendedAction: string;
  recommendedActionSimple: string;
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
  /**
   * Caché de explicaciones: devuelve la anomalía OPEN del medidor cuya evidencia
   * coincide con la actual (mismo detectionType + mismo signals JSON) y cuyo
   * texto proviene del LLM (llmGenerated=true), o null. Las filas de fallback
   * por reglas nunca se reutilizan (F2).
   */
  findOpenMatchingEvidence(
    meterId: string,
    detectionType: string,
    signals: object,
  ): Promise<AnomalyEvidenceCache | null>;
  /**
   * Persiste hallazgos + status de medidor recalculado + finalización del run,
   * atómicamente. `explanationSource` es el origen de los textos del run
   * ("llm" | "llm_cached" | "rules" | null) decidido por el servicio.
   */
  persistFindings(
    runId: string,
    findings: AnalysisFinding[],
    summary: string,
    llmUsed: boolean,
    explanationSource: "llm" | "llm_cached" | "rules" | null,
  ): Promise<void>;
  failRun(runId: string, message: string): Promise<void>;
}

/** Fila activa (status != RESOLVED) pre-fetchada para el upsert y el recompute de Meter.status. */
interface ActiveAnomalyRow {
  id: string;
  type: AnomalyType;
  severity: Severity;
  status: string;
}

/**
 * Helper del upsert de hallazgos: devuelve la anomalía OPEN del medidor con el
 * mismo tipo, si existe. Solo las OPEN entran en el set activo — las RESOLVED
 * son historial y no bloquean la creación de una fila nueva.
 * (Eliminado el findFirst por hallazgo: F10 pre-fetcha todas las filas activas
 * en una sola consulta y decide en JS.)
 */

/**
 * Serialización canónica (claves ordenadas recursivamente) para comparar
 * señales de forma estable: Postgres jsonb reordena las claves al almacenar
 * (por longitud y luego byte a byte), así que JSON.stringify directo NO es
 * estable entre lo persistido y lo recién calculado.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, v]) => `${JSON.stringify(key)}:${stableStringify(v)}`)
    .join(",")}}`;
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

    async findOpenMatchingEvidence(meterId, detectionType, signals) {
      // F2: solo las filas cuyo TEXTO proviene del LLM (llmGenerated=true) son
      // reutilizables. Las de fallback por reglas no se cachean: el próximo run
      // re-intenta el LLM para explicar el caso con el modelo recuperado.
      const open = await prisma.anomaly.findMany({
        where: { meterId, status: "OPEN", llmGenerated: true },
        select: {
          type: true,
          severity: true,
          confidence: true,
          reason: true,
          reasonSimple: true,
          recommendedAction: true,
          recommendedActionSimple: true,
          detectionType: true,
          signals: true,
        },
      });
      // La evidencia es el fingerprint: mismo tipo de detección y señales
      // idénticas (comparación canónica: jsonb no preserva el orden de claves).
      const match = open.find(
        (anomaly) =>
          anomaly.detectionType === detectionType &&
          stableStringify(anomaly.signals) === stableStringify(signals),
      );
      if (!match) return null;
      return {
        type: match.type,
        severity: match.severity,
        confidence: match.confidence,
        reason: match.reason ?? "",
        reasonSimple: match.reasonSimple ?? "",
        recommendedAction: match.recommendedAction ?? "",
        recommendedActionSimple: match.recommendedActionSimple ?? "",
      };
    },

    async persistFindings(runId, findings, summary, llmUsed, explanationSource) {
      await prisma.$transaction(async (tx) => {
        // F10: UNA consulta pre-fetcha las anomalías ACTIVE (no RESOLVED) de
        // todos los medidores afectados. Sirve para (a) decidir create/update
        // en JS (sin findFirst por hallazgo) y (b) recalcular Meter.status con
        // TODAS las severidades activas del medidor, no solo la de este run (F1).
        const meterIds = [...new Set(findings.map((finding) => finding.meterId))];
        const activeRowsByMeter = new Map<string, ActiveAnomalyRow[]>();
        if (meterIds.length > 0) {
          const active = await tx.anomaly.findMany({
            where: { meterId: { in: meterIds }, status: { not: "RESOLVED" } },
            select: { id: true, meterId: true, type: true, severity: true, status: true },
          });
          for (const row of active) {
            const bucket = activeRowsByMeter.get(row.meterId) ?? [];
            bucket.push(row);
            activeRowsByMeter.set(row.meterId, bucket);
          }
        }

        let newCount = 0;
        let refreshedCount = 0;
        // Severidades activas por medidor, en JS: arrancan con las pre-existentes
        // y cada create/update ajusta el set antes del recompute final (F1).
        const activeSeverities = new Map<string, string[]>();
        for (const [meterId, rows] of activeRowsByMeter) {
          activeSeverities.set(meterId, rows.map((row) => row.severity));
        }

        for (const finding of findings) {
          const rows = activeRowsByMeter.get(finding.meterId) ?? [];
          const open = rows.find(
            (row) => row.status === "OPEN" && row.type === finding.type,
          ) ?? null;
          const severities = activeSeverities.get(finding.meterId) ?? [];

          if (open) {
            // F4: el run que CREÓ la anomalía conserva analysisRunId — los
            // re-runs refrescan el contenido sin re-parentar (auditabilidad
            // estable: cada run reporta las que creó).
            await tx.anomaly.update({
              where: { id: open.id },
              data: {
                relatedEventId: finding.relatedEventId,
                type: finding.type as never,
                severity: finding.severity as never,
                confidence: finding.confidence,
                reason: finding.reason,
                recommendedAction: finding.recommendedAction,
                reasonSimple: finding.reasonSimple,
                recommendedActionSimple: finding.recommendedActionSimple,
                rangeStart: finding.rangeStart,
                rangeEnd: finding.rangeEnd,
                detectionType: finding.detectionType,
                signals: finding.signals,
                detectedAt: new Date(),
                llmGenerated: finding.llmGenerated,
              },
            });
            refreshedCount++;
            // La fila refrescada cambia de severidad: se reemplaza la previa.
            const replaced = severities.indexOf(open.severity);
            if (replaced !== -1) severities.splice(replaced, 1);
            severities.push(finding.severity);
          } else {
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
                reasonSimple: finding.reasonSimple,
                recommendedActionSimple: finding.recommendedActionSimple,
                status: "OPEN",
                rangeStart: finding.rangeStart,
                rangeEnd: finding.rangeEnd,
                detectionType: finding.detectionType,
                signals: finding.signals,
                llmGenerated: finding.llmGenerated,
              },
            });
            newCount++;
            severities.push(finding.severity);
            // La fila creada entra al set activo (evita duplicados si el mismo
            // run produjera dos findings del mismo tipo para el medidor).
            rows.push({
              id: "",
              type: finding.type,
              severity: finding.severity,
              status: "OPEN",
            });
          }
          activeSeverities.set(finding.meterId, severities);
        }

        // F1: Meter.status = derivación sobre TODAS las anomalías activas del
        // medidor (misma regla que el PATCH de anomalies) — un HIGH previo
        // mantiene CRITICAL aunque el run actual solo produzca MEDIUM.
        for (const [meterId, severities] of activeSeverities) {
          await tx.meter.update({
            where: { id: meterId },
            data: { status: deriveMeterStatus(severities) },
          });
        }

        // F4: el resumen distingue nuevas vs refrescadas dentro del run.
        const summaryWithCounts = `${summary} (${newCount} new, ${refreshedCount} refreshed)`;
        await tx.analysisRun.update({
          where: { id: runId },
          data: {
            status: "COMPLETED",
            summary: summaryWithCounts,
            completedAt: new Date(),
            lockToken: null,
            llmUsed,
            // Contadores del contrato de status: nuevas y refrescadas del run.
            newCount,
            refreshedCount,
            // Origen de las explicaciones (null si el run no tuvo hallazgos).
            explanationSource,
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
          // FAILED: sin hallazgos → origen de explicaciones null.
          newCount: 0,
          refreshedCount: 0,
          explanationSource: null,
        },
      });
    },
  };
}