import { Router } from "express";
import type { PrismaClient } from "../../generated/prisma/client";
import { ApiError } from "../../shared/errors";
import { createAnalysisService, type AnalysisDeps, type AnalysisService } from "./analysis.service";
import type { LlmClient } from "./llm/analysis.llm.client";
import { analysisIdParam } from "./analysis.model";

export interface AnalysisRouterDeps extends AnalysisDeps {
  llm: LlmClient;
}

/**
 * Analysis lifecycle routes (tasks 3.8) — transport only:
 *  - POST /ai/analyze → 202 {analysis_id}; 503 AI_NOT_CONFIGURED; 409 ANALYSIS_IN_PROGRESS
 *  - GET  /ai/analysis/:id → status/summary/anomaly_count; 404
 *
 * The LLM-configuration check lives in the service (fail-fast before creating
 * the run); the routes only wire HTTP to the service.
 */
export function createAnalysisRouter(
  prisma: PrismaClient,
  deps: AnalysisRouterDeps,
): Router {
  const router = Router();
  const service: AnalysisService = createAnalysisService(prisma, deps.llm, deps);

  router.post("/analyze", async (_req, res) => {
    // Fail-fast on LLM misconfiguration (spec ai-integration): no silent
    // fallback — service.start() throws 503 AI_NOT_CONFIGURED.
    const run = await service.start();
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