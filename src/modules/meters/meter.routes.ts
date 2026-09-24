import { Router } from "express";
import type { PrismaClient } from "../../generated/prisma/client";
import { ApiError, formatZodIssues } from "../../shared/errors";
import { meterIdParam } from "./meter.model";
import { createMeterService } from "./meter.service";

export function createMetersRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service = createMeterService(prisma);

  router.get("/", async (_req, res) => {
    res.json(await service.list());
  });

  router.get("/:meterId", async (req, res) => {
    const parsed = meterIdParam.safeParse(req.params);
    if (!parsed.success) {
      throw new ApiError(400, "VALIDATION_ERROR", formatZodIssues(parsed.error));
    }
    res.json(await service.detail(parsed.data.meterId));
  });

  return router;
}