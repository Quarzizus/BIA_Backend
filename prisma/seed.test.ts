import { afterAll, beforeAll, expect, test } from "bun:test";

// La URL aislada debe quedar fija ANTES de importar ./seed: su adapter Prisma
// se construye en tiempo de módulo (const DATABASE_URL en la raíz del módulo),
// así que un import estático capturaría la bia_dev del .env. Los archivos de
// test corren en procesos separados, de modo que este cambio no fuga hacia
// otros tests. El esquema de URL replica testDbUrl() (mismo servidor de compose).
process.env.DATABASE_URL = "postgresql://bia:bia@localhost:5432/bia_test_seed";

const { seed } = await import("./seed");
const { createTestPrisma, provisionTestDb } = await import("../src/testing/testDb");

const prisma = createTestPrisma("bia_test_seed");

beforeAll(async () => {
  await provisionTestDb("bia_test_seed");
  // Seed fresco, luego un re-run inmediato: el re-run debe ser un no-op (idempotente).
  await seed();
  await seed();
});

afterAll(async () => {
  await prisma.$disconnect();
});

test("fresh seed loads 12 meters, 4032 readings and 4 events", async () => {
  expect(await prisma.meter.count()).toBe(12);
  expect(await prisma.reading.count()).toBe(4032);
  expect(await prisma.event.count()).toBe(4);
});

test("re-run seed is idempotent: same counts, no constraint violations", async () => {
  await seed();
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