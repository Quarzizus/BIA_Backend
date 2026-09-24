import type { PrismaClient } from "../../generated/prisma/client";
import type { Meter, Reading } from "../../generated/prisma/client";
import { baselineWindow } from "../../shared/domain/baseline";
import type { MeterRepository } from "./meter.domain";

/**
 * Persistencia de meters — TODO el acceso a Prisma del módulo meters.
 *
 * Nota de nomenclatura: los métodos reciben CÓDIGOS de medidor (la columna
 * `meterId`), no el FK interno `Meter.id`. Las readings llevan `meterId` como
 * FK a `Meter.id`, así que los filtros de relación traducen código -> FK
 * (`meter: { meterId: { in } }`).
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
      // Una fila por medidor: la primera fila en orden descendente de timestamp
      // es la más reciente.
      return prisma.reading.findMany({
        where: { meter: { meterId: { in: meterCodes } } },
        orderBy: { timestamp: "desc" },
        distinct: ["meterId"],
      });
    },

    async baselineReadings(meterCodes: string[]): Promise<Reading[]> {
      if (meterCodes.length === 0) return [];

      // Ventana de primeros 7 días POR MEDIDOR vía la regla pura compartida
      // (`baselineWindow`: todo lo estrictamente anterior a primera lectura +
      // 7 días). Todos los medidores del seed comparten inicio 09-01, pero el
      // cutoff se calcula por medidor para que la regla valga para cualquier
      // dataset. Se agrupa por el FK de Reading (meterId -> Meter.id); cada
      // bucket queda ordenado ascendentemente.
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
        // baselineWindow solo filtra; los elementos son las mismas filas Reading.
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