import type { PrismaClient } from "../../generated/prisma/client";
import { ApiError } from "../../shared/errors";
import { toReadingDto } from "../../shared/domain/reading";
import { computeBaselineStats, variationPct } from "../../shared/domain/baseline";
import { createMeterRepository } from "./meter.repository";
import type { MeterDetail, MeterService, MeterSummary } from "./meter.domain";

function groupBy<T, K extends string>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k) ?? [];
    bucket.push(item);
    map.set(k, bucket);
  }
  return map;
}

export function createMeterService(prisma: PrismaClient): MeterService {
  const repository = createMeterRepository(prisma);

  return {
    async list(): Promise<MeterSummary[]> {
      const meters = await repository.listMeters();
      const meterCodes = meters.map((meter) => meter.meterId);
      const [latest, baselineReadings] = await Promise.all([
        repository.latestReadings(meterCodes),
        repository.baselineReadings(meterCodes),
      ]);

      const latestByCode = new Map(latest.map((reading) => [reading.meterId, reading]));
      const baselineMeanByCode = new Map<string, number | null>();
      for (const [id, readings] of groupBy(baselineReadings, (r) => r.meterId)) {
        baselineMeanByCode.set(id, computeBaselineStats(readings).consumption_kwh.mean);
      }

      return meters.map((meter) => {
        // Reading.meterId es el FK al Meter.id interno (NO el código de
        // medidor); los métodos del repositorio reciben códigos y traducen vía
        // la relación. Keyed por meter.id — el FK que llevan las readings.
        const current = latestByCode.get(meter.id);
        const baselineMean = baselineMeanByCode.get(meter.id) ?? null;
        return {
          id: meter.id,
          meter_id: meter.meterId,
          name: meter.name,
          location: meter.location,
          status: meter.status,
          consumption_kwh: current?.consumptionKwh ?? null,
          variation_pct: variationPct(current?.consumptionKwh ?? null, baselineMean),
          latest_reading_at: current?.timestamp.toISOString() ?? null,
        };
      });
    },

    async detail(meterId: string): Promise<MeterDetail> {
      const meter = await repository.findMeterByCode(meterId);
      if (!meter) {
        throw new ApiError(404, "NOT_FOUND", `Meter ${meterId} not found`);
      }

      const [history, baselineReadings] = await Promise.all([
        repository.history(meter.meterId),
        repository.baselineReadings([meter.meterId]),
      ]);

      const baseline = computeBaselineStats(baselineReadings);
      const current = history.length > 0 ? history[history.length - 1] : null;

      return {
        id: meter.id,
        meter_id: meter.meterId,
        name: meter.name,
        location: meter.location,
        status: meter.status,
        current: current
          ? {
              consumption_kwh: current.consumptionKwh,
              voltage_v: current.voltageV,
              current_a: current.currentA,
              power_factor: current.powerFactor,
              timestamp: current.timestamp.toISOString(),
              status: current.status,
            }
          : null,
        baseline,
        variation_pct: variationPct(current?.consumptionKwh ?? null, baseline.consumption_kwh.mean),
        history: history.map(toReadingDto),
      };
    },
  };
}