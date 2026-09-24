import { ZodError } from "zod";
import type { NextFunction, Request, Response } from "express";
import { logger } from "./logger";

/** Application error carrying an HTTP status and a stable machine-readable code. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ApiError";
  }
}

export interface ErrorResponseBody {
  error: { code: string; message: string };
}

export interface ErrorMapping {
  status: number;
  body: ErrorResponseBody;
}

/** Minimal structural shape of a Prisma known request error (code P####). */
interface PrismaErrorLike {
  code?: unknown;
  meta?: Record<string, unknown> | null;
}

function isPrismaErrorLike(err: unknown): err is PrismaErrorLike {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string" &&
    ((err as { code?: unknown }).code as string).startsWith("P")
  );
}

/**
 * Collects the constraint identifiers involved in a unique-constraint violation.
 * Prisma 6 exposes `meta.target` (column names); Prisma 7 with the driver
 * adapter nests them under `meta.driverAdapterError.cause.constraint.index`
 * (constraint name). Both shapes are handled so the lockToken check is robust.
 */
function uniqueTargets(meta: Record<string, unknown> | null | undefined): string[] {
  if (!meta) return [];
  const direct = meta.target;
  const targets: string[] = [];
  if (Array.isArray(direct)) targets.push(...direct.map(String));
  else if (typeof direct === "string") targets.push(direct);

  const adapter = meta.driverAdapterError as
    | { cause?: { constraint?: { index?: unknown }; table?: unknown } }
    | undefined;
  const index = adapter?.cause?.constraint?.index;
  if (typeof index === "string") targets.push(index);
  const table = adapter?.cause?.table;
  if (typeof table === "string") targets.push(table);
  return targets;
}

/** Human-readable rendering of zod issues ("field: message; ..."). */
export function formatZodIssues(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/**
 * Maps any thrown value to an HTTP response. Order matters: ApiError (app-level),
 * ZodError (validation → 400), Prisma known errors (P2025 → 404, P2002 → 409),
 * anything else → 500 INTERNAL_ERROR.
 */
export function mapErrorToResponse(err: unknown): ErrorMapping {
  if (err instanceof ApiError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message } } };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: formatZodIssues(err) } },
    };
  }
  if (isPrismaErrorLike(err)) {
    switch (err.code) {
      case "P2025":
        return {
          status: 404,
          body: { error: { code: "NOT_FOUND", message: "Resource not found" } },
        };
      case "P2002": {
        const targets = uniqueTargets(err.meta);
        const code = targets.some((target) => target.toLowerCase().includes("locktoken"))
          ? "ANALYSIS_IN_PROGRESS"
          : "CONFLICT";
        return {
          status: 409,
          body: {
            error: {
              code,
              message: `Unique constraint violated on ${targets.filter(Boolean).join(", ")}`,
            },
          },
        };
      }
    }
  }
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
  };
}

/** Express error middleware: maps any thrown error to a JSON error response. */
export function errorMiddleware(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const mapped = mapErrorToResponse(err);
  if (mapped.status >= 500) {
    logger.error("unhandled error", {
      method: req.method,
      path: req.path,
      status: mapped.status,
      error: err instanceof Error ? err.message : String(err),
    });
  } else {
    logger.warn("request error", {
      method: req.method,
      path: req.path,
      status: mapped.status,
      code: mapped.body.error.code,
    });
  }
  res.status(mapped.status).json(mapped.body);
}

/** Catch-all 404 for unmatched routes. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.path} not found` },
  });
}