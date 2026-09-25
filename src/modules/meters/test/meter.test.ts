import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestPrisma, provisionTestDb, seedTestDb } from "../../../testing/testDb";
import { startTestServer, type TestServer } from "../../../testing/testServer";
import { createMetersRouter } from "../meter.routes";

const prisma = createTestPrisma("bia_test_meters");
let server: TestServer;
let fixtureMeterId: string | undefined;

beforeAll(async () => {
  await provisionTestDb("bia_test_meters");
  await seedTestDb(prisma);

  // Fixture: un medidor sin lecturas (spec meters-api "Meter without readings").
  const fixture = await prisma.meter.create({
    data: { meterId: "M-ZZ0", name: "Fixture No Readings", location: "Site 99" },
  });
  fixtureMeterId = fixture.id;
  server = await startTestServer([{ path: "/meters", router: createMetersRouter(prisma) }]);
});

afterAll(async () => {
  await server.close();
  if (fixtureMeterId) {
    await prisma.meter.delete({ where: { id: fixtureMeterId } }).catch(() => {});
  }
  await prisma.$disconnect();
});

describe("GET /meters", () => {
  test("returns all meters ordered by meter_id with latest consumption and variation", async () => {
    const res = await fetch(`${server.baseUrl}/meters`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    // Exacto: la base aislada solo contiene los 12 sembrados + este fixture.
    expect(body).toHaveLength(13);

    expect(body[0]!.meter_id).toBe("M-101");
    const m109 = body.find((m) => m.meter_id === "M-109");
    expect(m109).toBeDefined();
    expect(m109!.status).toBe("NORMAL");
    // Última lectura sembrada de M-109: 86.89 kWh a las 2026-09-14 23:00 UTC.
    expect(m109!.consumption_kwh).toBeCloseTo(86.89, 2);
    expect(m109!.latest_reading_at).toBe("2026-09-14T23:00:00.000Z");
    // Variación vs la media del baseline de primeros 7 días (43.6998): +98.83%.
    expect(m109!.variation_pct).toBeCloseTo(98.8, 0);
  });

  test("returns nulls for a meter without readings", async () => {
    const res = await fetch(`${server.baseUrl}/meters`);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    const fixture = body.find((m) => m.meter_id === "M-ZZ0");
    expect(fixture).toBeDefined();
    expect(fixture!.consumption_kwh).toBeNull();
    expect(fixture!.variation_pct).toBeNull();
    expect(fixture!.latest_reading_at).toBeNull();
  });
});

describe("GET /meters/:meterId", () => {
  test("returns baseline stats and current reading for M-109 (no history)", async () => {
    const res = await fetch(`${server.baseUrl}/meters/M-109`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;

    expect(body.meter_id).toBe("M-109");
    expect(body.baseline.consumption_kwh.mean).toBeCloseTo(43.7, 2);
    expect(body.baseline.consumption_kwh.std).toBeCloseTo(7.58, 1);
    expect(body.baseline.voltage_v.mean).not.toBeNull();
    expect(body.baseline.current_a.mean).not.toBeNull();
    expect(body.baseline.power_factor.mean).not.toBeNull();

    expect(body.current.consumption_kwh).toBeCloseTo(86.89, 2);
    expect(body.current.timestamp).toBe("2026-09-14T23:00:00.000Z");
    expect(body.variation_pct).toBeCloseTo(98.8, 0);

    // Contrato actual: el detalle NO expone `history`; el frontend carga las
    // lecturas paginadas vía GET /meters/:meterId/readings.
    expect("history" in body).toBe(false);
  });

  test("returns null current/baseline for a meter without readings (no history)", async () => {
    const res = await fetch(`${server.baseUrl}/meters/M-ZZ0`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.current).toBeNull();
    expect(body.baseline.consumption_kwh.mean).toBeNull();
    expect(body.variation_pct).toBeNull();
    expect("history" in body).toBe(false);
  });

  test("returns 404 NOT_FOUND for an unknown meter", async () => {
    const res = await fetch(`${server.baseUrl}/meters/M-999`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("NOT_FOUND");
  });
});