import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestPrisma, provisionTestDb, seedTestDb } from "../../../testing/testDb";
import { startTestServer, type TestServer } from "../../../testing/testServer";
import { createAnomaliesRouter } from "../anomaly.routes";
import {
  computeAnomalyPriority,
  PRIORITY_IMPACT_MAX,
  PRIORITY_IMPACT_MAX_Z_SCALE,
  PRIORITY_PENALTY_DATA_QUALITY,
  PRIORITY_PENALTY_FALSE_POSITIVE,
  PRIORITY_RECENCY_HALF_LIFE_HOURS,
  PRIORITY_RECENCY_MAX,
  PRIORITY_SEVERITY_HIGH,
  PRIORITY_SEVERITY_LOW,
  PRIORITY_SEVERITY_MEDIUM,
} from "../anomaly.domain";

// ---------------------------------------------------------------------------
// Unit — computeAnomalyPriority (función pura, `now` inyectado).
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-25T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function priority(opts: {
  severity?: "HIGH" | "MEDIUM" | "LOW";
  type?: "REAL_ANOMALY" | "EXPLAINABLE_ANOMALY" | "FALSE_POSITIVE" | "DATA_QUALITY";
  detectedAt?: Date;
  signals?: unknown;
  now?: Date;
}): number {
  return computeAnomalyPriority({
    severity: opts.severity ?? "HIGH",
    type: opts.type ?? "REAL_ANOMALY",
    detectedAt: opts.detectedAt ?? NOW,
    signals: opts.signals ?? null,
    now: opts.now ?? NOW,
  });
}

describe("computeAnomalyPriority — pesos documentados", () => {
  test("las constantes de pesos cumplen el contrato de la regla", () => {
    expect(PRIORITY_SEVERITY_HIGH).toBe(40);
    expect(PRIORITY_SEVERITY_MEDIUM).toBe(25);
    expect(PRIORITY_SEVERITY_LOW).toBe(10);
    expect(PRIORITY_IMPACT_MAX).toBe(30);
    expect(PRIORITY_IMPACT_MAX_Z_SCALE).toBe(10);
    expect(PRIORITY_RECENCY_MAX).toBe(20);
    expect(PRIORITY_RECENCY_HALF_LIFE_HOURS).toBe(168);
    expect(PRIORITY_PENALTY_FALSE_POSITIVE).toBe(30);
    expect(PRIORITY_PENALTY_DATA_QUALITY).toBe(10);
  });

  test("pesos de severidad (sin señales, recién detectada, REAL)", () => {
    expect(priority({ severity: "HIGH" })).toBe(40 + 0 + 20);
    expect(priority({ severity: "MEDIUM" })).toBe(25 + 0 + 20);
    expect(priority({ severity: "LOW" })).toBe(10 + 0 + 20);
  });
});

describe("computeAnomalyPriority — impacto", () => {
  test("impacto desde max_z: 9.7 → min(9.7/10, 1) * 30 = 29.1 (contribución 29)", () => {
    const withMaxZ = priority({ signals: { max_z: 9.7 } }); // 40 + 29.1 + 20 = 89.1 → 89
    const without = priority({ signals: null }); // 60
    expect(withMaxZ).toBe(89);
    expect(withMaxZ - without).toBe(29);
  });

  test("impacto saturado: max_z >= 10 aporta el tope de 30", () => {
    expect(priority({ signals: { max_z: 10 } })).toBe(40 + 30 + 20); // 90
    expect(priority({ signals: { max_z: 100 } })).toBe(90);
  });

  test("fallback a |variation_pct| cuando max_z falta: 152.5 % → tope 30", () => {
    expect(priority({ signals: { variation_pct: 152.5 } })).toBe(40 + 30 + 20); // 90
  });

  test("fallback parcial: variation_pct 46.6 → min(46.6/100, 1) * 30 = 13.98", () => {
    expect(priority({ signals: { variation_pct: 46.6 } })).toBe(74); // 73.98 → 74
  });

  test("max_z tiene precedencia sobre variation_pct cuando ambos existen", () => {
    expect(priority({ signals: { max_z: 9.7, variation_pct: 152.5 } })).toBe(89);
  });

  test("señales nulas/malformadas → impacto 0", () => {
    expect(priority({ signals: null })).toBe(60);
    expect(priority({ signals: {} })).toBe(60);
    expect(priority({ signals: { max_z: "9.7" } })).toBe(60);
    expect(priority({ signals: { variation_pct: "x" } })).toBe(60);
    expect(priority({ signals: { max_z: null, variation_pct: null } })).toBe(60);
    expect(priority({ signals: { max_z: Number.NaN } })).toBe(60);
    expect(priority({ signals: { max_z: Number.POSITIVE_INFINITY } })).toBe(60);
  });
});

