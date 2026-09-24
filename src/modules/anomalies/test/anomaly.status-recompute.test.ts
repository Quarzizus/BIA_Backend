import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestPrisma, provisionTestDb, seedTestDb } from "../../../testing/testDb";
import { startTestServer, type TestServer } from "../../../testing/testServer";
import { createAnomaliesRouter } from "../anomaly.routes";
import { createDashboardRouter } from "../../dashboard/dashboard.routes";

/**
 * Diseño D4: Meter.status se mantiene en la MISMA transacción que las escrituras
 * de anomalías. En una transición PATCH el medidor debe reflejar la anomalía
 * ACTIVE (no RESOLVED) más severa: HIGH -> CRITICAL, MEDIUM -> ALERT, si no
 * NORMAL. El WARNING 1 verificó que PATCH nunca recalculaba Meter.status,
 * dejando GET /dashboard/summary obsoleto (meters_critical atascado en 1 con
 * open_by_severity.HIGH 0). Estos tests fijan el contrato corregido.
 */
const prisma = createTestPrisma("bia_test_status");
const FIXTURE_METERS = ["M-ZZ7", "M-ZZ8"];

let server: TestServer;
let runId: string;
let highMeterId: string;
let mediumMeterId: string;
let highAnomalyId: string;
let mediumAnomalyId: string;

beforeAll(async () => {
  await provisionTestDb("bia_test_status");
  await seedTestDb(prisma);

  const [highMeter, mediumMeter] = await prisma.$transaction([
    prisma.meter.create({
      data: { meterId: "M-ZZ7", name: "Recompute Critical", location: "Site 97", status: "CRITICAL" },
    }),
    prisma.meter.create({
      data: { meterId: "M-ZZ8", name: "Recompute Alert", location: "Site 98", status: "ALERT" },
    }),
  ]);
  highMeterId = highMeter.id;
  mediumMeterId = mediumMeter.id;

  runId = (
    await prisma.analysisRun.create({
      data: { status: "COMPLETED", summary: "recompute fixture run" },
    })
  ).id;

  const base = {
    analysisRunId: runId,
    detectedAt: new Date("2026-09-16T10:00:00.000Z"),
    rangeStart: new Date("2026-09-15T00:00:00.000Z"),
    rangeEnd: new Date("2026-09-16T10:00:00.000Z"),
    confidence: 0.99,
    status: "OPEN" as const,
    detectionType: "SPIKE",
    signals: {},
  };

  const high = await prisma.anomaly.create({
    data: {
      ...base,
      meterId: highMeter.id,
      type: "REAL_ANOMALY",
      severity: "HIGH",
      reason: "Pico de consumo",
      recommendedAction: "Revisar instalación",
    },
  });
  highAnomalyId = high.id;

  const medium = await prisma.anomaly.create({
    data: {
      ...base,
      meterId: mediumMeter.id,
      type: "EXPLAINABLE_ANOMALY",
      severity: "MEDIUM",
      reason: "Cambio operacional",
      recommendedAction: "Monitorear",
    },
  });
  mediumAnomalyId = medium.id;

  server = await startTestServer([
    { path: "/anomalies", router: createAnomaliesRouter(prisma) },
    { path: "/dashboard", router: createDashboardRouter(prisma) },
  ]);
});

afterAll(async () => {
  await server.close();
  await prisma.anomaly.deleteMany({ where: { meter: { meterId: { in: FIXTURE_METERS } } } });
  await prisma.analysisRun.deleteMany({ where: { id: runId } });
  await prisma.meter.deleteMany({ where: { meterId: { in: FIXTURE_METERS } } });
  await prisma.$disconnect();
});

