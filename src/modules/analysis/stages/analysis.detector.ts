import { mean, populationStd } from "../../../shared/domain/baseline";
import { DAY_MS, HOUR_MS } from "../../../shared/domain/time";
import {
  DQ_CONSUMPTION_TOLERANCE,
  DQ_STD_RATIO,
  PERSISTENT_DEVIATION,
  SUSTAINED_HOURS,
  Z_THRESHOLD,
  type Detection,
  type ConsolidatedDetection,
  type MeterBaseline,
  type ReadingPoint,
} from "../analysis.domain";

/**
 * Stage 2 — Detector.
 *
 * Pure signal detection over a meter's full reading history:
 *  - SPIKE: contiguous run (hourly, ±1h) where two-tailed |z| > 3 on consumption.
 *  - PERSISTENT_CHANGE: first day-aligned 24h block whose mean deviates >20% vs
 *    baseline, sustained (>=12 consecutive deviating readings in-block AND the
 *    following day block keeps deviating in the same direction). The next-day
 *    requirement excludes transient dips like M-106's 12h scheduled outage.
 *  - DATA_QUALITY: day blocks where consumption stays within 5% of baseline but
 *    voltage or power-factor std exceeds 5x the baseline std (electrical incoherence).
 *
 * Types and constants live in analysis.domain; this file keeps the signal math.
 */

export type { ConsolidatedDetection, Detection, DetectionType, ReadingPoint } from "../analysis.domain";

type Signal = keyof MeterBaseline;

/** Signal-name → value picker (single place instead of nested ternaries). */
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

/** SPIKE: contiguous runs of readings with two-tailed |z| > 3 on consumption. */
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
 * PERSISTENT_CHANGE: day-aligned 24h blocks. The first block whose mean deviates
 * >20% vs baseline, with >=12 consecutive in-block deviating readings AND a
 * following day block deviating in the same direction, opens a change window
 * that extends through consecutive deviating day blocks.
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

  // Candidate: a day block whose mean deviates >20% with >=12 consecutive
  // in-block readings deviating in the same direction, sustained by the next day.
  let changeStartKey: number | null = null;
  for (const key of dayKeys) {
    if (key <= firstDay + 6 * DAY_MS) continue; // baseline window excluded
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

  // Extend the window through consecutive deviating day blocks.
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

  // Variables: signals whose post-change mean deviates >20% vs baseline.
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
 * DATA_QUALITY: day blocks where consumption is stable (<5% vs baseline) yet
 * voltage or power-factor std exceeds 5x baseline (electrical incoherence).
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

  // Day-mean over baseline-mean ratio (≈100 for stable consumption). The bucket
  // is never empty, but keep the null-safe fallback that the original had.
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

/** Runs all three detectors over a meter's readings. */
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
 * Consolidates a meter's detections into ONE anomaly record per run: union
 * range, union variables, max |z|, comma-joined detection types.
 */
export function consolidateDetections(
  detections: Detection[],
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

  return {
    detectionType: types.join(","),
    rangeStart,
    rangeEnd,
    variables,
    maxZ,
    variationPct,
    signals: {
      max_z: maxZ,
      variation_pct: variationPct,
      variables,
      ...extras,
    },
  };
}