import express from "express";
import type { Express } from "express";
import type { PrismaClient } from "./generated/prisma/client";
import { errorMiddleware, notFoundHandler } from "./shared/errors";
import { createMetersRouter } from "./modules/meters/meter.routes";
import { createReadingsRouter } from "./modules/readings/reading.routes";
import { createAnomaliesRouter } from "./modules/anomalies/anomaly.routes";
import { createDashboardRouter } from "./modules/dashboard/dashboard.routes";
import { createAnalysisRouter, type AnalysisRouterDeps } from "./modules/analysis";

export interface AppOptions {
  analysis?: AnalysisRouterDeps;
}

/**
 * Factory de la app Express: parseo JSON, routers de features, 404 catch-all y
 * el middleware global de errores (P2025→404, P2002→409, zod→400).
 */
export function createApp(prisma: PrismaClient, options: AppOptions = {}): Express {
  const app = express();
  app.use(express.json());

  app.get("/", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/meters", createMetersRouter(prisma));
  app.use("/meters", createReadingsRouter(prisma));
  app.use("/anomalies", createAnomaliesRouter(prisma));
  app.use("/dashboard", createDashboardRouter(prisma));

  if (options.analysis) {
    app.use("/ai", createAnalysisRouter(prisma, options.analysis));
  }

  app.use(notFoundHandler);
  app.use(errorMiddleware);
  return app;
}