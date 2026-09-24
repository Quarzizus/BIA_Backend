import { z } from "zod";
import { SYSTEM_PROMPT } from "../../shared/domain/llm";
import type { ExplainInput, ExplainOutput } from "../../shared/domain/llm";

/**
 * LLM explanation builder (design D7/D8): builds the Spanish prompt for a
 * confirmed anomaly and validates the model's JSON reply. Pure functions,
 * testable without any network — the HTTP transport lives in llm.client.ts.
 *
 * The system prompt and I/O contracts are shared via shared/domain/llm.
 */

export type { ExplainInput, ExplainOutput };

const explanationSchema = z.object({
  reason: z.string().min(1),
  recommended_action: z.string().min(1),
});

/** Builds the chat messages for explaining a confirmed anomaly. */
export function buildExplainPrompt(
  anomaly: ExplainInput,
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