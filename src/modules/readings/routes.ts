import { Router } from "express";
import type { PrismaClient } from "../../generated/prisma/client";
import { ApiError, formatZodIssues } from "../../shared/errors";
import { meterIdParam, readingsQuery } from "./model";
import { createReadingsService } from "./service";

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
    res.json(await service.list(params.data.meterId, query.data));
  });

  return router;
}