describe("computeAnomalyPriority — recencia (vida media 7 días)", () => {
  test("recién detectada → 20; 7 días → 10; 14 días → 5", () => {
    expect(priority({ detectedAt: NOW })).toBe(60); // 40 + 0 + 20
    expect(priority({ detectedAt: new Date(NOW.getTime() - 7 * DAY) })).toBe(50); // 40 + 0 + 10
    expect(priority({ detectedAt: new Date(NOW.getTime() - 14 * DAY) })).toBe(45); // 40 + 0 + 5
  });

  test("edad futura se satura a 0 horas (no resta)", () => {
    expect(priority({ detectedAt: new Date(NOW.getTime() + HOUR) })).toBe(60);
  });
});

describe("computeAnomalyPriority — penalidades por tipo", () => {
  test("REAL_ANOMALY y EXPLAINABLE_ANOMALY no penalizan", () => {
    expect(priority({ type: "REAL_ANOMALY" })).toBe(60);
    expect(priority({ type: "EXPLAINABLE_ANOMALY" })).toBe(60);
  });

  test("DATA_QUALITY resta 10 (integridad de medición, leve)", () => {
    expect(priority({ type: "DATA_QUALITY" })).toBe(50); // 60 − 10
  });

  test("FALSE_POSITIVE resta 30 (evento programado, sin investigación)", () => {
    expect(priority({ type: "FALSE_POSITIVE" })).toBe(30); // 60 − 30
    expect(priority({ severity: "LOW", type: "FALSE_POSITIVE" })).toBe(0); // 30 − 30 → clamp 0
  });
});

describe("computeAnomalyPriority — clamp y redondeo", () => {
  test("clamp inferior a 0: penalidad + impacto ausente + recencia mínima", () => {
    // LOW + FALSE_POSITIVE sin señales y detectada hace 14 días: 10 + 0 + 5 − 30 → clamp 0.
    expect(
      priority({
        severity: "LOW",
        type: "FALSE_POSITIVE",
        detectedAt: new Date(NOW.getTime() - 14 * DAY),
      }),
    ).toBe(0);
  });

  test("impacto usa magnitud: max_z negativo suma igual que positivo", () => {
    expect(priority({ signals: { max_z: -9.7 } })).toBe(89); // |−9.7| → impacto 29.1
    expect(priority({ signals: { max_z: 9.7 } })).toBe(89);
  });

  test("el tope superior (100) es defensivo: el máximo alcanzable es 90", () => {
    // HIGH + impacto tope + recencia tope = 40 + 30 + 20.
    expect(priority({ signals: { max_z: 10 } })).toBe(90);
  });

  test("redondeo al entero más cercano", () => {
    expect(priority({ signals: { max_z: 9.7 } })).toBe(89); // 89.1 → 89
    expect(priority({ signals: { max_z: 9.9 } })).toBe(90); // 89.7 → 90
    expect(priority({ signals: { max_z: 9.4 } })).toBe(88); // 88.2 → 88
    expect(priority({ signals: { variation_pct: 46.6 } })).toBe(74); // 73.98 → 74
  });
});

