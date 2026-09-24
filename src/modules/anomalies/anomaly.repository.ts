import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import type { AnomalyStatus } from "../../generated/prisma/enums";
import { deriveMeterStatus } from "../../shared/domain/meter-status";
import type { AnomalyFilters, AnomalyRepository, AnomalyRow } from "./anomaly.domain";

export const anomalyInclude = {
  meter: { select: { meterId: true } },
  relatedEvent: true,
} satisfies Prisma.AnomalyInclude;

export type AnomalyWithRelations = Prisma.AnomalyGetPayload<{
  include: typeof anomalyInclude;
}>;

export function createAnomalyRepository(prisma: PrismaClient): AnomalyRepository {
  return {
    async list(filters: AnomalyFilters): Promise<AnomalyRow[]> {
      return prisma.anomaly.findMany({
        where: {
          ...(filters.status ? { status: filters.status } : {}),
          ...(filters.severity ? { severity: filters.severity } : {}),
        },
        include: anomalyInclude,
        orderBy: { detectedAt: "desc" },
      });
    },

    async findById(id: string): Promise<AnomalyRow | null> {
      return prisma.anomaly.findUnique({
        where: { id },
        include: anomalyInclude,
      });
    },

    async updateStatusWithMeterRecompute(id: string, status: AnomalyStatus): Promise<void> {
      // D4: persiste la transición y recalcula Meter.status desde la anomalía
      // ACTIVE (no RESOLVED) más severa en la MISMA transacción, para que los
      // KPIs del dashboard/meters nunca queden obsoletos.
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
    },
  };
}