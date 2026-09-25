import type { PrismaClient } from "../../generated/prisma/client";
import { ApiError } from "../../shared/errors";
import { toReadingDto } from "../../shared/domain/reading";
import { createReadingsRepository } from "./reading.repository";
import type { ReadingsListResponse, ReadingsQuery, ReadingsService } from "./reading.domain";

export function createReadingsService(prisma: PrismaClient): ReadingsService {
  const repository = createReadingsRepository(prisma);

  return {
    async list(meterId: string, query: ReadingsQuery): Promise<ReadingsListResponse> {
      const from = query.from ? new Date(query.from) : undefined;
      const to = query.to ? new Date(query.to) : undefined;

      // `from <= to` lo garantiza el refine de zod de readingsQuery (reading.model.ts).
      if (!(await repository.meterExists(meterId))) {
        throw new ApiError(404, "NOT_FOUND", `Meter ${meterId} not found`);
      }

      // findInRange devuelve TODO el rango (ascendente); la paginación ocurre
      // aquí: `total` cuenta el rango filtrado completo, antes de cortar.
      const readings = await repository.findInRange(meterId, from, to);
      const total = readings.length;
      const page = query.page;
      const pageSize = query.pageSize;
      const start = (page - 1) * pageSize;
      return {
        items: readings.slice(start, start + pageSize).map(toReadingDto),
        total,
        page,
        page_size: pageSize,
        has_more: page * pageSize < total,
      };
    },
  };
}