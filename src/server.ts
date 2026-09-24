import type { PrismaClient } from "./generated/prisma/client";
import { loadEnv } from "./config/env";
import { getPrisma, pingDatabase } from "./config/database";
import { logger } from "./shared/logger";
import { createApp } from "./app";

/**
 * Boot sweep (design D3): orphaned RUNNING analysis runs (e.g. after a crash)
 * are marked FAILED and their lock token released so a new run can start.
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

  const app = createApp(prisma);
  app.listen(env.PORT, () => {
    logger.info("server listening", { port: env.PORT });
  });
}