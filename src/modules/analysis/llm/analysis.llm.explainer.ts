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
        "Explica la siguiente anomalía confirmada: genera reason (por qué es una anomalía) y recommended_action (acción recomendada) en español.",
        'Formato de reason: 2-3 párrafos cortos separados por una línea en blanco ("\\n\\n"), cada párrafo de 1-3 frases.',
        'Formato de recommended_action: lista markdown de 2-4 items, cada uno con prefijo "- " y una sola frase imperativa.',
        'IMITA EXACTAMENTE este formato (respeta "\\n\\n" entre párrafos y "- " por item):',
        'reason: "El consumo pasó de 43.7 a 92.8 kWh/h (+112.3%), con un pico de |z| 9.73 a las 14:00 del 12-sep.\\n\\nNo hay evento que explique la señal: el medidor no registró mantenimiento ni cambios operativos.\\n\\nEl impacto es alto: el consumo se duplicó y se mantiene elevado."',
        'recommended_action: "- Inspeccionar el medidor y sus conexiones.\\n- Verificar la carga conectada al circuito.\\n- Revisar el historial de las últimas 48 horas."',
        "Datos del caso:",
        JSON.stringify(anomaly, null, 2),
        ...(evidenceLines.length > 0
          ? ["", "Evidencia por variable (baseline → reciente):", ...evidenceLines]
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