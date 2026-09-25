import { Router } from "express";
import type { PrismaClient } from "../../generated/prisma/client";
import { ApiError, formatZodIssues } from "../../shared/errors";
import { meterIdParam, readingsQuery } from "./reading.model";
import { createReadingsService } from "./reading.service";

export function createReadingsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service = createReadingsService(prisma);

  router.get("/:meterId/readings", async (req, res) => {
    const params = meterIdParam.safeParse(req.params);
    if (!params.success) {
      throw new ApiError(400, "VALIDATION_ERROR", formatZodIssues(params.error));
    }
    const query = readingsQuery.safeParse(req.query);
    if (!query.success) {
      throw new ApiError(400, "VALIDATION_ERROR", formatZodIssues(query.error));
    }
    // El query usa `page_size` (snake_case, contrato API); el dominio usa `pageSize`.
    res.json(
      await service.list(params.data.meterId, {
        from: query.data.from,
        to: query.data.to,
        page: query.data.page,
        pageSize: query.data.page_size,
      }),
    );
  });

  return router;
}