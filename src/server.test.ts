import { describe, expect, test } from "bun:test";
import { getPrisma } from "./config/database";
import { recoverOrphanedRuns } from "./server";

describe("recoverOrphanedRuns (boot sweep)", () => {
  test("marks orphaned RUNNING runs as FAILED and clears the lock token", async () => {
    const prisma = getPrisma();
    const run = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    try {
      const count = await recoverOrphanedRuns(prisma);
      expect(count).toBeGreaterThanOrEqual(1);

      const after = await prisma.analysisRun.findUnique({ where: { id: run.id } });
      expect(after!.status).toBe("FAILED");
      expect(after!.summary).toBe("recovered at boot");
      expect(after!.lockToken).toBeNull();
    } finally {
      await prisma.analysisRun.deleteMany({ where: { id: run.id } });
      await prisma.$disconnect();
    }
  });

  test("returns 0 when no RUNNING runs exist", async () => {
    const prisma = getPrisma();
    const count = await recoverOrphanedRuns(prisma);
    expect(count).toBe(0);
    await prisma.$disconnect();
  });
});