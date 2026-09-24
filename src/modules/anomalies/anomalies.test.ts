import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getPrisma } from "../../config/database";
import { startTestServer, type TestServer } from "../../testing/testServer";
import { createAnomaliesRouter } from "./routes";

const prisma = getPrisma();
const FIXTURE_METERS = ["M-ZZ1", "M-ZZ2", "M-ZZ3", "M-ZZ4"];

let server: TestServer;
let runId: string;
let anomalyIds: { real: string; fp: string; dq: string; explainable: string };

beforeAll(async () => {
  const meters = await prisma.$transaction(
    FIXTURE_METERS.map((code, index) =>
      prisma.meter.create({
        data: { meterId: code, name: `Fixture ${code}`, location: `Site ${90 + index}` },
      }),
    ),
  );
  const meterByCode = new Map(meters.map((m) => [m.meterId, m.id]));

  runId = (
    await prisma.analysisRun.create({
      data: { status: "COMPLETED", summary: "fixture run", llmUsed: true },
    })
  ).id;

  const unknownEvent = await prisma.event.create({
    data: {
      meterId: meterByCode.get("M-ZZ1")!,
      eventTimestamp: new Date("2026-09-12T14:00:00.000Z"),
      eventType: "UNKNOWN",
      description: "Sin evento registrado",
    },
  });
  const opEvent = await prisma.event.create({
    data: {
      meterId: meterByCode.get("M-ZZ4")!,
      eventTimestamp: new Date("2026-09-11T00:00:00.000Z"),
      eventType: "OPERATIONAL_CHANGE",
      description: "Cambio operacional programado",
    },
  });

  const base = {
    analysisRunId: runId,
    detectedAt: new Date("2026-09-14T14:00:00.000Z"),
    rangeStart: new Date("2026-09-12T14:00:00.000Z"),
    rangeEnd: new Date("2026-09-14T23:00:00.000Z"),
    confidence: 0.99,
    status: "OPEN" as const,
  };

  const real = await prisma.anomaly.create({
    data: {
      ...base,
      meterId: meterByCode.get("M-ZZ1")!,
      type: "REAL_ANOMALY",
      severity: "HIGH",
      detectionType: "SPIKE,PERSISTENT_CHANGE",
      signals: {
        max_z: 8.79,
        variation_pct: 152.5,
        variables: ["consumption_kwh", "current_a", "power_factor"],
      },
      reason: "Consumo muy por encima de la línea base",
      recommendedAction: "Revisar instalación del medidor",
      relatedEventId: unknownEvent.id,
    },
  });
  const fp = await prisma.anomaly.create({
    data: {
      ...base,
      meterId: meterByCode.get("M-ZZ2")!,
      type: "FALSE_POSITIVE",
      severity: "LOW",
      detectionType: "SPIKE",
      signals: { max_z: -5.09, variation_pct: -83.1 },
      reason: "Caída por mantenimiento programado",
      recommendedAction: "Sin acción requerida",
    },
  });
  const dq = await prisma.anomaly.create({
    data: {
      ...base,
      meterId: meterByCode.get("M-ZZ3")!,
      type: "DATA_QUALITY",
      severity: "HIGH",
      detectionType: "DATA_QUALITY",
      signals: { max_z: 1.2, voltage_sd_ratio: 8.5 },
      reason: "Calidad de datos deficiente",
      recommendedAction: "Verificar sensor de voltaje",
    },
  });
  const explainable = await prisma.anomaly.create({
    data: {
      ...base,
      meterId: meterByCode.get("M-ZZ4")!,
      type: "EXPLAINABLE_ANOMALY",
      severity: "MEDIUM",
      detectionType: "PERSISTENT_CHANGE",
      signals: { max_z: 5.1, variation_pct: 46.6 },
      reason: "Cambio operacional sostenido",
      recommendedAction: "Monitorear",
      relatedEventId: opEvent.id,
    },
  });

  anomalyIds = { real: real.id, fp: fp.id, dq: dq.id, explainable: explainable.id };
  server = await startTestServer([{ path: "/anomalies", router: createAnomaliesRouter(prisma) }]);
});

afterAll(async () => {
  await server.close();
  await prisma.anomaly.deleteMany({ where: { meter: { meterId: { in: FIXTURE_METERS } } } });
  await prisma.event.deleteMany({ where: { meter: { meterId: { in: FIXTURE_METERS } } } });
  await prisma.analysisRun.deleteMany({ where: { id: runId } });
  await prisma.meter.deleteMany({ where: { meterId: { in: FIXTURE_METERS } } });
  await prisma.$disconnect();
});

