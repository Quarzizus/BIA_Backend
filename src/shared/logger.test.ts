import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "./logger";

describe("logger", () => {
  test("info writes a JSON line with level, message and fields", () => {
    const spy = spyOn(console, "log");
    try {
      logger.info("boot complete", { port: 3000 });
      const line = spy.mock.calls[0]?.[0];
      expect(typeof line).toBe("string");
      const parsed = JSON.parse(line as string);
      expect(parsed.level).toBe("info");
      expect(parsed.msg).toBe("boot complete");
      expect(parsed.port).toBe(3000);
      expect(typeof parsed.ts).toBe("string");
    } finally {
      spy.mockRestore();
    }
  });

  test("error writes a JSON line to console.error", () => {
    const spy = spyOn(console, "error");
    try {
      logger.error("request failed", { code: "NOT_FOUND" });
      const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string);
      expect(parsed.level).toBe("error");
      expect(parsed.code).toBe("NOT_FOUND");
      expect(parsed.msg).toBe("request failed");
    } finally {
      spy.mockRestore();
    }
  });

  test("warn writes a JSON line to console.warn", () => {
    const spy = spyOn(console, "warn");
    try {
      logger.warn("slow query", { ms: 412 });
      const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string);
      expect(parsed.level).toBe("warn");
      expect(parsed.ms).toBe(412);
    } finally {
      spy.mockRestore();
    }
  });
});