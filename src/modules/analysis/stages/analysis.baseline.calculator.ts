import {
  BASELINE_WINDOW_DAYS,
  baselineWindow,
  computeBaselineStats,
  mean,
  populationStd,
  type BaselineReading,
  type BaselineStats,
} from "../../../shared/domain/baseline";
import type { MeterBaseline } from "../analysis.domain";

/**
 * Calculador de baseline para el pipeline (Etapa 1). Reutiliza los helpers
 * estadísticos puros de shared/domain (ventana de primeros 7 días, std
 * poblacional D9) y expone las estadísticas por señal que consume el detector.
 */

export type { BaselineStats };
export type { BaselineSignal, MeterBaseline, SignalStats } from "../analysis.domain";

/** Lecturas de los primeros 7 días de un medidor (regla compartida con las APIs de lectura de meters). */
export function baselineReadingsWindow<T extends { timestamp: Date }>(
  readings: T[],
): T[] {
  const window = baselineWindow(
    readings as unknown as BaselineReading[],
    BASELINE_WINDOW_DAYS,
  );
  return window as unknown as T[];
}

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