/**
 * Dominio de anomalías — tipos puros, DTOs y contratos service/repository.
 *
 * Sin schemas zod (viven en anomaly.model.ts) y sin Prisma client. El contrato
 * del repository trabaja contra la forma estructural `AnomalyRow`; el payload
 * concreto acoplado a persistencia (`AnomalyWithRelations`) queda en
 * anomaly.repository.ts y lo satisface estructuralmente.
 */

import type {
  AnomalyStatus,
  AnomalyType,
  EventType,
  Severity,
} from "../../generated/prisma/enums";

export interface AnomalyFilters {
  status?: AnomalyStatus;
  severity?: Severity;
  /** Orden de la lista: `priority` (score descendente, por defecto) o `detected_at` (cronológico descendente). */
  sort?: "priority" | "detected_at";
}

export interface AnomalyListItem {
  id: string;
  meter_id: string;
  type: string;
  severity: string;
  confidence: number;
  status: string;
  recommended_action: string | null;
  recommended_action_simple: string | null;
  detected_at: string;
  /**
   * Score de prioridad 0-100 calculado por el backend (mayor = más urgente).
   * Regla de dominio transparente sobre señales de detección — NO proviene del LLM.
   */
  priority: number;
}

export interface RelatedEventDto {
  id: string;
  type: string;
  timestamp: string;
  description: string;
}

export interface AnomalyDetail extends AnomalyListItem {
  range_start: string;
  range_end: string;
  detection_type: string;
  signals: Record<string, unknown>;
  reason: string | null;
  reason_simple: string | null;
  related_event: RelatedEventDto | null;
  analysis_run_id: string;
}

export interface AnomalyRow {
  id: string;
  meterId: string;
  meter: { meterId: string } | null;
  type: AnomalyType;
  severity: Severity;
  confidence: number;
  status: AnomalyStatus;
  recommendedAction: string | null;
  recommendedActionSimple: string | null;
  detectedAt: Date;
  rangeStart: Date;
  rangeEnd: Date;
  detectionType: string;
  signals: unknown;
  reason: string | null;
  reasonSimple: string | null;
  relatedEvent: {
    id: string;
    eventType: EventType;
    eventTimestamp: Date;
    description: string;
  } | null;
  analysisRunId: string;
}

export interface AnomalyService {
  list(filters: AnomalyFilters): Promise<AnomalyListItem[]>;
  detail(id: string): Promise<AnomalyDetail>;
  updateStatus(id: string, status: AnomalyStatus): Promise<AnomalyDetail>;
}

export interface AnomalyRepository {
  list(filters: AnomalyFilters): Promise<AnomalyRow[]>;
  findById(id: string): Promise<AnomalyRow | null>;
  /** Persiste la transición y recalcula Meter.status atómicamente (diseño D4). */
  updateStatusWithMeterRecompute(id: string, status: AnomalyStatus): Promise<void>;
}

// ---------------------------------------------------------------------------
// Prioridad de anomalía — score 0-100 calculado por el backend.
//
// Fórmula: `priority = clamp(0, 100, severidad + impacto + recencia − penalidad_tipo)`,
// redondeado al entero más cercano.
//
// - Severidad (0-40): HIGH 40, MEDIUM 25, LOW 10.
// - Impacto (0-30): desde `signals.max_z` (`min(|max_z|/10, 1) * 30`); si falta o
//   no es numérico, desde `|signals.variation_pct|` (`min(|variation_pct|/100, 1) * 30`);
//   si tampoco, 0 (lectura defensiva: `signals` es JSON de forma libre).
// - Recencia (0-20): decaimiento exponencial con vida media de 7 días (168 h):
//   `20 * 0.5^(ageHoras/168)` — reciente → 20, 7 días → 10, 14 días → 5.
// - Penalidad por tipo: FALSE_POSITIVE → 30 (evento programado, no requiere
//   investigación), DATA_QUALITY → 10 (integridad de medición, leve),
//   REAL_ANOMALY / EXPLAINABLE_ANOMALY → 0.
//
// Este score es una regla de puntuación TRANSPARENTE y documentada sobre señales
// de detección; NO proviene del LLM. La explicación cualitativa sigue viviendo
// en `reason`/`reason_simple` (LLM o reglas).
// ---------------------------------------------------------------------------

