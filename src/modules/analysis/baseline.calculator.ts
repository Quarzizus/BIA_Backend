import {
  BASELINE_WINDOW_DAYS,
  baselineWindow,
  computeBaselineStats,
  mean,
  populationStd,
  type BaselineReading,
  type BaselineStats,
} from "../meters/baseline";

/**
 * Pipeline-facing baseline calculator (Stage 1). Reuses the pure statistical
 * helpers from the meters module (first-7-days window, population std D9) and
 * exposes the per-signal stats the detector consumes.
 */

export type { BaselineStats };

export type BaselineSignal = keyof BaselineStats;

export interface SignalStats {
  mean: number | null;
  std: number | null;
}

export interface MeterBaseline {
  consumption_kwh: SignalStats;
  voltage_v: SignalStats;
  current_a: SignalStats;
  power_factor: SignalStats;
}

/** First-7-days readings for a meter (shared rule with the meters read APIs). */
export function baselineReadingsWindow<T extends { timestamp: Date }>(
  readings: T[],
): T[] {
  const window = baselineWindow(
    readings as unknown as BaselineReading[],
    BASELINE_WINDOW_DAYS,
  );
  return window as unknown as T[];
}

/** Mean and population std for each of the four signals over the first 7 days. */
export function computeBaseline(readings: {
  timestamp: Date;
  consumptionKwh: number;
  voltageV: number;
  currentA: number;
  powerFactor: number;
}[]): MeterBaseline {
  const window = baselineReadingsWindow(readings);
  return computeBaselineStats(window) as MeterBaseline;
}

export { mean, populationStd };