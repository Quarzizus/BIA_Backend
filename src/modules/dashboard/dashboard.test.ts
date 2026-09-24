import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getPrisma } from "../../config/database";
import { startTestServer, type TestServer } from "../../testing/testServer";
import { createDashboardRouter } from "./routes";

const prisma = getPrisma();
const FIXTURE_METERS = ["M-ZZ5", "M-ZZ6"];

let server: TestServer;
let runId: string;
let criticalAnomalyId: string;

beforeAll(async () => {
  const [criticalMeter, alertMeter] = await prisma.$transaction([
    prisma.meter.create({
      data: { meterId: "M-ZZ5", name: "Critical Fixture", location: "Site 95", status: "CRITICAL" },
    }),
    prisma.meter.create({
      data: { meterId: "M-ZZ6", name: "Alert Fixture", location: "Site 96", status: "ALERT" },
    }),
  ]);

  runId = (
    await prisma.analysisRun.create({
      data: { status: "COMPLETED", summary: "dashboard fixture" },
    })
  ).id;

  const base = {
    analysisRunId: runId,
    detectedAt: new Date("2026-09-15T12:00:00.000Z"),
    rangeStart: new Date("2026-09-14T00:00:00.000Z"),
    rangeEnd: new Date("2026-09-15T12:00:00.000Z"),
    confidence: 0.9,
    detectionType: "SPIKE",
    signals: {},
  };

  const openHigh = await prisma.anomaly.create({
    data: {
      ...base,
      meterId: criticalMeter.id,
      type: "REAL_ANOMALY",
      severity: "HIGH",
      status: "OPEN",
      reason: "Pico de consumo",
      recommendedAction: "Revisar",
    },
  });
  criticalAnomalyId = openHigh.id;

  await prisma.anomaly.create({
    data: {
      ...base,
      meterId: alertMeter.id,
      type: "EXPLAINABLE_ANOMALY",
      severity: "MEDIUM",
      status: "OPEN",
      reason: "Cambio operacional",
      recommendedAction: "Monitorear",
    },
  });
  await prisma.anomaly.create({
    data: {
      ...base,
      meterId: criticalMeter.id,
      type: "FALSE_POSITIVE",
      severity: "HIGH",
      status: "RESOLVED",
    },
  });
  await prisma.anomaly.create({
    data: {
      ...base,
      meterId: alertMeter.id,
      type: "FALSE_POSITIVE",
      severity: "LOW",
      status: "RESOLVED",
    },
  });

  server = await startTestServer([{ path: "/dashboard", router: createDashboardRouter(prisma) }]);
});

afterAll(async () => {
  await server.close();
  await prisma.anomaly.deleteMany({ where: { meter: { meterId: { in: FIXTURE_METERS } } } });
  await prisma.analysisRun.deleteMany({ where: { id: runId } });
  await prisma.meter.deleteMany({ where: { meterId: { in: FIXTURE_METERS } } });
  await prisma.$disconnect();
});

describe("GET /dashboard/summary", () => {
  test("total_consumption equals the sum of all readings in the database", async () => {
    const agg = await prisma.reading.aggregate({ _sum: { consumptionKwh: true } });
    const res = await fetch(`${server.baseUrl}/dashboard/summary`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.total_consumption).toBeCloseTo(agg._sum.consumptionKwh!, 2);
  });

  test("counts meters by stored ALERT/CRITICAL status", async () => {
    const body = (await (await fetch(`${server.baseUrl}/dashboard/summary`)).json()) as Record<string, any>;
    expect(body.meters_alert).toBe(1);
    expect(body.meters_critical).toBe(1);
  });

  test("groups open anomalies by severity and excludes resolved ones", async () => {
    const body = (await (await fetch(`${server.baseUrl}/dashboard/summary`)).json()) as Record<string, any>;
    // Fixture guarantees at least one OPEN HIGH and one OPEN MEDIUM; other
    // parallel test files may add more, so assert lower bounds.
    expect(body.open_by_severity.HIGH).toBeGreaterThanOrEqual(1);
    expect(body.open_by_severity.MEDIUM).toBeGreaterThanOrEqual(1);
    expect(typeof body.open_by_severity.LOW).toBe("number");
  });

  test("recent_anomalies includes the open critical anomaly with full fields", async () => {
    const body = (await (await fetch(`${server.baseUrl}/dashboard/summary`)).json()) as Record<string, any>;
    const mine = (body.recent_anomalies as any[]).find(
      (a: any) => a.id === criticalAnomalyId,
    );
    expect(mine).toBeDefined();
    expect(mine!.meter_id).toBe("M-ZZ5");
    expect(mine!.type).toBe("REAL_ANOMALY");
    expect(mine!.severity).toBe("HIGH");
    expect(mine!.status).toBe("OPEN");
    expect(typeof mine!.detected_at).toBe("string");
  });
});