/** Peso de severidad HIGH. */
export const PRIORITY_SEVERITY_HIGH = 40;
/** Peso de severidad MEDIUM. */
export const PRIORITY_SEVERITY_MEDIUM = 25;
/** Peso de severidad LOW. */
export const PRIORITY_SEVERITY_LOW = 10;
/** Tope del componente de impacto. */
export const PRIORITY_IMPACT_MAX = 30;
/** Escala de `signals.max_z`: 10 → impacto máximo. */
export const PRIORITY_IMPACT_MAX_Z_SCALE = 10;
/** Escala de `signals.variation_pct`: 100 % → impacto máximo. */
export const PRIORITY_IMPACT_VARIATION_SCALE = 100;
/** Tope del componente de recencia. */
export const PRIORITY_RECENCY_MAX = 20;
/** Vida media de la recencia: 7 días expresados en horas. */
export const PRIORITY_RECENCY_HALF_LIFE_HOURS = 168;
/** Penalidad por tipo FALSE_POSITIVE: evento programado, sin investigación. */
export const PRIORITY_PENALTY_FALSE_POSITIVE = 30;
/** Penalidad por tipo DATA_QUALITY: integridad de medición, leve. */
export const PRIORITY_PENALTY_DATA_QUALITY = 10;
/** Límite inferior del score. */
export const PRIORITY_MIN = 0;
/** Límite superior del score. */
export const PRIORITY_MAX = 100;

export interface AnomalyPriorityInput {
  severity: Severity;
  type: AnomalyType;
  detectedAt: Date;
  /** Señales de detección (JSON de forma libre); se leen `max_z`/`variation_pct` defensivamente. */
  signals: unknown;
  /** Instante de referencia para la recencia (normalmente "ahora"). */
  now: Date;
}

/** Lee una señal numérica de forma defensiva: solo números finitos, si no null. */
function readSignalNumber(signals: unknown, key: string): number | null {
  if (typeof signals !== "object" || signals === null) return null;
  const value = (signals as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function severityPoints(severity: Severity): number {
  switch (severity) {
    case "HIGH":
      return PRIORITY_SEVERITY_HIGH;
    case "MEDIUM":
      return PRIORITY_SEVERITY_MEDIUM;
    case "LOW":
      return PRIORITY_SEVERITY_LOW;
  }
}

function impactPoints(signals: unknown): number {
  const maxZ = readSignalNumber(signals, "max_z");
  if (maxZ !== null) {
    // Magnitud de la desviación: se usa |max_z| (una caída con z ≈ −5 también es impacto alto).
    return Math.min(Math.abs(maxZ) / PRIORITY_IMPACT_MAX_Z_SCALE, 1) * PRIORITY_IMPACT_MAX;
  }
  const variationPct = readSignalNumber(signals, "variation_pct");
  if (variationPct !== null) {
    return Math.min(Math.abs(variationPct) / PRIORITY_IMPACT_VARIATION_SCALE, 1) * PRIORITY_IMPACT_MAX;
  }
  return 0;
}

function recencyPoints(detectedAt: Date, now: Date): number {
  const ageHours = Math.max(0, (now.getTime() - detectedAt.getTime()) / 3_600_000);
  // Decaimiento exponencial con vida media de 168 h (factor 0.5 por semana).
  return PRIORITY_RECENCY_MAX * 0.5 ** (ageHours / PRIORITY_RECENCY_HALF_LIFE_HOURS);
}

function typePenalty(type: AnomalyType): number {
  switch (type) {
    case "FALSE_POSITIVE":
      return PRIORITY_PENALTY_FALSE_POSITIVE;
    case "DATA_QUALITY":
      return PRIORITY_PENALTY_DATA_QUALITY;
    case "REAL_ANOMALY":
    case "EXPLAINABLE_ANOMALY":
      return 0;
  }
}

/** Calcula el score de prioridad 0-100 de una anomalía (función pura, inyectando `now`). */
export function computeAnomalyPriority(input: AnomalyPriorityInput): number {
  const raw =
    severityPoints(input.severity) +
    impactPoints(input.signals) +
    recencyPoints(input.detectedAt, input.now) -
    typePenalty(input.type);
  return Math.min(PRIORITY_MAX, Math.max(PRIORITY_MIN, Math.round(raw)));
}