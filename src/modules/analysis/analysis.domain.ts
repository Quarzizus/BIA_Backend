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

/** Límite de llamadas LLM concurrentes para respetar rate limits del proveedor. */
export const LLM_CONCURRENCY = 4;

export const nearMissWindowMs = 6 * 60 * 60 * 1000;
export const LLM_Z_MIN = 2.5;
export const LLM_Z_MAX = 3;

/**
 * Umbrales del pipeline configurables (F7): el servicio acepta un override y
 * los defaults viven aquí — los literales de detector/clasificador ya no son
 * la única fuente. `zThreshold`/`persistentDeviation`/`sustainedHours`/
 * `dqConsumptionTolerance`/`dqStdRatio` alimentan al detector; `llmZMin`/
 * `llmZMax`/`nearMissWindowMs` al clasificador.
 */
export interface AnalysisConfig {
  zThreshold: number;
  persistentDeviation: number;
  sustainedHours: number;
  dqConsumptionTolerance: number;
  dqStdRatio: number;
  llmZMin: number;
  llmZMax: number;
  nearMissWindowMs: number;
}

export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = {
  zThreshold: Z_THRESHOLD,
  persistentDeviation: PERSISTENT_DEVIATION,
  sustainedHours: SUSTAINED_HOURS,
  dqConsumptionTolerance: DQ_CONSUMPTION_TOLERANCE,
  dqStdRatio: DQ_STD_RATIO,
  llmZMin: LLM_Z_MIN,
  llmZMax: LLM_Z_MAX,
  nearMissWindowMs,
};

// ---------------------------------------------------------------------------
// Score de fuerza de evidencia (confianza por reglas)
//
// La "confianza" de una anomalía clasificada POR REGLAS ya no es un mapa fijo
// severidad→probabilidad fabricada (0.99/0.9/0.8), sino un SCORE transparente
// derivado de la evidencia persistida: magnitud estadística + variación +
// cobertura de evento + severidad. NO es probabilidad de un modelo; es un
// indicador de cuánta evidencia sostiene la clasificación. El LLM solo aporta
// su propia confidence en el caso límite (needsLlm), donde SÍ hay una
// probabilidad reportada por el modelo.
// ---------------------------------------------------------------------------

/** Puntos mínimos del componente estadístico (|max_z| ≤ 3 o sin señales). */
export const CONFIDENCE_STAT_MIN = 12;
/** Puntos máximos del componente estadístico (|max_z| ≥ 10). */
export const CONFIDENCE_STAT_MAX = 40;
/** |max_z| donde el componente estadístico alcanza el tope. */
export const CONFIDENCE_STAT_MAX_Z = 10;
/** |max_z| donde el componente estadístico es mínimo. */
export const CONFIDENCE_STAT_MIN_Z = 3;
/** Puntos mínimos del componente de variación (|variación| ≤ 5 %). */
export const CONFIDENCE_VARIATION_MIN = 4;
/** Puntos máximos del componente de variación (|variación| ≥ 100 %). */
export const CONFIDENCE_VARIATION_MAX = 20;
/** |variación| % donde el componente de variación alcanza el tope. */
export const CONFIDENCE_VARIATION_MAX_PCT = 100;
/** |variación| % donde el componente de variación es mínimo. */
export const CONFIDENCE_VARIATION_MIN_PCT = 5;
/** Puntos del componente de evento cuando un evento cubre el rango exacto. */
export const CONFIDENCE_EVENT_COVERED = 20;
/** Puntos del componente de evento sin cobertura (neutral, no penaliza). */
export const CONFIDENCE_EVENT_NEUTRAL = 10;
/** Puntos del componente de severidad (peso de la clasificación). */
export const CONFIDENCE_SEVERITY: Record<Severity, number> = {
  HIGH: 20,
  MEDIUM: 14,
  LOW: 10,
};
/** sd_ratio mínimo para el fallback estadístico de DATA_QUALITY (≤ → mínimo). */
export const CONFIDENCE_SD_RATIO_MIN = 5;
/** sd_ratio donde el fallback estadístico de DATA_QUALITY alcanza el tope. */
export const CONFIDENCE_SD_RATIO_MAX = 10;

