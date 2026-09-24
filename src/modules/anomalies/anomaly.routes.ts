import { Router } from "express";
import type { PrismaClient } from "../../generated/prisma/client";
import { ApiError, formatZodIssues } from "../../shared/errors";
import { anomalyIdParam, listQuery, statusUpdate } from "./anomaly.model";
import { createAnomalyService } from "./anomaly.service";

export function createAnomaliesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service = createAnomalyService(prisma);

  router.get("/", async (req, res) => {
    const query = listQuery.safeParse(req.query);
    if (!query.success) {
      throw new ApiError(400, "VALIDATION_ERROR", formatZodIssues(query.error));
    }
    res.json(await service.list(query.data));
  });

  router.get("/:id", async (req, res) => {
    const params = anomalyIdParam.safeParse(req.params);
    if (!params.success) {
      throw new ApiError(400, "VALIDATION_ERROR", formatZodIssues(params.error));
    }
    res.json(await service.detail(params.data.id));
  });

  router.patch("/:id/status", async (req, res) => {
    const params = anomalyIdParam.safeParse(req.params);
    if (!params.success) {
      throw new ApiError(400, "VALIDATION_ERROR", formatZodIssues(params.error));
    }
    const body = statusUpdate.safeParse(req.body);
    if (!body.success) {
      throw new ApiError(400, "VALIDATION_ERROR", formatZodIssues(body.error));
    }
    res.json(await service.updateStatus(params.data.id, body.data.status));
  });

  return router;
}