import express from "express";
import type { Express } from "express";
import type { PrismaClient } from "./generated/prisma/client";
import { errorMiddleware, notFoundHandler } from "./shared/errors";
import { createMetersRouter } from "./modules/meters/routes";
import { createReadingsRouter } from "./modules/readings/routes";
import { createAnomaliesRouter } from "./modules/anomalies/routes";
import { createDashboardRouter } from "./modules/dashboard/routes";

/**
 * Express app factory: JSON parsing, feature routers, catch-all 404 and the
 * global error middleware (P2025→404, P2002→409, zod→400).
 */
export function createApp(prisma: PrismaClient): Express {
  const app = express();
  app.use(express.json());

  app.get("/", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/meters", createMetersRouter(prisma));
  app.use("/meters", createReadingsRouter(prisma));
  app.use("/anomalies", createAnomaliesRouter(prisma));
  app.use("/dashboard", createDashboardRouter(prisma));

  app.use(notFoundHandler);
  app.use(errorMiddleware);
  return app;
}