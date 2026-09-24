import type { PrismaClient } from "../../generated/prisma/client";

export interface RecentAnomalyDto {
  id: string;
  meter_id: string;
  type: string;
  severity: string;
  status: string;
  detected_at: string;
}

export interface DashboardSummary {
  total_consumption: number;
  meters_alert: number;
  meters_critical: number;
  open_by_severity: { HIGH: number; MEDIUM: number; LOW: number };
  recent_anomalies: RecentAnomalyDto[];
}

export interface DashboardService {
  summary(): Promise<DashboardSummary>;
}

const RECENT_ANOMALIES_LIMIT = 5;

export function createDashboardService(prisma: PrismaClient): DashboardService {
  return {
    async summary(): Promise<DashboardSummary> {
      const [totalAgg, meterStatuses, openBySeverityRows, recent] = await Promise.all([
        prisma.reading.aggregate({ _sum: { consumptionKwh: true } }),
        prisma.meter.groupBy({ by: ["status"], _count: { _all: true } }),
        prisma.anomaly.groupBy({
          by: ["severity"],
          where: { status: "OPEN" },
          _count: { _all: true },
        }),
        prisma.anomaly.findMany({
          take: RECENT_ANOMALIES_LIMIT,
          orderBy: { detectedAt: "desc" },
          include: { meter: { select: { meterId: true } } },
        }),
      ]);

      const countByStatus = new Map(
        meterStatuses.map((row) => [row.status, row._count._all]),
      );
      const openBySeverity = { HIGH: 0, MEDIUM: 0, LOW: 0 };
      for (const row of openBySeverityRows) {
        openBySeverity[row.severity] = row._count._all;
      }

      return {
        total_consumption: totalAgg._sum.consumptionKwh ?? 0,
        meters_alert: countByStatus.get("ALERT") ?? 0,
        meters_critical: countByStatus.get("CRITICAL") ?? 0,
        open_by_severity: openBySeverity,
        recent_anomalies: recent.map((anomaly) => ({
          id: anomaly.id,
          meter_id: anomaly.meter?.meterId ?? anomaly.meterId,
          type: anomaly.type,
          severity: anomaly.severity,
          status: anomaly.status,
          detected_at: anomaly.detectedAt.toISOString(),
        })),
      };
    },
  };
}