import { z } from "zod";

// Las cinco variables de entorno que la app necesita. Las AI_* se validan como
// strings pero pueden estar vacías al arrancar: según la spec ai-integration,
// una clave ausente falla rápido en tiempo de análisis (POST /ai/analyze →
// AI_NOT_CONFIGURED), y las APIs de lectura del PR2 no dependen del LLM.
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  AI_API_KEY: z.string().default(""),
  AI_BASE_URL: z.string().default(""),
  AI_MODEL: z.string().default(""),
  // Mejor práctica de better-auth: el secreto se pasa como variable de entorno
  // y nunca se versiona. Sin él la app arranca con advertencia, pero en
  // producción es obligatorio (>= 32 caracteres).
  BETTER_AUTH_SECRET: z.string().min(1, "BETTER_AUTH_SECRET is required"),
  BETTER_AUTH_URL: z.string().min(1, "BETTER_AUTH_URL is required"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type Env = z.infer<typeof envSchema>;

export type ParseEnvResult = { ok: true; env: Env } | { ok: false; issues: string[] };

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