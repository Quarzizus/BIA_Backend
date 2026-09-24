import type { PrismaClient } from "../../generated/prisma/client";
import type { DashboardRepository } from "./dashboard.domain";

/**
 * Dashboard persistence — ALL Prisma access for the dashboard module.
 * Raw aggregations only; the summary assembly (count maps, DTO mapping)
 * lives in dashboard.service.ts.
 */
export function createDashboardRepository(prisma: PrismaClient): DashboardRepository {
  return {
    async totalConsumption(): Promise<number | null> {
      const agg = await prisma.reading.aggregate({ _sum: { consumptionKwh: true } });
      return agg._sum.consumptionKwh ?? null;
    },

    async meterStatusCounts() {
      const rows = await prisma.meter.groupBy({ by: ["status"], _count: { _all: true } });
      return rows.map((row) => ({ status: row.status, count: row._count._all }));
    },

    async openBySeverityCounts() {
      const rows = await prisma.anomaly.groupBy({
        by: ["severity"],
        where: { status: "OPEN" },
        _count: { _all: true },
      });
      return rows.map((row) => ({ severity: row.severity, count: row._count._all }));
    },

    async recentAnomalies(limit: number) {
      return prisma.anomaly.findMany({
        take: limit,
        orderBy: { detectedAt: "desc" },
        include: { meter: { select: { meterId: true } } },
      });
    },
  };
}