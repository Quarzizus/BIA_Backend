import { z } from "zod";

/**
 * LLM explanation builder (design D7/D8): builds the Spanish prompt for a
 * confirmed anomaly and validates the model's JSON reply. Pure functions,
 * testable without any network — the HTTP transport lives in llm.client.ts.
 */

export interface ExplainAnomaly {
  meterId: string;
  type: string;
  severity: string;
  detectionType: string;
  signals: Record<string, unknown>;
  rangeStart: string;
  rangeEnd: string;
}

export interface Explanation {
  reason: string;
  recommended_action: string;
}

const explanationSchema = z.object({
  reason: z.string().min(1),
  recommended_action: z.string().min(1),
});

const SYSTEM_PROMPT = [
  "Eres un analista experto en calidad de energía eléctrica industrial.",
  "Responde ÚNICAMENTE con JSON válido, sin texto adicional.",
  "Escribe la explicación (reason) y la acción recomendada (recommended_action) en español, concisas y técnicas.",
].join(" ");

/** Builds the chat messages for explaining a confirmed anomaly. */
export function buildExplainPrompt(
  anomaly: ExplainAnomaly,
): { role: string; content: string }[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        "Explica la siguiente anomalía confirmada: genera reason (por qué es una anomalía) y recommended_action (acción recomendada) en español.",
        "Datos del caso:",
        JSON.stringify(anomaly, null, 2),
      ].join("\n"),
    },
  ];
}

/** Validates the LLM's JSON reply and returns the explanation contract. */
export function parseExplanation(content: string): Explanation {
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