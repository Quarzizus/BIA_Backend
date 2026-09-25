import { Router } from "express";
import type { PrismaClient } from "../../generated/prisma/client";
import { ApiError } from "../../shared/errors";
import { createAnalysisService, type AnalysisDeps, type AnalysisService } from "./analysis.service";
import type { LlmClient } from "./llm/analysis.llm.client";
import { analysisIdParam, analyzeQuery } from "./analysis.model";

export interface AnalysisRouterDeps extends AnalysisDeps {
  llm: LlmClient;
}

/**
 * Rutas del ciclo de vida del análisis (tasks 3.8) — solo transporte:
 *  - POST /ai/analyze → 202 {analysis_id}; 503 AI_NOT_CONFIGURED; 409 ANALYSIS_IN_PROGRESS
 *  - GET  /ai/analysis/:id → status/summary/anomaly_count; 404
 *
 * El chequeo de configuración del LLM vive en el service (fail-fast antes de
 * crear el run); las rutas solo conectan HTTP con el service.
 */
export function createAnalysisRouter(
  prisma: PrismaClient,
  deps: AnalysisRouterDeps,
): Router {
  const router = Router();
  const service: AnalysisService = createAnalysisService(prisma, deps.llm, deps);

  router.post("/analyze", async (req, res) => {
    // Fail-fast ante mala configuración del LLM (spec ai-integration): sin
    // fallback silencioso — service.start() lanza 503 AI_NOT_CONFIGURED.
    // `?meter_id=M-109` opcional: el run analiza SOLO ese medidor.
    const query = analyzeQuery.safeParse(req.query);
    if (!query.success) {
      throw new ApiError(400, "VALIDATION_ERROR", query.error.message);
    }
    const options = query.data.meter_id ? { meterCodes: [query.data.meter_id] } : undefined;
    const run = await service.start(options);
    res.status(202).json({ analysis_id: run.id });
  });

  router.get("/analysis/:id", async (req, res) => {
    const params = analysisIdParam.safeParse(req.params);
    if (!params.success) {
      throw new ApiError(400, "VALIDATION_ERROR", params.error.message);
    }
    res.json(await service.getStatus(params.data.id));
  });

  return router;
}