// ---------------------------------------------------------------------------
// Integration — GET /anomalies ordena por priority; ?sort=detected_at y
// detalle/PATCH exponen el mismo score. Base aislada bia_test_anomaly_priority.
// ---------------------------------------------------------------------------

const prisma = createTestPrisma("bia_test_anomaly_priority");
const FIXTURE_METERS = ["M-P1", "M-P2", "M-P3", "M-P4", "M-P5"];

let server: TestServer;
let runId: string;
let anomalyIds: Record<string, string>;

beforeAll(async () => {
  await provisionTestDb("bia_test_anomaly_priority");
  await seedTestDb(prisma);

  const meters = await prisma.$transaction(
    FIXTURE_METERS.map((code, index) =>
      prisma.meter.create({
        data: { meterId: code, name: `Priority ${code}`, location: `Site ${70 + index}` },
      }),
    ),
  );
  const meterByCode = new Map(meters.map((m) => [m.meterId, m.id]));

  runId = (
    await prisma.analysisRun.create({
      data: { status: "COMPLETED", summary: "priority fixture run", llmUsed: false },
    })
  ).id;

  // detectedAt relativos a "ahora" para que la recencia sea determinista en el
  // ordenamiento (offsets distintos → orden detected_at desc sin empates).
  const now = Date.now();
  const base = {
    analysisRunId: runId,
    rangeStart: new Date(now - 48 * HOUR),
    rangeEnd: new Date(now - HOUR),
    confidence: 0.99,
    status: "OPEN" as const,
    detectionType: "SPIKE" as const,
  };

  const fixtures: Array<{
    code: string;
    type: "REAL_ANOMALY" | "EXPLAINABLE_ANOMALY" | "FALSE_POSITIVE" | "DATA_QUALITY";
    severity: "HIGH" | "MEDIUM" | "LOW";
    ageHours: number;
    signals: Record<string, number>;
  }> = [
    { code: "M-P1", type: "REAL_ANOMALY", severity: "HIGH", ageHours: 2, signals: { max_z: 9.7 } },
    { code: "M-P2", type: "REAL_ANOMALY", severity: "HIGH", ageHours: 20 * 24, signals: { max_z: 9.7 } },
    { code: "M-P3", type: "EXPLAINABLE_ANOMALY", severity: "MEDIUM", ageHours: 4, signals: { max_z: 5 } },
    { code: "M-P4", type: "FALSE_POSITIVE", severity: "LOW", ageHours: 6, signals: { max_z: 2 } },
    { code: "M-P5", type: "DATA_QUALITY", severity: "HIGH", ageHours: 8, signals: { max_z: 1 } },
  ];

  anomalyIds = {};
  for (const f of fixtures) {
    const created = await prisma.anomaly.create({
      data: {
        ...base,
        meterId: meterByCode.get(f.code)!,
        detectedAt: new Date(now - f.ageHours * HOUR),
        type: f.type,
        severity: f.severity,
        signals: f.signals,
      },
    });
    anomalyIds[f.code] = created.id;
  }

  server = await startTestServer([{ path: "/anomalies", router: createAnomaliesRouter(prisma) }]);
});

afterAll(async () => {
  await server.close();
  await prisma.anomaly.deleteMany({ where: { meter: { meterId: { in: FIXTURE_METERS } } } });
  await prisma.analysisRun.deleteMany({ where: { id: runId } });
  await prisma.meter.deleteMany({ where: { meterId: { in: FIXTURE_METERS } } });
  await prisma.$disconnect();
});

