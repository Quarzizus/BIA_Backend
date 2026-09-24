import { describe, expect, test } from "bun:test";
import {
  consolidateDetections,
  detectMeter,
  type ReadingPoint,
} from "../stages/analysis.detector";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeReadings(
  values: { c: number; v?: number; a?: number; pf?: number }[],
): ReadingPoint[] {
  return values.map((value, index) => ({
    timestamp: new Date(Date.UTC(2026, 8, 1 + Math.floor(index / 24), index % 24, 0, 0)),
    consumptionKwh: value.c,
    voltageV: value.v ?? 220,
    currentA: value.a ?? value.c * 0.5,
    powerFactor: value.pf ?? 0.95,
  }));
}

function baselineOf(readings: ReadingPoint[], days = 7) {
  const cutoff = readings[0]!.timestamp.getTime() + days * DAY_MS;
  const window = readings.filter((r) => r.timestamp.getTime() < cutoff);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const popStd = (xs: number[]) => {
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  };
  const c = window.map((r) => r.consumptionKwh);
  const v = window.map((r) => r.voltageV);
  const a = window.map((r) => r.currentA);
  const pf = window.map((r) => r.powerFactor);
  return {
    consumption_kwh: { mean: mean(c), std: popStd(c) },
    voltage_v: { mean: mean(v), std: popStd(v) },
    current_a: { mean: mean(a), std: popStd(a) },
    power_factor: { mean: mean(pf), std: popStd(pf) },
  };
}

/** Estilo M-109: baseline c=44±7.6, spike sostenido a 110 desde 09-12 14:00 (días 12-13 completos). */
function spikeReadings(): ReadingPoint[] {
  const values = [];
  for (let day = 0; day < 14; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const spiking = day >= 12 || (day === 11 && hour >= 14);
      values.push({ c: spiking ? 110 : 44 + (hour % 2 === 0 ? 1 : -1) * 7.6 });
    }
  }
  return makeReadings(values);
}

describe("detectMeter — SPIKE", () => {
  test("detects a two-tailed negative drop (z=-5.09 style) with a contiguous ±1h range", () => {
    // Estilo M-106: baseline ~56±9.6, caída de 12h a ~10, luego recuperación.
    const values = [];
    for (let day = 0; day < 14; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const dropping = day === 7 && hour < 12;
        const c = dropping ? 10 : 56 + (hour % 2 === 0 ? 1 : -1) * 9.6;
        values.push({ c });
      }
    }
    const readings = makeReadings(values);
    const baseline = baselineOf(readings);

    const detections = detectMeter(readings, baseline);
    const spike = detections.find((d) => d.type === "SPIKE");
    expect(spike).toBeDefined();
    expect(spike!.rangeStart.toISOString()).toBe("2026-09-08T00:00:00.000Z");
    expect(spike!.rangeEnd.toISOString()).toBe("2026-09-08T11:00:00.000Z");
    // z = (10 - 56) / 9.6 = -4.79 → el |z| de dos colas debe ser > 3.
    expect(spike!.maxZ!).toBeGreaterThan(4);
  });

  test("detects a positive spike run and bounds it to the contiguous spike window", () => {
    // Estilo M-109: baseline ~43.7, spike desde 09-12 14:00 sostenido hasta el final.
    const values = [];
    for (let day = 0; day < 14; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const spiking = day >= 11 && hour >= 14;
        const c = spiking ? 110 : 44 + (hour % 2 === 0 ? 1 : -1) * 7.6;
        values.push({ c });
      }
    }
    const readings = makeReadings(values);
    const baseline = baselineOf(readings);

    const detections = detectMeter(readings, baseline);
    const spike = detections.find((d) => d.type === "SPIKE");
    expect(spike).toBeDefined();
    expect(spike!.rangeStart.toISOString()).toBe("2026-09-12T14:00:00.000Z");
    expect(spike!.maxZ!).toBeGreaterThan(8);
  });

  test("clean readings with |z| <= 3 produce no SPIKE", () => {
    const values = [];
    for (let day = 0; day < 14; day++) {
      for (let hour = 0; hour < 24; hour++) {
        values.push({ c: 50 + (hour % 2 === 0 ? 1 : -1) });
      }
    }
    const readings = makeReadings(values);
    const baseline = baselineOf(readings);
    const detections = detectMeter(readings, baseline);
    expect(detections.filter((d) => d.type === "SPIKE")).toHaveLength(0);
  });
});

