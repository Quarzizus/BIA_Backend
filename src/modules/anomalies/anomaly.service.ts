import type { PrismaClient } from "../../generated/prisma/client";
import type { AnomalyStatus } from "../../generated/prisma/enums";
import { ApiError } from "../../shared/errors";
import { anomalyMeterCode } from "../../shared/domain/anomaly";
import { createAnomalyRepository } from "./anomaly.repository";
import { canTransition } from "./anomaly.transition";
import type {
  AnomalyDetail,
  AnomalyFilters,
  AnomalyListItem,
  AnomalyRow,
  AnomalyService,
} from "./anomaly.domain";

function toListItem(anomaly: AnomalyRow): AnomalyListItem {
  return {
    id: anomaly.id,
    meter_id: anomalyMeterCode(anomaly),
    type: anomaly.type,
    severity: anomaly.severity,
    confidence: anomaly.confidence,
    status: anomaly.status,
    recommended_action: anomaly.recommendedAction,
    detected_at: anomaly.detectedAt.toISOString(),
  };
}

export function createAnomalyService(prisma: PrismaClient): AnomalyService {
  const repository = createAnomalyRepository(prisma);

  const detail = async (id: string): Promise<AnomalyDetail> => {
    const anomaly = await repository.findById(id);
    if (!anomaly) {
      throw new ApiError(404, "NOT_FOUND", `Anomaly ${id} not found`);
    }
    return {
      ...toListItem(anomaly),
      range_start: anomaly.rangeStart.toISOString(),
      range_end: anomaly.rangeEnd.toISOString(),
      detection_type: anomaly.detectionType,
      signals: anomaly.signals as Record<string, unknown>,
      reason: anomaly.reason,
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
      const anomalies = await repository.list(filters);
      return anomalies.map(toListItem);
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