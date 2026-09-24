import type { PrismaClient } from "../../generated/prisma/client";
import { ApiError } from "../../shared/errors";
import { toReadingDto, type ReadingDto } from "../../shared/domain/reading";
import { createReadingsRepository } from "./reading.repository";
import type { ReadingsService } from "./reading.domain";

export function createReadingsService(prisma: PrismaClient): ReadingsService {
  const repository = createReadingsRepository(prisma);

  return {
    async list(meterId: string, range: { from?: string; to?: string }): Promise<ReadingDto[]> {
      const from = range.from ? new Date(range.from) : undefined;
      const to = range.to ? new Date(range.to) : undefined;

      // `from <= to` is enforced by the readingsQuery zod refine (reading.model.ts).
      if (!(await repository.meterExists(meterId))) {
        throw new ApiError(404, "NOT_FOUND", `Meter ${meterId} not found`);
      }

      const readings = await repository.findInRange(meterId, from, to);
      return readings.map(toReadingDto);
    },
  };
}