/**
 * Integración LLM — tipos de dominio compartidos y el único system prompt.
 *
 * La forma del entorno de IA (`LlmEnv`), los contratos I/O de classify/explain y
 * el SYSTEM_PROMPT en español se comparten entre el cliente LLM
 * (analysis.llm.client) y el builder de explicaciones (analysis.llm.explainer).
 * Tipos puros + una constante: sin schemas zod aquí (viven con los validadores
 * que los usan).
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
  reason_simple: string;
  recommended_action_simple: string;
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
  reason_simple: string;
  recommended_action_simple: string;
}

export const SYSTEM_PROMPT = [
  "Eres un analista experto en calidad de energía eléctrica industrial.",
  "Responde ÚNICAMENTE con JSON válido, sin texto adicional.",
  "Escribe la explicación (reason) y la acción recomendada (recommended_action) en español, concisas y técnicas.",
  'Formato obligatorio de reason: 2-3 párrafos cortos separados por una línea en blanco ("\\n\\n"), cada párrafo de 1-3 frases.',
  'NUNCA devuelvas un muro de texto: separa SIEMPRE los párrafos de reason con "\\n\\n".',
  'Formato obligatorio de recommended_action: lista markdown de 2-4 items, cada uno con prefijo "- " y una sola frase imperativa en español.',
  'NO numeres los items con "1)", "2." ni similar: usa SIEMPRE "- ".',
  "Además, escribe reason_simple y recommended_action_simple en español COTIDIANO, sin jerga técnica: si mencionas un concepto (consumo, eficiencia, medidor), explícalo con una analogía entendible.",
  'Formato obligatorio de reason_simple: 1-2 párrafos cortos separados por una línea en blanco ("\\n\\n"), cada párrafo de 1-2 frases, en lenguaje de uso diario.',
  'Formato obligatorio de recommended_action_simple: lista de 2-3 pasos cotidianos, cada uno con prefijo "- ", que cualquier persona pueda seguir.',
].join(" ");