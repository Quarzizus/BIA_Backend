import { z } from "zod";

// All five environment variables the app needs. AI_* vars are validated as
// strings but allowed to be empty at startup: per spec ai-integration, a
// missing key fails fast at analysis time (POST /ai/analyze → AI_NOT_CONFIGURED),
// and PR2 read APIs do not depend on the LLM at all.
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  AI_API_KEY: z.string().default(""),
  AI_BASE_URL: z.string().default(""),
  AI_MODEL: z.string().default(""),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type Env = z.infer<typeof envSchema>;

export type ParseEnvResult = { ok: true; env: Env } | { ok: false; issues: string[] };

/** Validates the environment without side effects; returns issues when invalid. */
export function parseEnv(
  input: Record<string, string | undefined> = process.env,
): ParseEnvResult {
  const parsed = envSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, env: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    }),
  };
}

/** Loads the environment, printing a clear message and exiting(1) on invalid input. */
export function loadEnv(input: Record<string, string | undefined> = process.env): Env {
  const result = parseEnv(input);
  if (!result.ok) {
    console.error("[config] invalid environment variables:");
    for (const issue of result.issues) {
      console.error(`  - ${issue}`);
    }
    process.exit(1);
  }
  return result.env;
}

if (import.meta.main) {
  loadEnv();
  console.log("[config] environment OK");
}