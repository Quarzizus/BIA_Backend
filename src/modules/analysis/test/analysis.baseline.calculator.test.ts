import { describe, expect, test } from "bun:test";
import { computeBaseline, type BaselineSignal } from "../stages/analysis.baseline.calculator";

/** Builds hourly readings for a synthetic meter over `days` starting 2026-09-01. */
function makeReadings(
  days: number,
  signals: (index: number) => { c: number; v: number; a: number; pf: number },
) {
  const readings = [];
  for (let day = 0; day < days; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const index = day * 24 + hour;
      const s = signals(index);
      readings.push({
        timestamp: new Date(Date.UTC(2026, 8, 1 + day, hour, 0, 0)),
        consumptionKwh: s.c,
        voltageV: s.v,
        currentA: s.a,
        powerFactor: s.pf,
      });
    }
  }
  return readings;
}

describe("computeBaseline (first 7 days)", () => {
  test("computes population mean/std for all 4 signals over the first-7d window (D9)", () => {
    // 14 days of data: days 0-6 baseline ~50±1, days 7-13 shifted to ~75.
    // noise alternates ±1 → population std exactly 1.
    const readings = makeReadings(14, (i) => {
      const day = Math.floor(i / 24);
      const base = day < 7 ? 50 : 75;
      const noise = i % 2 === 0 ? 1 : -1;
      return { c: base + noise, v: 220, a: base * 0.5 + noise * 0.5, pf: 0.95 };
    });

    const baseline = computeBaseline(readings);
    const expectSignal = (signal: BaselineSignal, mean: number, std: number) => {
      expect(baseline[signal].mean).toBeCloseTo(mean, 1);
      expect(baseline[signal].std).toBeCloseTo(std, 1);
    };

    // First 7 days only (168 readings) → mean 50, population std 1.
    expectSignal("consumption_kwh", 50, 1);
    expectSignal("voltage_v", 220, 0);
    expectSignal("current_a", 25, 0.5);
    expectSignal("power_factor", 0.95, 0);
  });

  test("returns nulls for a meter with no readings", () => {
    const baseline = computeBaseline([]);
    for (const signal of ["consumption_kwh", "voltage_v", "current_a", "power_factor"] as const) {
      expect(baseline[signal].mean).toBeNull();
      expect(baseline[signal].std).toBeNull();
    }
  });

  test("excludes readings after the 7-day window even when they dominate", () => {
    const readings = makeReadings(14, (i) => {
      const day = Math.floor(i / 24);
      return { c: day < 7 ? 10 : 1000, v: 220, a: 5, pf: 0.9 };
    });
    const baseline = computeBaseline(readings);
    expect(baseline.consumption_kwh.mean).toBeCloseTo(10, 1);
    expect(baseline.consumption_kwh.std).toBe(0);
  });
});