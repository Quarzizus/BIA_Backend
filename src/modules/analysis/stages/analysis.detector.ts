import { mean, populationStd } from "../../../shared/domain/baseline";
import { DAY_MS, HOUR_MS } from "../../../shared/domain/time";
import {
  DQ_CONSUMPTION_TOLERANCE,
  DQ_STD_RATIO,
  PERSISTENT_DEVIATION,
  SUSTAINED_HOURS,
  Z_THRESHOLD,
  type ConsolidatedSignals,
  type Detection,
  type ConsolidatedDetection,
  type MeterBaseline,
  type ReadingPoint,
  type VariableEvidence,
} from "../analysis.domain";

/**
 * Etapa 2 — Detector.
 *
 * Detección pura de señales sobre el historial completo de lecturas de un
 * medidor:
 *  - SPIKE: racha contigua (horaria, ±1h) donde |z| de dos colas > 3 en consumo.
 *  - PERSISTENT_CHANGE: primer bloque de 24h alineado al día cuya media se
 *    desvía >20% vs baseline, sostenido (>=12 lecturas desviadas consecutivas
 *    dentro del bloque Y el bloque del día siguiente sigue desviándose en la
 *    misma dirección). El requisito del día siguiente excluye caídas transitorias
 *    como el corte programado de 12h de M-106.
 *  - DATA_QUALITY: bloques de día donde el consumo se mantiene dentro del 5%
 *    del baseline pero la std de voltaje o factor de potencia supera 5x la std
 *    del baseline (incoherencia eléctrica).
 *
 * Los tipos y constantes viven en analysis.domain; este archivo mantiene la
 * matemática de señales.
 */

export type {
  ConsolidatedDetection,
  ConsolidatedSignals,
  Detection,
  DetectionType,
  ReadingPoint,
  VariableEvidence,
} from "../analysis.domain";

type Signal = keyof MeterBaseline;

/** Picker nombre-de-señal → valor (un solo lugar en vez de ternarios anidados). */
const SIGNAL_PICKERS: Record<Signal, (reading: ReadingPoint) => number> = {
  consumption_kwh: (reading) => reading.consumptionKwh,
  voltage_v: (reading) => reading.voltageV,
  current_a: (reading) => reading.currentA,
  power_factor: (reading) => reading.powerFactor,
};

function signalValues(signal: Signal, readings: ReadingPoint[]): number[] {
  return readings.map(SIGNAL_PICKERS[signal]);
}

function zScore(value: number, mean: number | null, std: number | null): number | null {
  if (mean === null || std === null || std === 0) return null;
  return (value - mean) / std;
}

