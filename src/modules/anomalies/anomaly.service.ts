import type { PrismaClient } from "../../generated/prisma/client";
import type { AnomalyStatus } from "../../generated/prisma/enums";
import { ApiError } from "../../shared/errors";
import {
  anomalyInclude,
  createAnomalyRepository,
  type AnomalyFilters,
  type AnomalyWithRelations,
} from "./anomaly.repository";
import { canTransition } from "./anomaly.transition";
import { deriveMeterStatus } from "./anomaly.meter-status";
import type { AnomalyDetail, AnomalyListItem } from "./anomaly.model";

function toListItem(anomaly: AnomalyWithRelations): AnomalyListItem {
  return {
    id: anomaly.id,
    meter_id: anomaly.meter?.meterId ?? anomaly.meterId,
    type: anomaly.type,
    severity: anomaly.severity,
    confidence: anomaly.confidence,
    status: anomaly.status,
    recommended_action: anomaly.recommendedAction,
    detected_at: anomaly.detectedAt.toISOString(),
  };
}

export interface AnomalyService {
  list(filters: AnomalyFilters): Promise<AnomalyListItem[]>;
  detail(id: string): Promise<AnomalyDetail>;
  updateStatus(id: string, status: AnomalyStatus): Promise<AnomalyDetail>;
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
      // D4: persist the transition and recompute Meter.status from the most
      // severe ACTIVE (not RESOLVED) anomaly in the SAME transaction, so the
      // dashboard/meters KPIs never go stale.
      await prisma.$transaction(async (tx) => {
        const updated = await tx.anomaly.update({
          where: { id },
          data: { status },
          include: anomalyInclude,
        });
        const active = await tx.anomaly.findMany({
          where: { meterId: updated.meterId, status: { not: "RESOLVED" } },
          select: { severity: true },
        });
        await tx.meter.update({
          where: { id: updated.meterId },
          data: { status: deriveMeterStatus(active.map((a) => a.severity)) },
        });
      });
      return detail(id);
    },
  };
}