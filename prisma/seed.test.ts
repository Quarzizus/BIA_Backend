import { beforeAll, expect, test } from "bun:test";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { seed } from "./seed";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL ?? "",
});
const prisma = new PrismaClient({ adapter });

beforeAll(async () => {
  // Fresh run, then an immediate re-run: the re-run must be a no-op (idempotent).
  await seed();
  await seed();
});

test("fresh seed loads 12 meters, 4032 readings and 4 events", async () => {
  expect(await prisma.meter.count()).toBe(12);
  expect(await prisma.reading.count()).toBe(4032);
  expect(await prisma.event.count()).toBe(4);
});

test("re-run seed is idempotent: same counts, no constraint violations", async () => {
  await seed(); // third invocation
  expect(await prisma.meter.count()).toBe(12);
  expect(await prisma.reading.count()).toBe(4032);
  expect(await prisma.event.count()).toBe(4);
});

test("naive CSV timestamps are normalized to UTC and values preserved", async () => {
  const spike = await prisma.reading.findFirst({
    where: {
      meter: { meterId: "M-109" },
      timestamp: new Date("2026-09-12T14:00:00.000Z"),
    },
  });
  expect(spike?.consumptionKwh).toBeCloseTo(110.35, 2);

  const outageEvent = await prisma.event.findFirst({
    where: { meter: { meterId: "M-106" } },
  });
  expect(outageEvent?.eventTimestamp.toISOString()).toBe(
    "2026-09-08T00:00:00.000Z",
  );
});