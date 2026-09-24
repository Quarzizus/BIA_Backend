import { Router } from "express";
import type { PrismaClient } from "../../generated/prisma/client";
import { createDashboardService } from "./dashboard.service";

export function createDashboardRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service = createDashboardService(prisma);

  router.get("/summary", async (_req, res) => {
    res.json(await service.summary());
  });

  return router;
}