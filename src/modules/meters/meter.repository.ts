import type { PrismaClient } from "../../generated/prisma/client";
import type { Meter, Reading } from "../../generated/prisma/client";
import { baselineWindow } from "../../shared/domain/baseline";
import type { MeterRepository } from "./meter.domain";

/**
 * Meters persistence — ALL Prisma access for the meters module.
 *
 * Note on naming: the methods take meter CODES (the `meterId` column), not the
 * internal `Meter.id` FK. Readings carry `meterId` as the FK to `Meter.id`,
 * so relation filters translate codes -> FK (`meter: { meterId: { in } }`).
 */
export function createMeterRepository(prisma: PrismaClient): MeterRepository {
  return {
    async listMeters(): Promise<Meter[]> {
      return prisma.meter.findMany({ orderBy: { meterId: "asc" } });
    },

    async findMeterByCode(meterId: string): Promise<Meter | null> {
      return prisma.meter.findUnique({ where: { meterId } });
    },

    async latestReadings(meterCodes: string[]): Promise<Reading[]> {
      if (meterCodes.length === 0) return [];
      // One row per meter: the first row in descending timestamp order is the latest.
      return prisma.reading.findMany({
        where: { meter: { meterId: { in: meterCodes } } },
        orderBy: { timestamp: "desc" },
        distinct: ["meterId"],
      });
    },

    async baselineReadings(meterCodes: string[]): Promise<Reading[]> {
      if (meterCodes.length === 0) return [];

      // First-7-days window PER METER via the shared pure rule
      // (`baselineWindow`: everything strictly before first + 7 days). All
      // seeded meters share a 09-01 start, but the cutoff is computed per
      // meter so the rule holds for any dataset. Group by the Reading FK
      // (meterId -> Meter.id); each bucket stays sorted ascending.
      const readings = await prisma.reading.findMany({
        where: { meter: { meterId: { in: meterCodes } } },
        orderBy: { timestamp: "asc" },
      });
      const byMeter = new Map<string, Reading[]>();
      for (const reading of readings) {
        const bucket = byMeter.get(reading.meterId) ?? [];
        bucket.push(reading);
        byMeter.set(reading.meterId, bucket);
      }
      const windows: Reading[] = [];
      for (const bucket of byMeter.values()) {
        const windowed = baselineWindow(bucket);
        // baselineWindow only filters; the elements are the same Reading rows.
        windows.push(...(windowed as Reading[]));
      }
      return windows;
    },

    async history(meterId: string): Promise<Reading[]> {
      return prisma.reading.findMany({
        where: { meter: { meterId } },
        orderBy: { timestamp: "asc" },
      });
    },
  };
}