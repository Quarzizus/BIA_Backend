/**
 * Baseline statistics for the meters read APIs (PR2 scope).
 *
 * PR3's analysis module (baseline.calculator.ts) will build the full pipeline
 * on top of the same first-7-days rule; this minimal shared helper is exposed
 * here because the meters APIs need the baseline math now.
 */

export const BASELINE_WINDOW_DAYS = 7;

export interface BaselineReading {
  timestamp: Date;
  consumptionKwh: number;
  voltageV: number;
  currentA: number;
  powerFactor: number;
}

export interface SignalStats {
  mean: number | null;
  std: number | null;
}

export interface BaselineStats {
  consumption_kwh: SignalStats;
  voltage_v: SignalStats;
  current_a: SignalStats;
  power_factor: SignalStats;
}

/** Arithmetic mean; null for an empty list. */
export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Population standard deviation (design D9); 0 for a single value, null for empty. */
export function populationStd(values: number[], knownMean?: number | null): number | null {
  if (values.length === 0) return null;
  const m = knownMean ?? mean(values);
  if (m === null) return null;
  const variance = values.reduce((sum, value) => sum + (value - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * First-7-days window of a meter's readings: everything strictly before
 * (first timestamp + 7 days). Expects readings sorted ascending.
 */
export function baselineWindow(
  readings: BaselineReading[],
  days: number = BASELINE_WINDOW_DAYS,
): BaselineReading[] {
  if (readings.length === 0) return [];
  const cutoff = readings[0]!.timestamp.getTime() + days * 24 * 60 * 60 * 1000;
  return readings.filter((reading) => reading.timestamp.getTime() < cutoff);
}

/** Mean and population std for each of the four signals over the given readings. */
export function computeBaselineStats(readings: BaselineReading[]): BaselineStats {
  const signal = (pick: (reading: BaselineReading) => number): SignalStats => {
    const values = readings.map(pick);
    const m = mean(values);
    return { mean: m, std: populationStd(values, m) };
  };
  return {
    consumption_kwh: signal((r) => r.consumptionKwh),
    voltage_v: signal((r) => r.voltageV),
    current_a: signal((r) => r.currentA),
    power_factor: signal((r) => r.powerFactor),
  };
}

/**
 * Percentage variation of the current reading vs the baseline mean, rounded to
 * one decimal. Null when either side is unavailable or the baseline mean is 0.
 */
export function variationPct(
  current: number | null,
  baselineMean: number | null,
): number | null {
  if (current === null || baselineMean === null || baselineMean === 0) return null;
  return Math.round(((current - baselineMean) / baselineMean) * 1000) / 10;
}