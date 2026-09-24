import { describe, expect, test } from "bun:test";
import {
  BASELINE_WINDOW_DAYS,
  baselineWindow,
  computeBaselineStats,
  mean,
  populationStd,
  variationPct,
  type BaselineReading,
} from "../meter.baseline";

function reading(
  consumptionKwh: number,
  voltageV: number,
  currentA: number,
  powerFactor: number,
  day: number,
  hour: number,
): BaselineReading {
  return {
    timestamp: new Date(Date.UTC(2026, 8, day, hour)),
    consumptionKwh,
    voltageV,
    currentA,
    powerFactor,
  };
}

describe("mean", () => {
  test("computes the arithmetic mean", () => {
    expect(mean([2, 4, 4, 4, 5, 5, 7, 9])).toBe(5);
  });

  test("returns null for an empty list", () => {
    expect(mean([])).toBeNull();
  });
});

describe("populationStd", () => {
  test("computes population standard deviation (D9)", () => {
    expect(populationStd([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
  });

  test("returns 0 for a single value", () => {
    expect(populationStd([42])).toBe(0);
  });

  test("returns null for an empty list", () => {
    expect(populationStd([])).toBeNull();
  });
});

describe("computeBaselineStats", () => {
  test("computes mean and std for all four signals", () => {
    const readings = [
      reading(2, 220, 1, 0.95, 1, 0),
      reading(4, 220, 1, 0.95, 1, 1),
      reading(4, 221, 1, 0.95, 1, 2),
      reading(4, 221, 1, 0.95, 1, 3),
      reading(5, 220, 1, 0.95, 1, 4),
      reading(5, 221, 1, 0.95, 1, 5),
      reading(7, 220, 1, 0.95, 1, 6),
      reading(9, 221, 1, 0.95, 1, 7),
    ];
    const stats = computeBaselineStats(readings);
    expect(stats.consumption_kwh.mean).toBeCloseTo(5, 10);
    expect(stats.consumption_kwh.std).toBeCloseTo(2, 10);
    expect(stats.voltage_v.mean).toBeCloseTo(220.5, 10);
    expect(stats.voltage_v.std).toBeCloseTo(0.5, 10);
    expect(stats.current_a.mean).toBe(1);
    expect(stats.current_a.std).toBe(0);
    expect(stats.power_factor.mean).toBeCloseTo(0.95, 10);
    expect(stats.power_factor.std).toBeCloseTo(0, 10);
  });

  test("returns nulls for all signals when there are no readings", () => {
    const stats = computeBaselineStats([]);
    expect(stats.consumption_kwh.mean).toBeNull();
    expect(stats.consumption_kwh.std).toBeNull();
    expect(stats.voltage_v.mean).toBeNull();
    expect(stats.current_a.mean).toBeNull();
    expect(stats.power_factor.mean).toBeNull();
  });
});

describe("variationPct", () => {
  test("computes +152.5% for the M-109 spike vs baseline (spec)", () => {
    expect(variationPct(110.35, 43.7)).toBe(152.5);
  });

  test("computes a negative variation for a drop", () => {
    expect(variationPct(7.39, 43.7)).toBe(-83.1);
  });

  test("returns null when current is null", () => {
    expect(variationPct(null, 43.7)).toBeNull();
  });

  test("returns null when baseline mean is null", () => {
    expect(variationPct(110.35, null)).toBeNull();
  });

  test("returns null when baseline mean is zero", () => {
    expect(variationPct(110.35, 0)).toBeNull();
  });
});

describe("baselineWindow", () => {
  test("keeps only the first 7 days of hourly readings", () => {
    const readings: BaselineReading[] = [];
    for (let day = 1; day <= 10; day++) {
      for (let hour = 0; hour < 24; hour++) {
        readings.push(reading(10, 220, 1, 0.95, day, hour));
      }
    }
    expect(baselineWindow(readings)).toHaveLength(7 * 24);
  });

  test("respects the BASELINE_WINDOW_DAYS constant", () => {
    expect(BASELINE_WINDOW_DAYS).toBe(7);
  });

  test("returns an empty list for no readings", () => {
    expect(baselineWindow([])).toEqual([]);
  });
});