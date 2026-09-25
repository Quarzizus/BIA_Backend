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
    // El query usa snake_case (contrato API); el dominio usa `meterCode` y
    // `pageSize` (camelCase) para dejar claro qué es cada campo.
    res.json(
      await service.list({
        status: query.data.status,
        severity: query.data.severity,
        sort: query.data.sort,
        type: query.data.type,
        meterCode: query.data.meter_id,
        page: query.data.page,
        pageSize: query.data.page_size,
      }),
    );
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