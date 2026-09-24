import { describe, expect, test } from "bun:test";
import { loadEnv, parseEnv } from "./env";

const valid = {
  DATABASE_URL: "postgresql://bia:bia@localhost:5432/bia_dev",
  AI_API_KEY: "sk-test",
  AI_BASE_URL: "https://api.example.com/v1",
  AI_MODEL: "gpt-4o",
  PORT: "3000",
};

describe("parseEnv", () => {
  test("returns parsed env with coerced PORT for valid input", () => {
    const result = parseEnv(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.DATABASE_URL).toBe(valid.DATABASE_URL);
    expect(result.env.AI_API_KEY).toBe("sk-test");
    expect(result.env.AI_MODEL).toBe("gpt-4o");
    expect(result.env.PORT).toBe(3000);
  });

  test("accepts missing AI vars as empty strings (analysis-time check, not startup)", () => {
    const result = parseEnv({ DATABASE_URL: valid.DATABASE_URL });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.AI_API_KEY).toBe("");
    expect(result.env.AI_BASE_URL).toBe("");
    expect(result.env.PORT).toBe(3000);
  });

  test("reports a clear issue when DATABASE_URL is missing", () => {
    const result = parseEnv({ PORT: "3000" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(" ")).toContain("DATABASE_URL");
  });

  test("reports an issue for non-numeric PORT", () => {
    const result = parseEnv({ ...valid, PORT: "abc" });
    expect(result.ok).toBe(false);
  });

  test("reports an issue for out-of-range PORT", () => {
    const result = parseEnv({ ...valid, PORT: "0" });
    expect(result.ok).toBe(false);
  });

  test("reports an issue for empty DATABASE_URL", () => {
    const result = parseEnv({ ...valid, DATABASE_URL: "" });
    expect(result.ok).toBe(false);
  });
});

describe("loadEnv", () => {
  test("exits with code 1 on invalid environment", async () => {
    const proc = Bun.spawn(["bun", "src/config/env.ts"], {
      env: { ...process.env, DATABASE_URL: "" },
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);
  });

  test("completes with code 0 on valid environment", async () => {
    const proc = Bun.spawn(["bun", "src/config/env.ts"], {
      env: { ...process.env, ...valid },
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });
});