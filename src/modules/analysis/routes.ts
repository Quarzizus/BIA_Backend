import { Router } from "express";
import type { PrismaClient } from "../../generated/prisma/client";
import { ApiError } from "../../shared/errors";
import { createAnalysisService, type AnalysisDeps, type AnalysisService } from "./analysis.service";
import type { LlmClient } from "./llm.client";
import { z } from "zod";

const analysisIdParam = z.object({
  id: z.string().min(1, "id is required"),
});

export interface AnalysisRouterDeps extends AnalysisDeps {
  llm: LlmClient;
}

/**
 * Analysis lifecycle routes (tasks 3.8):
 *  - POST /ai/analyze → 202 {analysis_id}; 503 AI_NOT_CONFIGURED; 409 ANALYSIS_IN_PROGRESS
 *  - GET  /ai/analysis/:id → status/summary/anomaly_count; 404
 */
export function createAnalysisRouter(
  prisma: PrismaClient,
  deps: AnalysisRouterDeps,
): Router {
  const router = Router();
  const service: AnalysisService = createAnalysisService(prisma, deps.llm, deps);

  router.post("/analyze", async (_req, res) => {
    // Fail-fast on LLM misconfiguration (spec ai-integration): no silent fallback.
    if (!deps.AI_API_KEY || !deps.AI_BASE_URL || !deps.AI_MODEL) {
      throw new ApiError(
        503,
        "AI_NOT_CONFIGURED",
        "LLM is not configured: AI_API_KEY, AI_BASE_URL and AI_MODEL are required",
      );
    }
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