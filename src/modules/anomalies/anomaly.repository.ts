import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import type { AnomalyStatus, Severity } from "../../generated/prisma/enums";

export const anomalyInclude = {
  meter: { select: { meterId: true } },
  relatedEvent: true,
} satisfies Prisma.AnomalyInclude;

export type AnomalyWithRelations = Prisma.AnomalyGetPayload<{
  include: typeof anomalyInclude;
}>;

export interface AnomalyFilters {
  status?: string;
  severity?: string;
}

export interface AnomalyRepository {
  list(filters: AnomalyFilters): Promise<AnomalyWithRelations[]>;
  findById(id: string): Promise<AnomalyWithRelations | null>;
}

export function createAnomalyRepository(prisma: PrismaClient): AnomalyRepository {
  return {
    async list(filters: AnomalyFilters): Promise<AnomalyWithRelations[]> {
      return prisma.anomaly.findMany({
        where: {
          ...(filters.status ? { status: filters.status as AnomalyStatus } : {}),
          ...(filters.severity ? { severity: filters.severity as Severity } : {}),
        },
        include: anomalyInclude,
        orderBy: { detectedAt: "desc" },
      });
    },

    async findById(id: string): Promise<AnomalyWithRelations | null> {
      return prisma.anomaly.findUnique({
        where: { id },
        include: anomalyInclude,
      });
    },
  };
}
