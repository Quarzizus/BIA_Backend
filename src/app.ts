import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import type { Express } from "express";
import cors from "cors";
import { toNodeHandler } from "better-auth/node";
import type { PrismaClient } from "./generated/prisma/client";
import { apiReference } from "@scalar/express-api-reference";
import { createAuth } from "./config/auth";
import { createRequireAuth } from "./shared/auth";
import { errorMiddleware, notFoundHandler } from "./shared/errors";
import { createMetersRouter } from "./modules/meters/meter.routes";
import { createReadingsRouter } from "./modules/readings/reading.routes";
import { createAnomaliesRouter } from "./modules/anomalies/anomaly.routes";
import { createDashboardRouter } from "./modules/dashboard/dashboard.routes";
import { createAnalysisRouter, type AnalysisRouterDeps } from "./modules/analysis";
import { createImportsRouter } from "./modules/imports";

export interface AppOptions {
  analysis?: AnalysisRouterDeps;
}

// Spec OpenAPI leída una vez al cargar el módulo (fuente única de las docs).
const OPENAPI_PATH = join(import.meta.dir, "../docs/openapi.yaml");
const OPENAPI_SPEC = readFileSync(OPENAPI_PATH, "utf8");

/**
 * Factory de la app Express: parseo JSON, routers de features, docs de la API
 * (Scalar en /docs + spec cruda en /openapi.yaml), 404 catch-all y el middleware
 * global de errores (P2025→404, P2002→409, zod→400).
 *
 * Autenticación (Opción A): el handler de better-auth se monta en `/api/auth/*`
 * ANTES del body parser (consume el stream de la petición) y las rutas públicas
 * (`/`, `/docs`, `/openapi.yaml`) quedan libres; TODAS las rutas de negocio se
 * protegen con `requireAuth` (cookie de sesión httpOnly, sin Bearer).
 */
export function createApp(prisma: PrismaClient, options: AppOptions = {}): Express {
  const app = express();
  const auth = createAuth(prisma);
  // F11: CORS abierto para el MVP — el frontend puede llamar directo al backend
  // (el proxy sigue siendo una opción válida).
  app.use(cors());

  // better-auth antes de express.json(): los body parsers consumen el stream y
  // romperían el parseo interno del handler de auth.
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(express.json());

  app.get("/", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Docs siempre disponibles (sin gate de entorno).
  app.get("/openapi.yaml", (_req, res) => {
    res.type("application/yaml").send(OPENAPI_SPEC);
  });
  app.use("/docs", apiReference({ url: "/openapi.yaml" }));

  // A partir de aquí todo requiere sesión: rutas de negocio protegidas.
  const requireAuth = createRequireAuth(auth);

  app.use("/meters", requireAuth, createMetersRouter(prisma));
  app.use("/meters", requireAuth, createReadingsRouter(prisma));
  app.use("/anomalies", requireAuth, createAnomaliesRouter(prisma));
  app.use("/dashboard", requireAuth, createDashboardRouter(prisma));
  app.use("/readings", requireAuth, createImportsRouter(prisma));

  if (options.analysis) {
    app.use("/ai", requireAuth, createAnalysisRouter(prisma, options.analysis));
  }

  app.use(notFoundHandler);
  app.use(errorMiddleware);
  return app;
}