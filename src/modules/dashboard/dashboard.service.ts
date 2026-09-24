import type { PrismaClient } from "../../generated/prisma/client";
import { anomalyMeterCode } from "../../shared/domain/anomaly";
import { createDashboardRepository } from "./dashboard.repository";
import {
  RECENT_ANOMALIES_LIMIT,
  type DashboardService,
  type DashboardSummary,
} from "./dashboard.domain";

export function createDashboardService(prisma: PrismaClient): DashboardService {
  const repository = createDashboardRepository(prisma);

  return {
    async summary(): Promise<DashboardSummary> {
      const [total, meterStatuses, openBySeverityRows, recent] = await Promise.all([
        repository.totalConsumption(),
        repository.meterStatusCounts(),
        repository.openBySeverityCounts(),
        repository.recentAnomalies(RECENT_ANOMALIES_LIMIT),
      ]);

      const countByStatus = new Map(meterStatuses.map((row) => [row.status, row.count]));
      const openBySeverity = { HIGH: 0, MEDIUM: 0, LOW: 0 };
      for (const row of openBySeverityRows) {
        openBySeverity[row.severity] = row.count;
      }

      return {
        total_consumption: total ?? 0,
        meters_alert: countByStatus.get("ALERT") ?? 0,
        meters_critical: countByStatus.get("CRITICAL") ?? 0,
        open_by_severity: openBySeverity,
        recent_anomalies: recent.map((anomaly) => ({
          id: anomaly.id,
          meter_id: anomalyMeterCode(anomaly),
          type: anomaly.type,
          severity: anomaly.severity,
          status: anomaly.status,
          detected_at: anomaly.detectedAt.toISOString(),
        })),
      };
    },
  };
}