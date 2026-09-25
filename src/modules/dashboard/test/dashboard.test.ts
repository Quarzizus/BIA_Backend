import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestPrisma, provisionTestDb, seedTestDb } from "../../../testing/testDb";
import { startTestServer, type TestServer } from "../../../testing/testServer";
import { createDashboardRouter } from "../dashboard.routes";

const prisma = createTestPrisma("bia_test_dashboard");
const FIXTURE_METERS = ["M-ZZ5", "M-ZZ6"];

let server: TestServer;
let runId: string;
let criticalAnomalyId: string;

beforeAll(async () => {
  await provisionTestDb("bia_test_dashboard");
  await seedTestDb(prisma);

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
    // Exacto: la base aislada solo contiene las anomalías de este fixture (1 HIGH
    // y 1 MEDIUM abiertas; la HIGH y la LOW resueltas quedan excluidas).
    expect(body.open_by_severity.HIGH).toBe(1);
    expect(body.open_by_severity.MEDIUM).toBe(1);
    expect(body.open_by_severity.LOW).toBe(0);
  });

  test("severity_counts incluye TODAS las anomalías, también RESOLVED (donut/KPI server-exacto)", async () => {
    const body = (await (await fetch(`${server.baseUrl}/dashboard/summary`)).json()) as Record<string, any>;
    // Fixture: HIGH OPEN + HIGH RESOLVED + MEDIUM OPEN + LOW RESOLVED → {2, 1, 1}.
    expect(body.severity_counts.HIGH).toBe(2);
    expect(body.severity_counts.MEDIUM).toBe(1);
    expect(body.severity_counts.LOW).toBe(1);
  });

  test("last_analysis expone fecha/hora y estado del run más reciente (KPI dashboard)", async () => {
    const body = (await (await fetch(`${server.baseUrl}/dashboard/summary`)).json()) as Record<string, any>;
    expect(body.last_analysis).not.toBeNull();
    expect(body.last_analysis.id).toBe(runId);
    expect(body.last_analysis.status).toBe("COMPLETED");
    expect(body.last_analysis.started_at).toBeDefined();
    expect(body.last_analysis).toHaveProperty("completed_at");
    expect(body.last_analysis).toHaveProperty("anomaly_count");
    // El run del fixture es global (sin scope) → meter_id null.
    expect(body.last_analysis.meter_id).toBeNull();
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