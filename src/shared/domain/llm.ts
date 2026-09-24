/**
 * LLM integration — shared domain types and the single system prompt.
 *
 * The AI environment shape (`LlmEnv`), the classify/explain I/O contracts and
 * the Spanish SYSTEM_PROMPT are shared between the LLM client
 * (analysis.llm.client) and the explanation builder (analysis.llm.explainer).
 * Pure types + one constant: no zod schemas here (they live with the
 * validators that use them).
 */

export interface LlmEnv {
  AI_API_KEY: string;
  AI_BASE_URL: string;
  AI_MODEL: string;
}

export interface ClassifyInput {
  meterId: string;
  detectionType: string;
  signals: Record<string, unknown>;
  rangeStart: string;
  rangeEnd: string;
}

export interface ClassifyOutput {
  type: "REAL_ANOMALY" | "EXPLAINABLE_ANOMALY" | "FALSE_POSITIVE" | "DATA_QUALITY";
  severity: "HIGH" | "MEDIUM" | "LOW";
  reason: string;
  recommended_action: string;
}

export interface ExplainInput {
  meterId: string;
  type: string;
  severity: string;
  detectionType: string;
  signals: Record<string, unknown>;
  rangeStart: string;
  rangeEnd: string;
}

export interface ExplainOutput {
  reason: string;
  recommended_action: string;
}

/** Single system prompt for every LLM call (classify + explain). */
export const SYSTEM_PROMPT = [
  "Eres un analista experto en calidad de energía eléctrica industrial.",
  "Responde ÚNICAMENTE con JSON válido, sin texto adicional.",
  "Escribe la explicación (reason) y la acción recomendada (recommended_action) en español, concisas y técnicas.",
].join(" ");