describe("detectMeter — PERSISTENT_CHANGE", () => {
  test("detects a step whose first deviating 24h block starts 09-11 00:00 (M-104 rule)", () => {
    // Días de baseline 0-6 en ~48.7, días 7-9 normales (~48.7), día 10+ sube a ~71.
    const values = [];
    for (let day = 0; day < 14; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const noise = hour % 2 === 0 ? 1 : -1;
        const c = day >= 10 ? 71 + noise : 48.7 + noise * 0.1;
        values.push({ c });
      }
    }
    const readings = makeReadings(values);
    const baseline = baselineOf(readings);

    const detections = detectMeter(readings, baseline);
    const persistent = detections.find((d) => d.type === "PERSISTENT_CHANGE");
    expect(persistent).toBeDefined();
    expect(persistent!.rangeStart.toISOString()).toBe("2026-09-11T00:00:00.000Z");
    expect(persistent!.rangeEnd.toISOString()).toBe("2026-09-14T23:00:00.000Z");
  });

  test("a transient 12h drop that recovers is NOT a persistent change (M-106)", () => {
    const values = [];
    for (let day = 0; day < 14; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const dropping = day === 7 && hour < 12;
        const c = dropping ? 10 : 56;
        values.push({ c });
      }
    }
    const readings = makeReadings(values);
    const baseline = baselineOf(readings);
    const detections = detectMeter(readings, baseline);
    expect(detections.find((d) => d.type === "PERSISTENT_CHANGE")).toBeUndefined();
  });

  test("a mid-day spike does not start a persistent change on the same day (M-109)", () => {
    // Día 09-12: spike desde 14:00 (10 horas desviadas < 12) → rechazado;
    // los días 09-13 y 09-14 completamente elevados → el cambio empieza 09-13 00:00.
    const values = [];
    for (let day = 0; day < 14; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const elevated = day >= 12 || (day === 11 && hour >= 14);
        const c = elevated ? 110 : 44 + (hour % 2 === 0 ? 1 : -1) * 7.6;
        values.push({ c });
      }
    }
    const readings = makeReadings(values);
    const baseline = baselineOf(readings);
    const detections = detectMeter(readings, baseline);
    const persistent = detections.find((d) => d.type === "PERSISTENT_CHANGE");
    // El día del spike solo tiene 10 horas desviadas consecutivas (< 12) → el cambio empieza al día siguiente.
    expect(persistent).toBeDefined();
    expect(persistent!.rangeStart.toISOString()).toBe("2026-09-13T00:00:00.000Z");
  });
});

describe("detectMeter — DATA_QUALITY", () => {
  test("stable consumption with voltage/pf std > 5x baseline triggers DQ over the affected days", () => {
    // Estilo M-112: consumo estable ~27.6, pero voltaje y pf salvajes en 09-13/09-14.
    const values = [];
    for (let day = 0; day < 14; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const wild = day >= 12;
        values.push({
          c: 27.6 + (hour % 2 === 0 ? 0.1 : -0.1),
          v: wild ? 220 + (hour % 2 === 0 ? 10 : -10) : 221,
          a: 13,
          pf: wild ? 0.95 + (hour % 2 === 0 ? 0.13 : -0.13) : 0.95,
        });
      }
    }
    const readings = makeReadings(values);
    const baseline = baselineOf(readings);

    const detections = detectMeter(readings, baseline);
    const dq = detections.find((d) => d.type === "DATA_QUALITY");
    expect(dq).toBeDefined();
    expect(dq!.rangeStart.toISOString()).toBe("2026-09-13T00:00:00.000Z");
    expect(dq!.rangeEnd.toISOString()).toBe("2026-09-14T23:00:00.000Z");
    // Razón de std de voltaje ≈ 10 / 0.5 > 5x.
    expect(dq!.extras!.voltage_sd_ratio).toBeGreaterThan(5);
    expect(dq!.extras!.power_factor_sd_ratio).toBeGreaterThan(5);
  });

  test("voltage noise within 5x baseline does not trigger DQ", () => {
    const values = [];
    for (let day = 0; day < 14; day++) {
      for (let hour = 0; hour < 24; hour++) {
        values.push({ c: 27.6, v: 220 + (hour % 2 === 0 ? 0.5 : -0.5), a: 13, pf: 0.95 });
      }
    }
    const readings = makeReadings(values);
    const baseline = baselineOf(readings);
    const detections = detectMeter(readings, baseline);
    expect(detections.find((d) => d.type === "DATA_QUALITY")).toBeUndefined();
  });
});

