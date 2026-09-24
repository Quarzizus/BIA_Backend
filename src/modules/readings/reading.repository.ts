import type { PrismaClient } from "../../generated/prisma/client";
import type { Reading } from "../../generated/prisma/client";

export interface ReadingsRepository {
  meterExists(meterId: string): Promise<boolean>;
  findInRange(meterId: string, from?: Date, to?: Date): Promise<Reading[]>;
}

export function createReadingsRepository(prisma: PrismaClient): ReadingsRepository {
  return {
    async meterExists(meterId: string): Promise<boolean> {
      const meter = await prisma.meter.findUnique({
        where: { meterId },
        select: { id: true },
      });
      return meter !== null;
    },

    async findInRange(meterId: string, from?: Date, to?: Date): Promise<Reading[]> {
      return prisma.reading.findMany({
        where: {
          meter: { meterId },
          timestamp: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lte: to } : {}),
          },
        },
        orderBy: { timestamp: "asc" },
      });
    },
  };
}