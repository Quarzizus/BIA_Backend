import {
  DEFAULT_ANALYSIS_CONFIG,
  EVENT_MAPPING,
  type AnalysisConfig,
  type ClassifyInput,
  type Classification,
  type MeterEvent,
} from "../analysis.domain";

/**
 * Etapa 3 — Clasificador.
 *
 * Mapea una detección consolidada (una por medidor por run) a un tipo y
 * severidad de anomalía usando cobertura de eventos: `event_timestamp ∈
 * [rangeStart, rangeEnd]`. La señal DATA_QUALITY tiene prioridad. Los casos
 * límite (llmZMin <= maxZ < llmZMax o un evento near-miss a ±6h del rango) se
 * enrutan al LLM.
 *
 * Los tipos, constantes y el config de umbrales viven en analysis.domain; este
 * archivo mantiene las reglas.
 */

export type { ClassifyInput, Classification, MeterEvent } from "../analysis.domain";
export type { AnalysisConfig } from "../analysis.domain";
export { LLM_Z_MIN, LLM_Z_MAX, nearMissWindowMs } from "../analysis.domain";

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

/** Evento a ±nearMissWindowMs del rango pero fuera de él → candidato a LLM (borderline). */
export function nearMissEvent(
  input: ClassifyInput,
  config: AnalysisConfig = DEFAULT_ANALYSIS_CONFIG,
): MeterEvent | null {
  const start = input.rangeStart.getTime();
  const end = input.rangeEnd.getTime();
  return (
    input.events.find((event) => {
      const ts = event.eventTimestamp.getTime();
      if (ts >= start && ts <= end) return false;
      return (
        Math.abs(ts - start) <= config.nearMissWindowMs ||
        Math.abs(ts - end) <= config.nearMissWindowMs
      );
    }) ?? null
  );
}

/**
 * Clasificación basada en reglas con enrutamiento al LLM. Prioridad:
 * detección DATA_QUALITY > mapeo del evento de cobertura > REAL_ANOMALY/HIGH.
 * Borde (|z| en [llmZMin, llmZMax) o evento near-miss) → needsLlm true.
 */
export function classifyAnomaly(
  input: ClassifyInput,
  config: AnalysisConfig = DEFAULT_ANALYSIS_CONFIG,
): Classification {
  const event = coveringEvent(input);

  // La señal DATA_QUALITY tiene prioridad de clasificación (reglas del pipeline de 3 etapas de la spec).
  if (input.detectionType.includes("DATA_QUALITY")) {
    return { type: "DATA_QUALITY", severity: "HIGH", needsLlm: false, coveringEvent: event?.eventType ?? null };
  }

  const borderlineZ =
    input.maxZ !== null && input.maxZ >= config.llmZMin && input.maxZ < config.llmZMax;
  const nearMiss = nearMissEvent(input, config) !== null;

  if (borderlineZ || nearMiss) {
    return { type: "REAL_ANOMALY", severity: "HIGH", needsLlm: true, coveringEvent: null };
  }

  if (event) {
    const mapped = EVENT_MAPPING[event.eventType];
    return { type: mapped.type, severity: mapped.severity, needsLlm: false, coveringEvent: event.eventType };
  }

  return { type: "REAL_ANOMALY", severity: "HIGH", needsLlm: false, coveringEvent: null };
}