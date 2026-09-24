import type { PrismaClient } from "../../generated/prisma/client";
import type { Meter, Reading } from "../../generated/prisma/client";
import { BASELINE_WINDOW_DAYS } from "./baseline";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MeterRepository {
  listMeters(): Promise<Meter[]>;
  findMeterByCode(meterId: string): Promise<Meter | null>;
  latestReadings(meterIds: string[]): Promise<Reading[]>;
  baselineReadings(meterIds: string[]): Promise<Reading[]>;
  history(meterId: string): Promise<Reading[]>;
}

export function createMeterRepository(prisma: PrismaClient): MeterRepository {
  return {
    async listMeters(): Promise<Meter[]> {
      return prisma.meter.findMany({ orderBy: { meterId: "asc" } });
    },

    async findMeterByCode(meterId: string): Promise<Meter | null> {
      return prisma.meter.findUnique({ where: { meterId } });
    },

    async latestReadings(meterIds: string[]): Promise<Reading[]> {
      if (meterIds.length === 0) return [];
      // One row per meter: the first row in descending timestamp order is the latest.
      return prisma.reading.findMany({
        where: { meter: { meterId: { in: meterIds } } },
        orderBy: { timestamp: "desc" },
        distinct: ["meterId"],
      });
    },

    async baselineReadings(meterIds: string[]): Promise<Reading[]> {
      if (meterIds.length === 0) return [];

      // First-7-days window per meter: everything strictly before
      // (min(timestamp) + 7 days). All seeded meters share a 09-01 start, but
      // the cutoff is computed per meter so the rule holds for any dataset.
      const minByMeter = await prisma.reading.groupBy({
        by: ["meterId"],
        where: { meter: { meterId: { in: meterIds } } },
        _min: { timestamp: true },
      });
      const cutoffByMeter = new Map<string, number>();
      for (const row of minByMeter) {
        if (row._min.timestamp) {
          cutoffByMeter.set(
            row.meterId,
            row._min.timestamp.getTime() + BASELINE_WINDOW_DAYS * DAY_MS,
          );
        }
      }
      if (cutoffByMeter.size === 0) return [];

      const maxCutoff = Math.max(...cutoffByMeter.values());
      const readings = await prisma.reading.findMany({
        where: {
          meter: { meterId: { in: meterIds } },
          timestamp: { lt: new Date(maxCutoff) },
        },
        orderBy: { timestamp: "asc" },
      });
      return readings.filter((reading) => {
        const cutoff = cutoffByMeter.get(reading.meterId);
        return cutoff !== undefined && reading.timestamp.getTime() < cutoff;
      });
    },

    async history(meterId: string): Promise<Reading[]> {
      return prisma.reading.findMany({
        where: { meter: { meterId } },
        orderBy: { timestamp: "asc" },
      });
    },
  };
}