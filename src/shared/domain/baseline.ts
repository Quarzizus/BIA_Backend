/**
 * Estadísticas de baseline — dominio compartido (PR2/PR3).
 *
 * Implementación pura canónica de la regla de los primeros 7 días (diseño D9:
 * desviación estándar poblacional). La consumen las APIs de lectura de meters,
 * el pipeline de análisis (baseline.calculator) y el detector.
 *
 * Este módulo es puro: sin zod, sin Prisma client.
 */

import { DAY_MS } from "./time";

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

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Desviación estándar poblacional (diseño D9); 0 para un único valor, null si está vacío. */
export function populationStd(values: number[], knownMean?: number | null): number | null {
  if (values.length === 0) return null;
  const m = knownMean ?? mean(values);
  if (m === null) return null;
  const variance = values.reduce((sum, value) => sum + (value - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Ventana de primeros 7 días de un medidor: todo lo estrictamente anterior a
 * (primer timestamp + 7 días). Espera lecturas ordenadas ascendentemente.
 */
export function baselineWindow(
  readings: BaselineReading[],
  days: number = BASELINE_WINDOW_DAYS,
): BaselineReading[] {
  if (readings.length === 0) return [];
  const cutoff = readings[0]!.timestamp.getTime() + days * DAY_MS;
  return readings.filter((reading) => reading.timestamp.getTime() < cutoff);
}

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
 * Variación porcentual de la lectura actual vs la media del baseline, redondeada
 * a un decimal. Null cuando alguno de los lados no está disponible o la media
 * del baseline es 0.
 */
export function variationPct(
  current: number | null,
  baselineMean: number | null,
): number | null {
  if (current === null || baselineMean === null || baselineMean === 0) return null;
  return Math.round(((current - baselineMean) / baselineMean) * 1000) / 10;
}