describe("GET /anomalies con priority", () => {
  test("cada item expone priority (entero 0-100) y ordena por priority desc", async () => {
    const res = await fetch(`${server.baseUrl}/anomalies`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, any>>;
    expect(body).toHaveLength(5);

    for (const item of body) {
      expect(typeof item.priority).toBe("number");
      expect(Number.isInteger(item.priority)).toBe(true);
      expect(item.priority).toBeGreaterThanOrEqual(0);
      expect(item.priority).toBeLessThanOrEqual(100);
    }

    // HIGH reciente REAL primero, FALSE_POSITIVE LOW al final (severidad + penalidad).
    const meterOrder = body.map((a) => a.meter_id);
    expect(meterOrder).toEqual(["M-P1", "M-P2", "M-P3", "M-P5", "M-P4"]);

    // Orden estrictamente descendente de priority.
    for (let i = 1; i < body.length; i++) {
      expect(body[i - 1]!.priority).toBeGreaterThan(body[i]!.priority);
    }
  });

  test("la recencia pesa: HIGH reciente > HIGH antigua (mismo resto de señales)", async () => {
    const res = await fetch(`${server.baseUrl}/anomalies`);
    const body = (await res.json()) as Array<Record<string, any>>;
    const p1 = body.find((a) => a.meter_id === "M-P1")!;
    const p2 = body.find((a) => a.meter_id === "M-P2")!;
    expect(p1.priority).toBeGreaterThan(p2.priority);
  });

  test("?sort=priority explícito devuelve el mismo orden por defecto", async () => {
    const res = await fetch(`${server.baseUrl}/anomalies?sort=priority`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, any>>;
    expect(body.map((a) => a.meter_id)).toEqual(["M-P1", "M-P2", "M-P3", "M-P5", "M-P4"]);
  });

  test("?sort=detected_at devuelve orden cronológico descendente", async () => {
    const res = await fetch(`${server.baseUrl}/anomalies?sort=detected_at`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, any>>;
    expect(body.map((a) => a.meter_id)).toEqual(["M-P1", "M-P3", "M-P4", "M-P5", "M-P2"]);

    for (let i = 1; i < body.length; i++) {
      expect(body[i - 1]!.detected_at >= body[i]!.detected_at).toBe(true);
    }
  });

  test("?sort=bogus responde 400 VALIDATION_ERROR", async () => {
    const res = await fetch(`${server.baseUrl}/anomalies?sort=bogus`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("priority en detalle y PATCH", () => {
  test("GET /anomalies/:id incluye priority (mismo score que la lista)", async () => {
    const [p1Detail, p2Detail, p1List] = await Promise.all([
      (await fetch(`${server.baseUrl}/anomalies/${anomalyIds["M-P1"]!}`)).json(),
      (await fetch(`${server.baseUrl}/anomalies/${anomalyIds["M-P2"]!}`)).json(),
      (await fetch(`${server.baseUrl}/anomalies`)).json(),
    ]);
    const p1DetailBody = p1Detail as Record<string, any>;
    const p2DetailBody = p2Detail as Record<string, any>;

    expect(typeof p1DetailBody.priority).toBe("number");
    expect(Number.isInteger(p1DetailBody.priority)).toBe(true);
    expect(p1DetailBody.priority).toBeGreaterThanOrEqual(0);
    expect(p1DetailBody.priority).toBeLessThanOrEqual(100);
    // Consistencia lista vs detalle (mismo instante de referencia).
    const p1ListBody = (p1List as Array<Record<string, any>>).find((a) => a.meter_id === "M-P1")!;
    expect(p1DetailBody.priority).toBe(p1ListBody.priority);
    // Recencia: la HIGH antigua puntúa menos que la reciente.
    expect(p2DetailBody.priority).toBeLessThan(p1DetailBody.priority);
  });

  test("PATCH /anomalies/:id/status responde con priority", async () => {
    const res = await fetch(`${server.baseUrl}/anomalies/${anomalyIds["M-P4"]!}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "INVESTIGATING" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.status).toBe("INVESTIGATING");
    expect(typeof body.priority).toBe("number");
    expect(Number.isInteger(body.priority)).toBe(true);
    expect(body.priority).toBeGreaterThanOrEqual(0);
    expect(body.priority).toBeLessThanOrEqual(100);
  });
});