describe("PATCH /anomalies/:id/status recomputes Meter.status (design D4)", () => {
  test("OPEN -> INVESTIGATING keeps CRITICAL while the HIGH anomaly is still active", async () => {
    const res = await fetch(`${server.baseUrl}/anomalies/${highAnomalyId}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "INVESTIGATING" }),
    });
    expect(res.status).toBe(200);

    const meter = await prisma.meter.findUnique({ where: { id: highMeterId } });
    expect(meter!.status).toBe("CRITICAL");
  });

  test("INVESTIGATING -> RESOLVED recomputes meter to NORMAL and dashboard counts drop to 0", async () => {
    const res = await fetch(`${server.baseUrl}/anomalies/${highAnomalyId}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "RESOLVED" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.status).toBe("RESOLVED");

    const meter = await prisma.meter.findUnique({ where: { id: highMeterId } });
    expect(meter!.status).toBe("NORMAL");

    // GET /dashboard/summary debe reflejar ahora las anomalías abiertas: la
    // única HIGH está resuelta, la MEDIUM de M-ZZ8 sigue abierta.
    const summary = (await (
      await fetch(`${server.baseUrl}/dashboard/summary`)
    ).json()) as Record<string, any>;
    expect(summary.meters_critical).toBe(0);
    expect(summary.meters_alert).toBe(1);
    expect(summary.open_by_severity.HIGH).toBe(0);
    expect(summary.open_by_severity.MEDIUM).toBe(1);
  });

  test("resolving a HIGH leaves ALERT when a MEDIUM is still open (most severe open anomaly)", async () => {
    // Simular un segundo run sobre el medidor medium: se añade una HIGH mientras
    // la MEDIUM sigue abierta; la finalización del run subió el medidor a CRITICAL.
    const extraHigh = await prisma.anomaly.create({
      data: {
        analysisRunId: runId,
        meterId: mediumMeterId,
        detectedAt: new Date("2026-09-17T10:00:00.000Z"),
        rangeStart: new Date("2026-09-16T00:00:00.000Z"),
        rangeEnd: new Date("2026-09-17T10:00:00.000Z"),
        confidence: 0.99,
        status: "OPEN",
        type: "REAL_ANOMALY",
        severity: "HIGH",
        detectionType: "SPIKE",
        signals: {},
        reason: "Segundo pico",
        recommendedAction: "Revisar",
      },
    });
    await prisma.meter.update({
      where: { id: mediumMeterId },
      data: { status: "CRITICAL" },
    });

    const chain: Array<"INVESTIGATING" | "RESOLVED"> = ["INVESTIGATING", "RESOLVED"];
    for (const step of chain) {
      const res = await fetch(`${server.baseUrl}/anomalies/${extraHigh.id}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: step }),
      });
      expect(res.status).toBe(200);
    }

    // La anomalía MEDIUM sigue abierta, así que el medidor NO debe caer a NORMAL.
    const meter = await prisma.meter.findUnique({ where: { id: mediumMeterId } });
    expect(meter!.status).toBe("ALERT");

    const summary = (await (
      await fetch(`${server.baseUrl}/dashboard/summary`)
    ).json()) as Record<string, any>;
    expect(summary.meters_critical).toBe(0);
    expect(summary.meters_alert).toBe(1);
    expect(summary.open_by_severity.HIGH).toBe(0);
    expect(summary.open_by_severity.MEDIUM).toBe(1);
  });

  test("resolving the last MEDIUM drops the meter to NORMAL and clears the alert", async () => {
    const chain: Array<"INVESTIGATING" | "RESOLVED"> = ["INVESTIGATING", "RESOLVED"];
    for (const step of chain) {
      const res = await fetch(`${server.baseUrl}/anomalies/${mediumAnomalyId}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: step }),
      });
      expect(res.status).toBe(200);
    }

    const meter = await prisma.meter.findUnique({ where: { id: mediumMeterId } });
    expect(meter!.status).toBe("NORMAL");

    const summary = (await (
      await fetch(`${server.baseUrl}/dashboard/summary`)
    ).json()) as Record<string, any>;
    expect(summary.meters_critical).toBe(0);
    expect(summary.meters_alert).toBe(0);
    expect(summary.open_by_severity.HIGH).toBe(0);
    expect(summary.open_by_severity.MEDIUM).toBe(0);
    expect(summary.open_by_severity.LOW).toBe(0);
  });
});