describe("GET /anomalies", () => {
  test("returns the 4 fixture anomalies with type/severity per spec scenario", async () => {
    const res = await fetch(`${server.baseUrl}/anomalies`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, any>>;
    expect(body).toHaveLength(4);

    const byMeter = new Map(body.map((a) => [a.meter_id, a]));
    expect(byMeter.get("M-ZZ1")!.type).toBe("REAL_ANOMALY");
    expect(byMeter.get("M-ZZ1")!.severity).toBe("HIGH");
    expect(byMeter.get("M-ZZ2")!.type).toBe("FALSE_POSITIVE");
    expect(byMeter.get("M-ZZ2")!.severity).toBe("LOW");
    expect(byMeter.get("M-ZZ3")!.type).toBe("DATA_QUALITY");
    expect(byMeter.get("M-ZZ3")!.severity).toBe("HIGH");
    expect(byMeter.get("M-ZZ4")!.type).toBe("EXPLAINABLE_ANOMALY");
    expect(byMeter.get("M-ZZ4")!.severity).toBe("MEDIUM");

    expect(byMeter.get("M-ZZ1")!.recommended_action).toBe("Revisar instalación del medidor");
    expect(byMeter.get("M-ZZ1")!.status).toBe("OPEN");
    expect(typeof byMeter.get("M-ZZ1")!.detected_at).toBe("string");
  });

  test("returns [] when filtering by a status with no matches", async () => {
    const res = await fetch(`${server.baseUrl}/anomalies?status=RESOLVED`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(0);
  });

  test("filters by severity and combined status+severity", async () => {
    const high = (await (await fetch(`${server.baseUrl}/anomalies?severity=HIGH`)).json()) as any[];
    expect(high).toHaveLength(2);

    const openHigh = (await (
      await fetch(`${server.baseUrl}/anomalies?status=OPEN&severity=HIGH`)
    ).json()) as any[];
    expect(openHigh).toHaveLength(2);
  });

  test("returns 400 VALIDATION_ERROR for an unknown severity filter", async () => {
    const res = await fetch(`${server.baseUrl}/anomalies?severity=bogus`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /anomalies/:id", () => {
  test("returns full investigation detail for the M-109-like anomaly", async () => {
    const res = await fetch(`${server.baseUrl}/anomalies/${anomalyIds.real}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;

    expect(body.meter_id).toBe("M-ZZ1");
    expect(body.type).toBe("REAL_ANOMALY");
    expect(body.severity).toBe("HIGH");
    expect(body.detection_type).toContain("SPIKE");
    expect(body.detection_type).toContain("PERSISTENT_CHANGE");
    expect(body.signals.max_z).toBeCloseTo(8.79, 2);
    expect(body.range_start).toBe("2026-09-12T14:00:00.000Z");
    expect(body.range_end).toBe("2026-09-14T23:00:00.000Z");
    expect(body.related_event.type).toBe("UNKNOWN");
    expect(body.reason).toContain("base");
    expect(body.analysis_run_id).toBe(runId);
  });

  test("includes the related operational event for the explainable anomaly", async () => {
    const res = await fetch(`${server.baseUrl}/anomalies/${anomalyIds.explainable}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.related_event.type).toBe("OPERATIONAL_CHANGE");
    expect(body.related_event.timestamp).toBe("2026-09-11T00:00:00.000Z");
  });

  test("returns 404 NOT_FOUND for an unknown anomaly id", async () => {
    const res = await fetch(`${server.baseUrl}/anomalies/cuid_nonexistent`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

describe("PATCH /anomalies/:id/status", () => {
  test("walks the valid chain OPEN -> INVESTIGATING -> RESOLVED and persists it", async () => {
    const investigating = await fetch(`${server.baseUrl}/anomalies/${anomalyIds.fp}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "INVESTIGATING" }),
    });
    expect(investigating.status).toBe(200);
    const investigatingBody = (await investigating.json()) as Record<string, any>;
    expect(investigatingBody.status).toBe("INVESTIGATING");

    const resolved = await fetch(`${server.baseUrl}/anomalies/${anomalyIds.fp}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "RESOLVED" }),
    });
    expect(resolved.status).toBe(200);
    const resolvedBody = (await resolved.json()) as Record<string, any>;
    expect(resolvedBody.status).toBe("RESOLVED");

    const persisted = (await (await fetch(`${server.baseUrl}/anomalies/${anomalyIds.fp}`)).json()) as Record<string, any>;
    expect(persisted.status).toBe("RESOLVED");
  });

  test("returns 409 INVALID_STATUS_TRANSITION when patching OPEN on a RESOLVED anomaly (spec)", async () => {
    // Make the state deterministic regardless of test order.
    await prisma.anomaly.update({
      where: { id: anomalyIds.fp },
      data: { status: "RESOLVED" },
    });
    const res = await fetch(`${server.baseUrl}/anomalies/${anomalyIds.fp}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "OPEN" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("INVALID_STATUS_TRANSITION");
  });

  test("returns 409 INVALID_STATUS_TRANSITION when skipping INVESTIGATING", async () => {
    const res = await fetch(`${server.baseUrl}/anomalies/${anomalyIds.dq}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "RESOLVED" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("INVALID_STATUS_TRANSITION");
  });

  test("returns 404 NOT_FOUND for an unknown anomaly id", async () => {
    const res = await fetch(`${server.baseUrl}/anomalies/cuid_nonexistent/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "RESOLVED" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("returns 400 VALIDATION_ERROR for an invalid status value", async () => {
    const res = await fetch(`${server.baseUrl}/anomalies/${anomalyIds.dq}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "BOGUS" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});