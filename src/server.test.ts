import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestPrisma, provisionTestDb, seedTestDb } from "./testing/testDb";
import { recoverOrphanedRuns } from "./server";

const prisma = createTestPrisma("bia_test_server");

beforeAll(async () => {
  await provisionTestDb("bia_test_server");
  await seedTestDb(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("recoverOrphanedRuns (boot sweep)", () => {
  test("marks orphaned RUNNING runs as FAILED and clears the lock token", async () => {
    const run = await prisma.analysisRun.create({
      data: { status: "RUNNING", lockToken: "single" },
    });
    try {
      const count = await recoverOrphanedRuns(prisma);
      // Exacto: la base aislada solo contiene el run RUNNING creado arriba.
      expect(count).toBe(1);

      const after = await prisma.analysisRun.findUnique({ where: { id: run.id } });
      expect(after!.status).toBe("FAILED");
      expect(after!.summary).toBe("recovered at boot");
      expect(after!.lockToken).toBeNull();
    } finally {
      await prisma.analysisRun.deleteMany({ where: { id: run.id } });
    }
  });

  test("returns 0 when no RUNNING runs exist", async () => {
    const count = await recoverOrphanedRuns(prisma);
    expect(count).toBe(0);
  });
});