/** Lee una señal numérica de forma defensiva: solo números finitos, si no null. */
function readSignalNumber(signals: unknown, key: string): number | null {
  if (typeof signals !== "object" || signals === null) return null;
  const value = (signals as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Interpolación lineal saturada entre (minInput, minPoints) y (maxInput, maxPoints). */
function linearPoints(
  value: number,
  minInput: number,
  maxInput: number,
  minPoints: number,
  maxPoints: number,
): number {
  if (value <= minInput) return minPoints;
  if (value >= maxInput) return maxPoints;
  return minPoints + ((value - minInput) / (maxInput - minInput)) * (maxPoints - minPoints);
}

/** Componente estadístico (hasta 40 pts): |max_z|; si falta, sd_ratio de DQ; si no, mínimo. */
function statisticalPoints(signals: unknown): number {
  const maxZ = readSignalNumber(signals, "max_z");
  if (maxZ !== null) {
    return linearPoints(
      Math.abs(maxZ),
      CONFIDENCE_STAT_MIN_Z,
      CONFIDENCE_STAT_MAX_Z,
      CONFIDENCE_STAT_MIN,
      CONFIDENCE_STAT_MAX,
    );
  }
  // DATA_QUALITY persiste max_z null: la magnitud es la incoherencia eléctrica,
  // medida por el mayor sd_ratio (voltaje o factor de potencia) vs baseline.
  const voltageSd = readSignalNumber(signals, "voltage_sd_ratio");
  const pfSd = readSignalNumber(signals, "power_factor_sd_ratio");
  const sdRatio = voltageSd !== null && pfSd !== null ? Math.max(voltageSd, pfSd) : (voltageSd ?? pfSd);
  if (sdRatio !== null) {
    return linearPoints(
      sdRatio,
      CONFIDENCE_SD_RATIO_MIN,
      CONFIDENCE_SD_RATIO_MAX,
      CONFIDENCE_STAT_MIN,
      CONFIDENCE_STAT_MAX,
    );
  }
  return CONFIDENCE_STAT_MIN;
}

/** Componente de variación (hasta 20 pts): |variation_pct|; sin señal, mínimo. */
function variationPoints(signals: unknown): number {
  const variation = readSignalNumber(signals, "variation_pct");
  if (variation === null) return CONFIDENCE_VARIATION_MIN;
  return linearPoints(
    Math.abs(variation),
    CONFIDENCE_VARIATION_MIN_PCT,
    CONFIDENCE_VARIATION_MAX_PCT,
    CONFIDENCE_VARIATION_MIN,
    CONFIDENCE_VARIATION_MAX,
  );
}

/**
 * Score de fuerza de evidencia (0-1) de una anomalía clasificada POR REGLAS.
 *
 * Fórmula: clamp(0, 1, round((statistical + variation + event + severity) / 100, 2))
 *  - statistical (40): |signals.max_z| — ≤ 3 → 12, ≥ 10 → 40, lineal entre ambos.
 *    Si max_z es null (p. ej. DATA_QUALITY): max(voltage_sd_ratio,
 *    power_factor_sd_ratio) — ≤ 5 → 12, ≥ 10 → 40, lineal; si tampoco hay → 12.
 *  - variation (20): |signals.variation_pct| — ≤ 5 % → 4, ≥ 100 % → 20, lineal.
 *  - event (20): 20 si un evento cubre el rango exacto (eventCovered), 10 si no.
 *  - severity (20): HIGH → 20, MEDIUM → 14, LOW → 10.
 *
 * Es un SCORE de evidencia, NO una probabilidad de un modelo. El LLM conserva
 * su propia confidence solo en el camino borderline (needsLlm). La lectura de
 * `signals` es defensiva (Json de forma libre): valores no numéricos o
 * no finitos se tratan como ausentes.
 */
export function computeAnomalyConfidence(input: {
  severity: Severity;
  signals: unknown;
  eventCovered: boolean;
}): number {
  const raw =
    statisticalPoints(input.signals) +
    variationPoints(input.signals) +
    (input.eventCovered ? CONFIDENCE_EVENT_COVERED : CONFIDENCE_EVENT_NEUTRAL) +
    CONFIDENCE_SEVERITY[input.severity];
  return Math.min(1, Math.max(0, Math.round((raw / 100) * 100) / 100));
}

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
  return `Idea principal: ${variation}\n\nEl sistema no pudo consultar al asistente automático, así que esta explicación se generó automáticamente.`;
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