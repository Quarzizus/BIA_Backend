import type { PrismaClient } from "../../generated/prisma/client";
import type { AnomalyStatus } from "../../generated/prisma/enums";
import { ApiError } from "../../shared/errors";
import { anomalyMeterCode } from "../../shared/domain/anomaly";
import { createAnomalyRepository } from "./anomaly.repository";
import { canTransition } from "./anomaly.transition";
import { computeAnomalyPriority } from "./anomaly.domain";
import type {
  AnomalyDetail,
  AnomalyFilters,
  AnomalyListItem,
  AnomalyRow,
  AnomalyService,
} from "./anomaly.domain";

function toListItem(anomaly: AnomalyRow, now: Date): AnomalyListItem {
  return {
    id: anomaly.id,
    meter_id: anomalyMeterCode(anomaly),
    type: anomaly.type,
    severity: anomaly.severity,
    confidence: anomaly.confidence,
    status: anomaly.status,
    recommended_action: anomaly.recommendedAction,
    recommended_action_simple: anomaly.recommendedActionSimple,
    detected_at: anomaly.detectedAt.toISOString(),
    priority: computeAnomalyPriority({
      severity: anomaly.severity,
      type: anomaly.type,
      detectedAt: anomaly.detectedAt,
      signals: anomaly.signals,
      now,
    }),
  };
}

/** Ordena la lista según el filtro `sort` (por defecto: prioridad descendente). */
function sortItems(items: AnomalyListItem[], sort: "priority" | "detected_at" | undefined): void {
  if (sort === "detected_at") {
    items.sort((a, b) => b.detected_at.localeCompare(a.detected_at));
    return;
  }
  // Empates en prioridad → detected_at descendente (más reciente primero).
  items.sort((a, b) => b.priority - a.priority || b.detected_at.localeCompare(a.detected_at));
}

export function createAnomalyService(prisma: PrismaClient): AnomalyService {
  const repository = createAnomalyRepository(prisma);

  const detail = async (id: string): Promise<AnomalyDetail> => {
    const anomaly = await repository.findById(id);
    if (!anomaly) {
      throw new ApiError(404, "NOT_FOUND", `Anomaly ${id} not found`);
    }
    // Un solo `now` por petición: el score es consistente dentro de la respuesta.
    const now = new Date();
    return {
      ...toListItem(anomaly, now),
      range_start: anomaly.rangeStart.toISOString(),
      range_end: anomaly.rangeEnd.toISOString(),
      detection_type: anomaly.detectionType,
      signals: anomaly.signals as Record<string, unknown>,
      reason: anomaly.reason,
      reason_simple: anomaly.reasonSimple,
      related_event: anomaly.relatedEvent
        ? {
            id: anomaly.relatedEvent.id,
            type: anomaly.relatedEvent.eventType,
            timestamp: anomaly.relatedEvent.eventTimestamp.toISOString(),
            description: anomaly.relatedEvent.description,
          }
        : null,
      analysis_run_id: anomaly.analysisRunId,
    };
  };

  return {
    async list(filters: AnomalyFilters): Promise<AnomalyListItem[]> {
      // Un solo `now` por petición: todas las filas comparten el mismo instante
      // de referencia para la recencia.
      const now = new Date();
      const items = (await repository.list(filters)).map((anomaly) => toListItem(anomaly, now));
      sortItems(items, filters.sort);
      return items;
    },

    detail,

    async updateStatus(id: string, status: AnomalyStatus): Promise<AnomalyDetail> {
      const anomaly = await repository.findById(id);
      if (!anomaly) {
        throw new ApiError(404, "NOT_FOUND", `Anomaly ${id} not found`);
      }
      if (!canTransition(anomaly.status, status)) {
        throw new ApiError(
          409,
          "INVALID_STATUS_TRANSITION",
          `Cannot transition anomaly from ${anomaly.status} to ${status}`,
        );
      }
      // D4: la transición + el recálculo de Meter.status ocurren atómicamente
      // en el repositorio (updateStatusWithMeterRecompute) para que los KPIs
      // nunca queden obsoletos.
      await repository.updateStatusWithMeterRecompute(id, status);
      return detail(id);
    },
  };
}