import {
  EVENT_MAPPING,
  LLM_Z_MAX,
  LLM_Z_MIN,
  nearMissWindowMs,
  type ClassifyInput,
  type Classification,
  type MeterEvent,
} from "../analysis.domain";

/**
 * Stage 3 — Classifier.
 *
 * Maps a consolidated detection (one per meter per run) to an anomaly type and
 * severity using event coverage: `event_timestamp ∈ [rangeStart, rangeEnd]`.
 * DATA_QUALITY signal has priority. Borderline cases (2.5 <= maxZ < 3 or a
 * near-miss event within ±6h of the range) are routed to the LLM.
 *
 * Types and constants live in analysis.domain; this file keeps the rules.
 */

export type { ClassifyInput, Classification, MeterEvent } from "../analysis.domain";
export { LLM_Z_MIN, LLM_Z_MAX, nearMissWindowMs } from "../analysis.domain";

/** Finds the event whose timestamp lies inside the affected range (inclusive). */
export function coveringEvent(input: ClassifyInput): MeterEvent | null {
  const start = input.rangeStart.getTime();
  const end = input.rangeEnd.getTime();
  return (
    input.events.find((event) => {
      const ts = event.eventTimestamp.getTime();
      return ts >= start && ts <= end;
    }) ?? null
  );
}

/** Event within ±6h of the range but outside it → LLM borderline. */
export function nearMissEvent(input: ClassifyInput): MeterEvent | null {
  const start = input.rangeStart.getTime();
  const end = input.rangeEnd.getTime();
  return (
    input.events.find((event) => {
      const ts = event.eventTimestamp.getTime();
      if (ts >= start && ts <= end) return false;
      return Math.abs(ts - start) <= nearMissWindowMs || Math.abs(ts - end) <= nearMissWindowMs;
    }) ?? null
  );
}

/**
 * Rule-based classification with LLM routing. Priority:
 * DATA_QUALITY detection > covering event mapping > REAL_ANOMALY/HIGH.
 * Borderline (|z| in [2.5, 3) or near-miss event) → needsLlm true.
 */
export function classifyAnomaly(input: ClassifyInput): Classification {
  const event = coveringEvent(input);

  // DATA_QUALITY signal has classification priority (spec 3-stage pipeline rules).
  if (input.detectionType.includes("DATA_QUALITY")) {
    return { type: "DATA_QUALITY", severity: "HIGH", needsLlm: false, coveringEvent: event?.eventType ?? null };
  }

  const borderlineZ = input.maxZ !== null && input.maxZ >= LLM_Z_MIN && input.maxZ < LLM_Z_MAX;
  const nearMiss = nearMissEvent(input) !== null;

  if (borderlineZ || nearMiss) {
    return { type: "REAL_ANOMALY", severity: "HIGH", needsLlm: true, coveringEvent: null };
  }

  if (event) {
    const mapped = EVENT_MAPPING[event.eventType];
    return { type: mapped.type, severity: mapped.severity, needsLlm: false, coveringEvent: event.eventType };
  }

  return { type: "REAL_ANOMALY", severity: "HIGH", needsLlm: false, coveringEvent: null };
}