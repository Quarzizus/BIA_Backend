import type { PrismaClient } from "../../generated/prisma/client";
import type { Reading } from "../../generated/prisma/client";
import { ApiError } from "../../shared/errors";
import { createReadingsRepository } from "./repository";
import type { ReadingDto } from "./model";

function toReadingDto(reading: Reading): ReadingDto {
  return {
    timestamp: reading.timestamp.toISOString(),
    consumption_kwh: reading.consumptionKwh,
    voltage_v: reading.voltageV,
    current_a: reading.currentA,
    power_factor: reading.powerFactor,
    status: reading.status,
  };
}

export interface ReadingsService {
  list(meterId: string, range: { from?: string; to?: string }): Promise<ReadingDto[]>;
}

export function createReadingsService(prisma: PrismaClient): ReadingsService {
  const repository = createReadingsRepository(prisma);

  return {
    async list(meterId: string, range: { from?: string; to?: string }): Promise<ReadingDto[]> {
      const from = range.from ? new Date(range.from) : undefined;
      const to = range.to ? new Date(range.to) : undefined;

      if (from && to && from.getTime() > to.getTime()) {
        throw new ApiError(400, "VALIDATION_ERROR", "from must not be after to");
      }

      if (!(await repository.meterExists(meterId))) {
        throw new ApiError(404, "NOT_FOUND", `Meter ${meterId} not found`);
      }

      const readings = await repository.findInRange(meterId, from, to);
      return readings.map(toReadingDto);
    },
  };
}