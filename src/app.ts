import { PrismaClient } from "./generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[boot] DATABASE_URL environment variable is required");
  process.exit(1);
}

const adapter = new PrismaPg({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter });

/**
 * Verifies database connectivity by running a trivial query.
 * Feature routes and the full express app arrive in a later slice (PR2).
 */
export async function verifyDatabaseConnection(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);

  try {
    await verifyDatabaseConnection();
    console.log("[boot] database connectivity OK");
  } catch (error) {
    console.error("[boot] database connectivity FAILED:", error);
    process.exit(1);
  }

  Bun.serve({
    port,
    fetch() {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  console.log(`[boot] listening on :${port}`);
}