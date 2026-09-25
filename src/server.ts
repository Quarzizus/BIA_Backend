import type { PrismaClient } from "./generated/prisma/client";
import { loadEnv } from "./config/env";
import { getPrisma, pingDatabase } from "./config/database";
import { logger } from "./shared/logger";
import { createApp } from "./app";
import { createLlmClient } from "./modules/analysis";

/**
 * Barrido de arranque (diseño D3): los análisis RUNNING huérfanos (p. ej. tras
 * un crash) se marcan como FAILED y se libera su lock para que un nuevo run
 * pueda empezar.
 */
export async function recoverOrphanedRuns(prisma: PrismaClient): Promise<number> {
  const result = await prisma.analysisRun.updateMany({
    where: { status: "RUNNING" },
    data: { status: "FAILED", summary: "recovered at boot", lockToken: null },
  });
  return result.count;
}

if (import.meta.main) {
  const env = loadEnv();
  const prisma = getPrisma();

  await pingDatabase(prisma);
  logger.info("database connectivity OK");

  const recovered = await recoverOrphanedRuns(prisma);
  if (recovered > 0) {
    logger.info("boot sweep recovered orphaned runs", { count: recovered });
  }

  const app = createApp(prisma, {
    analysis: {
      AI_API_KEY: env.AI_API_KEY,
      AI_BASE_URL: env.AI_BASE_URL,
      AI_MODEL: env.AI_MODEL,
      llm: createLlmClient(env),
    },
  });
  const server = app.listen(env.PORT, () => {
    logger.info("server listening", { port: env.PORT });
  });

  // F11: shutdown graceful — cierra el HTTP server, desconecta Prisma y sale
  // con 0. Si algo se cuelga, un timeout fuerza la salida (exit 1).
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });
    const forceExit = setTimeout(() => {
      logger.error("forced exit: shutdown timed out");
      process.exit(1);
    }, 10_000);
    forceExit.unref();
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}