import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getPrisma } from "../../../config/database";
import { startTestServer, type TestServer } from "../../../testing/testServer";
import { createAnomaliesRouter } from "../anomaly.routes";
import { createDashboardRouter } from "../../dashboard/dashboard.routes";

/**
 * Design D4: Meter.status is maintained in the SAME transaction as anomaly
 * writes. On a PATCH transition the meter must reflect the most severe
 * ACTIVE (not RESOLVED) anomaly: HIGH -> CRITICAL, MEDIUM -> ALERT, else
 * NORMAL. Verify WARNING 1 proved PATCH never recomputed Meter.status, leaving
 * GET /dashboard/summary stale (meters_critical stuck at 1 with
 * open_by_severity.HIGH 0). These tests lock the corrected contract.
 */
const prisma = getPrisma();
const FIXTURE_METERS = ["M-ZZ7", "M-ZZ8"];

let server: TestServer;
let runId: string;
let highMeterId: string;
let mediumMeterId: string;
let highAnomalyId: string;
let mediumAnomalyId: string;

beforeAll(async () => {
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

    // GET /dashboard/summary must now reflect the open anomalies: the only
    // HIGH is resolved, the MEDIUM on M-ZZ8 is still open.
    const summary = (await (
      await fetch(`${server.baseUrl}/dashboard/summary`)
    ).json()) as Record<string, any>;
    expect(summary.meters_critical).toBe(0);
    expect(summary.meters_alert).toBe(1);
    expect(summary.open_by_severity.HIGH).toBe(0);
    expect(summary.open_by_severity.MEDIUM).toBe(1);
  });

  test("resolving a HIGH leaves ALERT when a MEDIUM is still open (most severe open anomaly)", async () => {
    // Simulate a second run on the medium meter: HIGH anomaly added while the
    // MEDIUM is still open, run completion raised the meter to CRITICAL.
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

    // The MEDIUM anomaly is still open, so the meter must NOT fall to NORMAL.
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