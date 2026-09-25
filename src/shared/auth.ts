import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import type { Auth } from "../config/auth";
import { ApiError } from "./errors";

/** Forma del resultado de getSession (session + user) tipada para los handlers. */
export type AuthSessionData = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- patrón requerido por @types/express para aumentar Request.
  namespace Express {
    interface Request {
      /** Usuario autenticado (presente solo tras pasar `requireAuth`). */
      user?: AuthSessionData["user"];
      /** Sesión activa de better-auth (presente solo tras pasar `requireAuth`). */
      session?: AuthSessionData["session"];
    }
  }
}

/**
 * Middleware de autenticación para las rutas de negocio.
 *
 * Lee la cookie de sesión httpOnly de la petición y la valida contra
 * better-auth (`getSession`). Sin sesión válida → `ApiError(401, UNAUTHORIZED)`
 * que el envelope de errores responde como `{"error":{"code":"UNAUTHORIZED",...}}`.
 * Con sesión válida adjunta `req.user` / `req.session` al request.
 */
export function createRequireAuth(auth: Auth) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) {
        throw new ApiError(401, "UNAUTHORIZED", "Authentication required");
      }
      req.user = session.user;
      req.session = session.session;
      next();
    } catch (err) {
      next(err);
    }
  };
}