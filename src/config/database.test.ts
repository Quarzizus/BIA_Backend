import { describe, expect, test } from "bun:test";
import { getPrisma, pingDatabase } from "./database";

describe("database singleton", () => {
  test("getPrisma returns the same singleton instance", () => {
    expect(getPrisma()).toBe(getPrisma());
  });

  test("prisma client can reach the seeded database", async () => {
    await pingDatabase(getPrisma());
    const meterCount = await getPrisma().meter.count();
    expect(meterCount).toBe(12);
  });
});