function dayStart(timestamp: Date): number {
  const d = new Date(timestamp);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function groupByDay(readings: ReadingPoint[]): Map<number, ReadingPoint[]> {
  const groups = new Map<number, ReadingPoint[]>();
  for (const reading of readings) {
    const key = dayStart(reading.timestamp);
    const bucket = groups.get(key) ?? [];
    bucket.push(reading);
    groups.set(key, bucket);
  }
  return groups;
}

function detectSpikes(readings: ReadingPoint[], baseline: MeterBaseline): Detection[] {
  const { mean: mu, std: sigma } = baseline.consumption_kwh;
  if (mu === null || sigma === null || sigma === 0) return [];

  const detections: Detection[] = [];
  let run: ReadingPoint[] = [];

  const flush = () => {
    if (run.length >= 2) {
      const zs = run.map((r) => Math.abs(zScore(r.consumptionKwh, mu, sigma) ?? 0));
      const maxZ = Math.max(...zs);
      const spikeReading = run.reduce((max, r) =>
        Math.abs(r.consumptionKwh - mu) > Math.abs(max.consumptionKwh - mu) ? r : max,
      );
      const variationPct = mu !== 0 ? ((spikeReading.consumptionKwh - mu) / mu) * 100 : null;
      const variables = ["consumption_kwh", "current_a", "power_factor"].filter((signal) => {
        const stats = baseline[signal as Signal];
        if (stats.mean === null || stats.std === null || stats.std === 0) return false;
        return signalValues(signal as Signal, run).some(
          (value) => Math.abs(zScore(value, stats.mean, stats.std) ?? 0) > Z_THRESHOLD,
        );
      });
      detections.push({
        type: "SPIKE",
        rangeStart: run[0]!.timestamp,
        rangeEnd: run[run.length - 1]!.timestamp,
        variables,
        maxZ,
        variationPct,
      });
    }
    run = [];
  };

  for (let i = 0; i < readings.length; i++) {
    const reading = readings[i]!;
    const z = zScore(reading.consumptionKwh, mu, sigma) ?? 0;
    if (Math.abs(z) > Z_THRESHOLD) {
      const prev = run[run.length - 1];
      if (prev && reading.timestamp.getTime() - prev.timestamp.getTime() > HOUR_MS + 1000) {
        flush();
      }
      run.push(reading);
    } else {
      flush();
    }
  }
  flush();
  return detections;
}

/**
 * PERSISTENT_CHANGE: bloques de 24h alineados al día. El primer bloque cuya
 * media se desvía >20% vs baseline, con >=12 lecturas desviadas consecutivas
 * dentro del bloque Y un bloque al día siguiente desviándose en la misma
 * dirección, abre una ventana de cambio que se extiende por los bloques de día
 * consecutivos desviados.
 */
function detectPersistentChange(readings: ReadingPoint[], baseline: MeterBaseline): Detection[] {
  const { mean: mu, std: sigma } = baseline.consumption_kwh;
  if (mu === null || sigma === null || sigma === 0 || readings.length === 0) return [];

  const groups = [...groupByDay(readings).entries()].sort((a, b) => a[0] - b[0]);
  const firstDay = groups[0]![0];
  const dayKeys = groups.map(([key]) => key);
  const blockMean = (key: number): number | null => {
    const bucket = groups.find(([k]) => k === key)?.[1];
    return bucket ? mean(bucket.map((r) => r.consumptionKwh)) : null;
  };
  const deviation = (value: number | null): number | null => {
    if (value === null || mu === 0) return null;
    return (value - mu) / mu;
  };

  // Candidato: un bloque de día cuya media se desvía >20% con >=12 lecturas
  // consecutivas dentro del bloque desviándose en la misma dirección, sostenido
  // por el día siguiente.
  let changeStartKey: number | null = null;
  for (const key of dayKeys) {
    if (key <= firstDay + 6 * DAY_MS) continue; // se excluye la ventana de baseline
    const dev = deviation(blockMean(key));
    if (dev === null || Math.abs(dev) <= PERSISTENT_DEVIATION) continue;
    const direction = Math.sign(dev);

    const bucket = groups.find(([k]) => k === key)?.[1] ?? [];
    let consecutive = 0;
    let best = 0;
    for (const reading of bucket) {
      const rDev = deviation(reading.consumptionKwh);
      const matches =
        rDev !== null &&
        Math.sign(rDev) === direction &&
        Math.abs(rDev) > PERSISTENT_DEVIATION;
      consecutive = matches ? consecutive + 1 : 0;
      best = Math.max(best, consecutive);
    }
    if (best < SUSTAINED_HOURS) continue;

    const nextDayDev = deviation(blockMean(key + DAY_MS));
    if (
      nextDayDev === null ||
      Math.sign(nextDayDev) !== direction ||
      Math.abs(nextDayDev) <= PERSISTENT_DEVIATION
    ) {
      continue;
    }

    changeStartKey = key;
    break;
  }

  if (changeStartKey === null) return [];

  // Extiende la ventana por los bloques de día consecutivos desviados.
  let changeEndKey = changeStartKey;
  const direction = Math.sign(deviation(blockMean(changeStartKey)) ?? 0);
  for (const key of dayKeys) {
    if (key <= changeStartKey) continue;
    const dev = deviation(blockMean(key));
    if (dev !== null && Math.sign(dev) === direction && Math.abs(dev) > PERSISTENT_DEVIATION) {
      changeEndKey = key;
    } else {
      break;
    }
  }

  const changeStart = groups.find(([k]) => k === changeStartKey)?.[1]?.[0]!.timestamp;
  const changeBucket = groups.find(([k]) => k === changeEndKey)?.[1];
  const changeEnd = changeBucket?.[changeBucket.length - 1]!.timestamp;
  if (!changeStart || !changeEnd) return [];

  // Variables: señales cuya media post-cambio se desvía >20% vs baseline.
  const postReadings = readings.filter((r) => r.timestamp.getTime() >= changeStart.getTime());
  const variables = ["consumption_kwh", "current_a", "power_factor", "voltage_v"].filter(
    (signal) => {
      const stats = baseline[signal as Signal];
      if (stats.mean === null || stats.mean === 0) return false;
      const postMean = mean(signalValues(signal as Signal, postReadings));
      return postMean !== null && Math.abs((postMean - stats.mean) / stats.mean) > PERSISTENT_DEVIATION;
    },
  );

  const changeDeviation = deviation(blockMean(changeStartKey));
  const variationPct = changeDeviation !== null ? changeDeviation * 100 : null;
  const maxZ = Math.max(
    ...readings
      .filter((r) => r.timestamp.getTime() >= changeStart.getTime())
      .map((r) => Math.abs(zScore(r.consumptionKwh, mu, sigma) ?? 0)),
  );

  return [
    {
      type: "PERSISTENT_CHANGE",
      rangeStart: changeStart,
      rangeEnd: changeEnd,
      variables,
      maxZ: Number.isFinite(maxZ) ? maxZ : null,
      variationPct,
    },
  ];
}

/**
 * DATA_QUALITY: bloques de día donde el consumo es estable (<5% vs baseline)
 * pero la std de voltaje o factor de potencia supera 5x el baseline
 * (incoherencia eléctrica).
 */
function detectDataQuality(readings: ReadingPoint[], baseline: MeterBaseline): Detection[] {
  const { mean: mu } = baseline.consumption_kwh;
  if (mu === null) return [];

  const groups = [...groupByDay(readings).entries()].sort((a, b) => a[0] - b[0]);
  const dqDays: { key: number; voltageRatio: number; pfRatio: number }[] = [];

  for (const [key, bucket] of groups) {
    const cMean = mean(bucket.map((r) => r.consumptionKwh));
    if (cMean === null || mu === 0) continue;
    if (Math.abs((cMean - mu) / mu) >= DQ_CONSUMPTION_TOLERANCE) continue;

    const voltageRatio =
      (populationStd(signalValues("voltage_v", bucket)) ?? 0) / (baseline.voltage_v.std ?? 1);
    const pfRatio =
      (populationStd(signalValues("power_factor", bucket)) ?? 0) / (baseline.power_factor.std ?? 1);

    if (voltageRatio > DQ_STD_RATIO || pfRatio > DQ_STD_RATIO) {
      dqDays.push({ key, voltageRatio, pfRatio });
    }
  }

  if (dqDays.length === 0) return [];
  const startKey = dqDays[0]!.key;
  const endKey = dqDays[dqDays.length - 1]!.key;
  const startBucket = groups.find(([k]) => k === startKey)?.[1];
  const endBucket = groups.find(([k]) => k === endKey)?.[1];
  if (!startBucket || !endBucket) return [];

  const maxVoltageRatio = Math.max(...dqDays.map((d) => d.voltageRatio));
  const maxPfRatio = Math.max(...dqDays.map((d) => d.pfRatio));

  // Razón media-del-día sobre media-del-baseline (≈100 para consumo estable). El
  // bucket nunca está vacío, pero se conserva el fallback null-safe del original.
  const dayMean = mean(signalValues("consumption_kwh", startBucket));

  return [
    {
      type: "DATA_QUALITY",
      rangeStart: startBucket[0]!.timestamp,
      rangeEnd: endBucket[endBucket.length - 1]!.timestamp,
      variables: ["voltage_v", "power_factor"],
      maxZ: null,
      variationPct: mu !== 0 ? ((dayMean ?? 0) / mu) * 100 : null,
      extras: { voltage_sd_ratio: maxVoltageRatio, power_factor_sd_ratio: maxPfRatio },
    },
  ];
}

export function detectMeter(
  readings: ReadingPoint[],
  baseline: MeterBaseline,
): Detection[] {
  return [
    ...detectSpikes(readings, baseline),
    ...detectPersistentChange(readings, baseline),
    ...detectDataQuality(readings, baseline),
  ];
}

/**
 * Evidencia por variable sobre el rango consolidado [rangeStart, rangeEnd]:
 * media del baseline (primeros 7 días), media reciente de las lecturas dentro
 * del rango, variación porcentual y max |z| (std poblacional del baseline).
 * Null-safe: variación null si la media del baseline es null/0; max_z null si
 * la std del baseline es null/0 (evita Infinity).
 */
function computeVariableEvidence(
  signal: Signal,
  rangeReadings: ReadingPoint[],
  baseline: MeterBaseline,
): VariableEvidence {
  const stats = baseline[signal];
  const baselineMean = stats.mean;
  const recentMean = mean(rangeReadings.map(SIGNAL_PICKERS[signal]));
  const variationPct =
    baselineMean !== null && baselineMean !== 0 && recentMean !== null
      ? ((recentMean - baselineMean) / baselineMean) * 100
      : null;
  const maxZ =
    baselineMean !== null && stats.std !== null && stats.std !== 0 && rangeReadings.length > 0
      ? Math.max(
          ...rangeReadings.map(
            (r) => Math.abs(zScore(SIGNAL_PICKERS[signal](r), baselineMean, stats.std) ?? 0),
          ),
        )
      : null;

  return {
    baseline_mean: baselineMean,
    recent_mean: recentMean,
    variation_pct: variationPct,
    max_z: maxZ,
  };
}

/**
 * Consolida las detecciones de un medidor en UNA anomalía por run: unión de
 * rangos, unión de variables, max |z|, tipos de detección unidos por coma y la
 * evidencia por variable (baseline vs rango afectado) sobre las lecturas.
 */
export function consolidateDetections(
  detections: Detection[],
  readings: ReadingPoint[],
  baseline: MeterBaseline,
): ConsolidatedDetection | null {
  if (detections.length === 0) return null;

  const types = [
    ...new Set(
      ["SPIKE", "PERSISTENT_CHANGE", "DATA_QUALITY"].filter((t) =>
        detections.some((d) => d.type === t),
      ),
    ),
  ];
  const rangeStart = new Date(Math.min(...detections.map((d) => d.rangeStart.getTime())));
  const rangeEnd = new Date(Math.max(...detections.map((d) => d.rangeEnd.getTime())));
  const variables = [...new Set(detections.flatMap((d) => d.variables))];
  const maxZ = detections.reduce<number | null>(
    (max, d) => (d.maxZ !== null && (max === null || d.maxZ > max) ? d.maxZ : max),
    null,
  );
  const variationPct = detections.reduce<number | null>(
    (max, d) =>
      d.variationPct !== null && (max === null || Math.abs(d.variationPct) > Math.abs(max))
        ? d.variationPct
        : max,
    null,
  );
  const extras = Object.assign({}, ...detections.map((d) => d.extras ?? {}));

  // Evidencia por variable sobre el rango consolidado [rangeStart, rangeEnd].
  const rangeReadings = readings.filter(
    (r) => r.timestamp.getTime() >= rangeStart.getTime() && r.timestamp.getTime() <= rangeEnd.getTime(),
  );
  const perVariable: Record<string, VariableEvidence> = {};
  for (const variable of variables) {
    if (!Object.prototype.hasOwnProperty.call(SIGNAL_PICKERS, variable)) continue;
    perVariable[variable] = computeVariableEvidence(variable as Signal, rangeReadings, baseline);
  }

  const signals: ConsolidatedSignals = {
    max_z: maxZ,
    variation_pct: variationPct,
    variables,
    per_variable: perVariable,
    ...extras,
  };

  return {
    detectionType: types.join(","),
    rangeStart,
    rangeEnd,
    variables,
    maxZ,
    variationPct,
    signals,
  };
}