describe("consolidateDetections", () => {
  test("unions ranges, variables and keeps the max |z| across detections", () => {
    const detections = [
      {
        type: "SPIKE" as const,
        rangeStart: new Date("2026-09-12T14:00:00.000Z"),
        rangeEnd: new Date("2026-09-14T23:00:00.000Z"),
        variables: ["consumption_kwh", "current_a", "power_factor"],
        maxZ: 8.79,
        variationPct: 152.5,
      },
      {
        type: "PERSISTENT_CHANGE" as const,
        rangeStart: new Date("2026-09-13T00:00:00.000Z"),
        rangeEnd: new Date("2026-09-14T23:00:00.000Z"),
        variables: ["consumption_kwh"],
        maxZ: 9.73,
        variationPct: 169.2,
      },
    ];
    const readings = spikeReadings();
    const baseline = baselineOf(readings);
    const consolidated = consolidateDetections(detections, readings, baseline);
    expect(consolidated).not.toBeNull();
    expect(consolidated!.detectionType).toBe("SPIKE,PERSISTENT_CHANGE");
    expect(consolidated!.rangeStart.toISOString()).toBe("2026-09-12T14:00:00.000Z");
    expect(consolidated!.rangeEnd.toISOString()).toBe("2026-09-14T23:00:00.000Z");
    expect(consolidated!.variables).toContain("consumption_kwh");
    expect(consolidated!.variables).toContain("current_a");
    expect(consolidated!.variables).toContain("power_factor");
    expect(consolidated!.maxZ).toBe(9.73);
    expect(consolidated!.maxZ).toBeGreaterThan(8.79);
  });

  test("returns null for an empty detection list", () => {
    const baseline = {
      consumption_kwh: { mean: 44, std: 7.6 },
      voltage_v: { mean: 220, std: 1 },
      current_a: { mean: 22, std: 3.8 },
      power_factor: { mean: 0.95, std: 0.01 },
    };
    expect(consolidateDetections([], [], baseline)).toBeNull();
  });

  test("detectMeter returns zero detections for clean meters", () => {
    const values = [];
    for (let day = 0; day < 14; day++) {
      for (let hour = 0; hour < 24; hour++) {
        values.push({ c: 50 + (hour % 2 === 0 ? 1 : -1), v: 220, a: 25, pf: 0.95 });
      }
    }
    const readings = makeReadings(values);
    const baseline = baselineOf(readings);
    const detections = detectMeter(readings, baseline);
    expect(detections).toHaveLength(0);
    expect(consolidateDetections(detections, readings, baseline)).toBeNull();
  });
});

describe("consolidateDetections — per_variable evidence", () => {
  test("pins baseline vs recent comparison for the affected variable (M-109 style)", () => {
    const readings = spikeReadings();
    const baseline = baselineOf(readings);
    const consolidated = consolidateDetections(
      detectMeter(readings, baseline),
      readings,
      baseline,
    );
    expect(consolidated).not.toBeNull();

    const perVariable = consolidated!.signals.per_variable;
    // Baseline de los primeros 7 días: media 44 exacta (44 ± 7.6 alternado).
    expect(perVariable.consumption_kwh!.baseline_mean).toBeCloseTo(44, 0);
    // Rango consolidado [09-12 14:00, 09-14 23:00]: todas las lecturas en 110.
    expect(perVariable.consumption_kwh!.recent_mean).toBeCloseTo(110, 0);
    expect(perVariable.consumption_kwh!.variation_pct).toBeCloseTo(150, 0);
    // max |z| = |(110 - 44) / 7.6| ≈ 8.68, calculado con la std poblacional del baseline.
    expect(perVariable.consumption_kwh!.max_z).toBeCloseTo(8.68, 1);
  });

  test("max_z is null when the baseline std is 0 (avoids Infinity)", () => {
    // Baseline con power_factor.std exactamente 0: la división por std daría
    // Infinity, así que el max_z de esa variable debe ser null.
    const readings = spikeReadings();
    const baseline = {
      consumption_kwh: { mean: 44, std: 7.6 },
      voltage_v: { mean: 220, std: 1 },
      current_a: { mean: 22, std: 3.8 },
      power_factor: { mean: 0.95, std: 0 },
    };
    const detections = [
      {
        type: "SPIKE" as const,
        rangeStart: new Date("2026-09-12T14:00:00.000Z"),
        rangeEnd: new Date("2026-09-14T23:00:00.000Z"),
        variables: ["consumption_kwh", "current_a", "power_factor"],
        maxZ: 8.68,
        variationPct: 150,
      },
    ];
    const consolidated = consolidateDetections(detections, readings, baseline);
    expect(consolidated).not.toBeNull();
    const pf = consolidated!.signals.per_variable.power_factor!;
    expect(pf.baseline_mean).toBe(0.95);
    expect(pf.recent_mean).toBeCloseTo(0.95, 1);
    expect(pf.max_z).toBeNull();
  });
});