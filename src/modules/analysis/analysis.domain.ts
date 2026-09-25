import type {
  AnomalyType,
  AnomalyStatus,
  EventType,
  Severity,
} from "../../generated/prisma/enums";
import type { BaselineStats, SignalStats } from "../../shared/domain/baseline";

export type { AnomalyType, AnomalyStatus, EventType, Severity };

export type BaselineSignal = keyof BaselineStats;
export type MeterBaseline = BaselineStats;
export type { SignalStats };

export const Z_THRESHOLD = 3;
export const PERSISTENT_DEVIATION = 0.2;
export const DQ_CONSUMPTION_TOLERANCE = 0.05;
export const DQ_STD_RATIO = 5;
export const SUSTAINED_HOURS = 12;

export const nearMissWindowMs = 6 * 60 * 60 * 1000;
export const LLM_Z_MIN = 2.5;
export const LLM_Z_MAX = 3;

/** Severidad → confianza persistida en cada anomalía (diseño D4/D7). */
export const SEVERITY_CONFIDENCE: Record<Severity, number> = {
  HIGH: 0.99,
  MEDIUM: 0.9,
  LOW: 0.8,
};

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

/** Evidencia persistida por variable: comparación baseline (primeros 7 días) vs rango afectado. */
export interface VariableEvidence {
  baseline_mean: number | null;
  recent_mean: number | null;
  variation_pct: number | null;
  max_z: number | null;
}

/** Señales persistidas por anomalía: máximos agregados + evidencia por variable. */
export interface ConsolidatedSignals {
  max_z: number | null;
  variation_pct: number | null;
  variables: string[];
  per_variable: Record<string, VariableEvidence>;
  // Extras específicos de detección (p. ej. voltage_sd_ratio, power_factor_sd_ratio).
  [extra: string]: unknown;
}

export interface ConsolidatedDetection {
  detectionType: string; // separado por comas, p. ej. "SPIKE,PERSISTENT_CHANGE"
  rangeStart: Date;
  rangeEnd: Date;
  variables: string[];
  maxZ: number | null;
  variationPct: number | null;
  signals: ConsolidatedSignals;
}

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

/** Mapeo tipo de evento → tipo/severidad de anomalía (matriz de cobertura de la spec). */
export const EVENT_MAPPING: Record<EventType, { type: AnomalyType; severity: Severity }> = {
  SCHEDULED_OUTAGE: { type: "FALSE_POSITIVE", severity: "LOW" },
  OPERATIONAL_CHANGE: { type: "EXPLAINABLE_ANOMALY", severity: "MEDIUM" },
  DATA_QUALITY: { type: "DATA_QUALITY", severity: "HIGH" },
  UNKNOWN: { type: "REAL_ANOMALY", severity: "HIGH" },
};

/**
 * Fallback por reglas cuando el proveedor de IA no está disponible: explicación
 * en español que cita la evidencia concreta de la detección. Null-safe (maxZ o
 * variación n/d). Sigue el mismo contrato de formato que el LLM: párrafo 1 con
 * la evidencia y párrafo 2 con el origen del fallback, separados por línea en
 * blanco. El texto "por reglas" marca el origen del fallback.
 */
export function FALLBACK_REASON(
  type: AnomalyType,
  detectionType: string,
  maxZ: number | null,
  variationPct: number | null,
): string {
  const z = maxZ !== null ? String(maxZ) : "n/d";
  const variation = variationPct !== null ? String(variationPct) : "n/d";
  return `Anomalía ${type} (${detectionType}, max |z| ${z}, variación ${variation}%).\n\nEl proveedor de IA no estuvo disponible; explicación generada por reglas.`;
}

/** Acción recomendada por reglas, una por tipo de anomalía (fallback del LLM): lista markdown de 2 items. */
export const FALLBACK_ACTION: Record<AnomalyType, string> = {
  REAL_ANOMALY: "- Inspeccionar el medidor y sus conexiones.\n- Verificar la carga conectada al circuito.",
  EXPLAINABLE_ANOMALY:
    "- Verificar que el cambio operativo explique la magnitud observada.\n- Monitorear el consumo durante las próximas 48 horas.",
  FALSE_POSITIVE:
    "- Confirmar que la señal coincide con el evento programado.\n- No se requiere acción adicional si se confirma.",
  DATA_QUALITY:
    "- Verificar la integridad de la medición (sensores y registro).\n- Recalibrar o reemplazar el sensor si persiste la inconsistencia.",
};

/**
 * Fallback SIMPLE por reglas: explicación cotidiana (1-2 párrafos de 1-2
 * frases) sin jerga técnica. Evita términos como |z| o kWh; habla de "consumo"
 * y de cambios "respecto a lo normal". El texto marca el origen por reglas.
 */
export function FALLBACK_REASON_SIMPLE(
  type: AnomalyType,
  detectionType: string,
  maxZ: number | null,
  variationPct: number | null,
): string {
  const variation =
    variationPct !== null
      ? `El consumo cambió un ${variationPct}% respecto a lo normal.`
      : "El consumo cambió de forma notable respecto a lo normal.";
  return `${variation}\n\nEl sistema no pudo consultar al asistente automático, así que esta explicación se generó automáticamente.`;
}

/** Acción SIMPLE por reglas (fallback del LLM): 2-3 pasos cotidianos con prefijo "- ". */
export const FALLBACK_ACTION_SIMPLE: Record<AnomalyType, string> = {
  REAL_ANOMALY:
    "- Llama a un electricista para revisar la instalación.\n- Verifica si se conectó un equipo nuevo en esos días.\n- Pide revisar el medidor si el problema persiste.",
  EXPLAINABLE_ANOMALY:
    "- Confirma si hubo un cambio reciente en la operación o el local.\n- Observa el consumo durante los próximos dos días.\n- Si no vuelve a la normalidad, consulta a un electricista.",
  FALSE_POSITIVE:
    "- Verifica que la alerta coincida con el corte o mantenimiento programado.\n- No se necesita hacer nada más si se confirma.",
  DATA_QUALITY:
    "- Revisa que el medidor y sus sensores estén bien conectados.\n- Reporta el problema al proveedor de energía si persiste.",
};