import { z } from "zod";
import { SYSTEM_PROMPT } from "../../../shared/domain/llm";
import type { ExplainInput, ExplainOutput } from "../../../shared/domain/llm";

/**
 * Builder de explicaciones LLM (diseño D7/D8): construye el prompt en español
 * para una anomalía confirmada y valida la respuesta JSON del modelo. Funciones
 * puras, testeables sin red — el transporte HTTP vive en llm.client.ts.
 *
 * El system prompt y los contratos I/O se comparten vía shared/domain/llm.
 */

export type { ExplainInput, ExplainOutput };

const explanationSchema = z.object({
  reason: z.string().min(1),
  recommended_action: z.string().min(1),
  reason_simple: z.string().min(1),
  recommended_action_simple: z.string().min(1),
});

/**
 * Líneas legibles de evidencia por variable (baseline → reciente) para que el
 * modelo cite los números concretos. Sin evidencia → lista vacía (el prompt
 * sigue incluyendo las señales crudas en JSON).
 */
function formatVariableEvidence(signals: Record<string, unknown>): string[] {
  const perVariable = signals.per_variable;
  if (typeof perVariable !== "object" || perVariable === null) return [];

  const lines: string[] = [];
  for (const [variable, raw] of Object.entries(perVariable as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const evidence = raw as Record<string, unknown>;
    const fmt = (value: unknown): string =>
      typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "n/d";
    const variation =
      typeof evidence.variation_pct === "number" && Number.isFinite(evidence.variation_pct)
        ? `${evidence.variation_pct >= 0 ? "+" : ""}${evidence.variation_pct.toFixed(1)}%`
        : "n/d";
    lines.push(
      `${variable}: baseline ${fmt(evidence.baseline_mean)} → reciente ${fmt(evidence.recent_mean)} (${variation}), max_z ${fmt(evidence.max_z)}`,
    );
  }
  return lines;
}

export function buildExplainPrompt(
  anomaly: ExplainInput,
): { role: string; content: string }[] {
  const evidenceLines = formatVariableEvidence(anomaly.signals);
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        "Explica la siguiente anomalía confirmada: genera reason (por qué es una anomalía), recommended_action (acción recomendada), reason_simple (explicación en lenguaje cotidiano) y recommended_action_simple (pasos cotidianos) en español.",
        'Formato de reason: 2-3 párrafos cortos separados por una línea en blanco ("\\n\\n"), cada párrafo de 1-3 frases.',
        'Formato de recommended_action: lista markdown de 2-4 items, cada uno con prefijo "- " y una sola frase imperativa.',
        'Formato de reason_simple: empieza SIEMPRE con "Idea principal: " seguida de UNA frase corta (máx 2 líneas) que resuma el problema en lenguaje cotidiano; luego una línea en blanco y el resto de la explicación (contexto/analogías) SIN jerga técnica; si mencionas un concepto, explícalo con una analogía entendible.',
        'Formato de recommended_action_simple: 2-3 pasos cotidianos con prefijo "- ", que cualquier persona pueda seguir.',
        'IMITA EXACTAMENTE este formato (respeta "\\n\\n" entre párrafos y "- " por item):',
        'reason: "El consumo pasó de 43.7 a 92.8 kWh/h (+112.3%), con un pico de |z| 9.73 a las 14:00 del 12-sep.\\n\\nNo hay evento que explique la señal: el medidor no registró mantenimiento ni cambios operativos.\\n\\nEl impacto es alto: el consumo se duplicó y se mantiene elevado."',
        'recommended_action: "- Inspeccionar el medidor y sus conexiones.\\n- Verificar la carga conectada al circuito.\\n- Revisar el historial de las últimas 48 horas."',
        'reason_simple: "Idea principal: El medidor M-109 está consumiendo casi el doble de lo normal desde el 12 de septiembre.\\n\\nLa caída en la eficiencia eléctrica sugiere que algo se conectó o se dañó en la instalación."',
        'recommended_action_simple: "- Llama a un electricista para revisar la instalación.\\n- Verifica si se conectó un equipo nuevo en esos días.\\n- Pide revisar el medidor si el problema persiste."',
        "Datos del caso:",
        JSON.stringify(anomaly, null, 2),
        ...(evidenceLines.length > 0
          ? ["", "Evidencia por variable (baseline → reciente):", ...evidenceLines]
          : []),
        ...(anomaly.related_event
          ? [
              "",
              "EVENTO RELACIONADO REGISTRADO EN EL SISTEMA:",
              `- Tipo: ${anomaly.related_event.event_type}`,
              `- Timestamp: ${anomaly.related_event.event_timestamp}`,
              `- Descripción: ${anomaly.related_event.description}`,
              "Este evento explica la señal detectada. Tu explicación DEBE citarlo y no afirmar que no hay evento ni que nadie avisó al sistema.",
            ]
          : []),
      ].join("\n"),
    },
  ];
}

export function parseExplanation(content: string): ExplainOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error("LLM explanation is not valid JSON");
  }
  const parsed = explanationSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`LLM explanation failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}