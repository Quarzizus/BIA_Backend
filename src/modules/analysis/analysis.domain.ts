import type {
  AnomalyType,
  AnomalyStatus,
  EventType,
  Severity,
} from "../../generated/prisma/enums";
import type { BaselineStats, SignalStats } from "../../shared/domain/baseline";

export type { AnomalyType, AnomalyStatus, EventType, Severity };

/* ------------------------------------------------------------------ */
/* Baseline shape (reuses the shared pure baseline types)              */
/* ------------------------------------------------------------------ */

export type BaselineSignal = keyof BaselineStats;
export type MeterBaseline = BaselineStats;
export type { SignalStats };

/* ------------------------------------------------------------------ */
/* Detector constants (stage 2)                                        */
/* ------------------------------------------------------------------ */

export const Z_THRESHOLD = 3;
export const PERSISTENT_DEVIATION = 0.2;
export const DQ_CONSUMPTION_TOLERANCE = 0.05;
export const DQ_STD_RATIO = 5;
export const SUSTAINED_HOURS = 12;

/* ------------------------------------------------------------------ */
/* Classifier constants (stage 3)                                      */
/* ------------------------------------------------------------------ */

export const nearMissWindowMs = 6 * 60 * 60 * 1000;
export const LLM_Z_MIN = 2.5;
export const LLM_Z_MAX = 3;

/* ------------------------------------------------------------------ */
/* Business maps                                                       */
/* ------------------------------------------------------------------ */

/** Severity → confidence persisted on each anomaly (design D4/D7). */
export const SEVERITY_CONFIDENCE: Record<Severity, number> = {
  HIGH: 0.99,
  MEDIUM: 0.9,
  LOW: 0.8,
};

/* ------------------------------------------------------------------ */
/* Detector types (stage 2)                                            */
/* ------------------------------------------------------------------ */

export type DetectionType = "SPIKE" | "PERSISTENT_CHANGE" | "DATA_QUALITY";

export interface ReadingPoint {
  timestamp: Date;
  consumptionKwh: number;
  voltageV: number;
  currentA: number;
  powerFactor: number;
}

export interface Detection {
  type: DetectionType;
  rangeStart: Date;
  rangeEnd: Date;
  variables: string[];
  maxZ: number | null;
  variationPct: number | null;
  extras?: Record<string, number>;
}

export interface ConsolidatedDetection {
  detectionType: string; // comma-joined, e.g. "SPIKE,PERSISTENT_CHANGE"
  rangeStart: Date;
  rangeEnd: Date;
  variables: string[];
  maxZ: number | null;
  variationPct: number | null;
  signals: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Classifier types + rule table (stage 3)                             */
/* ------------------------------------------------------------------ */

export interface MeterEvent {
  eventTimestamp: Date;
  eventType: EventType;
}

export interface ClassifyInput {
  detectionType: string;
  rangeStart: Date;
  rangeEnd: Date;
  maxZ: number | null;
  events: MeterEvent[];
}

export interface Classification {
  type: AnomalyType;
  severity: Severity;
  needsLlm: boolean;
  coveringEvent: EventType | null;
}

/** Event type → anomaly type/severity mapping (spec coverage matrix). */
export const EVENT_MAPPING: Record<EventType, { type: AnomalyType; severity: Severity }> = {
  SCHEDULED_OUTAGE: { type: "FALSE_POSITIVE", severity: "LOW" },
  OPERATIONAL_CHANGE: { type: "EXPLAINABLE_ANOMALY", severity: "MEDIUM" },
  DATA_QUALITY: { type: "DATA_QUALITY", severity: "HIGH" },
  UNKNOWN: { type: "REAL_ANOMALY", severity: "HIGH" },
};