import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ApiError, formatZodIssues, mapErrorToResponse } from "./errors";

describe("ApiError", () => {
  test("carries status, code and message", () => {
    const err = new ApiError(404, "NOT_FOUND", "Meter not found");
    expect(err.status).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Meter not found");
    expect(err).toBeInstanceOf(Error);
  });

  test("defaults message to code when omitted", () => {
    const err = new ApiError(409, "CONFLICT");
    expect(err.message).toBe("CONFLICT");
  });
});

describe("mapErrorToResponse", () => {
  test("ApiError maps to its own status and code", () => {
    const mapped = mapErrorToResponse(
      new ApiError(409, "INVALID_STATUS_TRANSITION", "Illegal transition"),
    );
    expect(mapped.status).toBe(409);
    expect(mapped.body).toEqual({
      error: { code: "INVALID_STATUS_TRANSITION", message: "Illegal transition" },
    });
  });

  test("ZodError maps to 400 VALIDATION_ERROR", () => {
    const parsed = z.object({ from: z.string().datetime() }).safeParse({ from: "not-a-date" });
    if (parsed.success) throw new Error("fixture expected to fail validation");
    const mapped = mapErrorToResponse(parsed.error);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error.code).toBe("VALIDATION_ERROR");
  });

  test("Prisma P2025 maps to 404 NOT_FOUND", () => {
    const mapped = mapErrorToResponse({ code: "P2025", meta: { modelName: "Meter" } });
    expect(mapped.status).toBe(404);
    expect(mapped.body.error.code).toBe("NOT_FOUND");
  });

  test("Prisma P2002 on lockToken maps to 409 ANALYSIS_IN_PROGRESS", () => {
    const mapped = mapErrorToResponse({ code: "P2002", meta: { target: ["lockToken"] } });
    expect(mapped.status).toBe(409);
    expect(mapped.body.error.code).toBe("ANALYSIS_IN_PROGRESS");
  });

  test("Prisma P2002 on another field maps to 409 CONFLICT", () => {
    const mapped = mapErrorToResponse({ code: "P2002", meta: { target: ["meterId"] } });
    expect(mapped.status).toBe(409);
    expect(mapped.body.error.code).toBe("CONFLICT");
  });

  test("unknown error maps to 500 INTERNAL_ERROR", () => {
    const mapped = mapErrorToResponse(new Error("boom"));
    expect(mapped.status).toBe(500);
    expect(mapped.body.error.code).toBe("INTERNAL_ERROR");
  });
});

describe("formatZodIssues", () => {
  test("includes the failing field path and message", () => {
    const parsed = z.object({ from: z.string().datetime() }).safeParse({ from: "x" });
    if (parsed.success) throw new Error("fixture expected to fail validation");
    const message = formatZodIssues(parsed.error);
    expect(message).toContain("from");
    expect(message).toContain("Invalid");
  });
});