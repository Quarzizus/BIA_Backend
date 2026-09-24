import { z } from "zod";
import { SYSTEM_PROMPT } from "../../../shared/domain/llm";
import type {
  ClassifyInput,
  ClassifyOutput,
  ExplainInput,
  ExplainOutput,
  LlmEnv,
} from "../../../shared/domain/llm";
import { buildExplainPrompt, parseExplanation } from "./analysis.llm.explainer";

/**
 * OpenAI-compatible LLM client (design D7/D8).
 *
 * Fail-fast by contract: the client only constructs a request and throws on any
 * provider error (timeout, HTTP error, malformed JSON, schema mismatch). There
 * is NO silent rule-based fallback — the caller fails the analysis run.
 *
 * The env shape, I/O contracts and SYSTEM_PROMPT are shared via shared/domain/llm.
 */

export type { ClassifyInput, ClassifyOutput, ExplainInput, ExplainOutput, LlmEnv } from "../../../shared/domain/llm";

const classifySchema = z.object({
  type: z.enum(["REAL_ANOMALY", "EXPLAINABLE_ANOMALY", "FALSE_POSITIVE", "DATA_QUALITY"]),
  severity: z.enum(["HIGH", "MEDIUM", "LOW"]),
  reason: z.string().min(1),
  recommended_action: z.string().min(1),
});

type JsonInput = Record<string, unknown>;

/** Builds chat messages for a task + JSON payload (stringified into content). */
function buildMessages(
  task: string,
  payload: JsonInput,
): { role: string; content: string }[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `${task}\nDatos del caso:\n${JSON.stringify(payload, null, 2)}`,
    },
  ];
}

export interface LlmClient {
  classify(input: ClassifyInput): Promise<ClassifyOutput>;
  explain(input: ExplainInput): Promise<ExplainOutput>;
}

export const LLM_TIMEOUT_MS = 10_000;

async function completeJson(
  env: LlmEnv,
  task: string,
  payload: Record<string, unknown>,
  schema: z.ZodType<unknown>,
): Promise<unknown> {
  const content = await completeJsonRaw(
    env,
    buildMessages(task, payload),
  );
  let messageJson: unknown;
  try {
    messageJson = JSON.parse(content);
  } catch {
    throw new Error("LLM message content is not valid JSON");
  }

  const result = schema.safeParse(messageJson);
  if (!result.success) {
    throw new Error(`LLM response failed validation: ${result.error.message}`);
  }
  return result.data;
}

/** Performs the chat completion and returns the raw message content string. */
async function completeJsonRaw(
  env: LlmEnv,
  messages: { role: string; content: string }[],
): Promise<string> {
  const url = `${env.AI_BASE_URL.replace(/\/$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${env.AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.AI_MODEL,
        messages,
        temperature: 0,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`LLM provider error: HTTP ${response.status}`);
  }

  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("LLM response is not valid JSON");
  }

  const content = (parsed as { choices?: { message?: { content?: unknown } }[] })
    ?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("LLM response is missing choices[0].message.content");
  }
  return content;
}

/** Classifies an ambiguous/borderline anomaly via the LLM. */
export async function classifyWithLlm(
  env: LlmEnv,
  input: ClassifyInput,
): Promise<ClassifyOutput> {
  const task = [
    "Clasifica la siguiente anomalía eléctrica ambigua (estadística o evento cercano sin cobertura).",
    "Devuelve type (REAL_ANOMALY | EXPLAINABLE_ANOMALY | FALSE_POSITIVE | DATA_QUALITY),",
    "severity (HIGH | MEDIUM | LOW), reason y recommended_action.",
  ].join("\n");
  const data = await completeJson(env, task, { ...input }, classifySchema as z.ZodType<unknown>);
  return data as unknown as ClassifyOutput;
}

/** Generates a Spanish reason + recommended_action for a confirmed anomaly. */
export async function explainWithLlm(
  env: LlmEnv,
  input: ExplainInput,
): Promise<ExplainOutput> {
  const messages = buildExplainPrompt(input);
  const content = await completeJsonRaw(env, messages);
  return parseExplanation(content);
}

/** Builds an injected LlmClient from environment configuration (design D8). */
export function createLlmClient(env: LlmEnv): LlmClient {
  return {
    classify: (input: ClassifyInput) => classifyWithLlm(env, input),
    explain: (input: ExplainInput) => explainWithLlm(env, input),
  };
}