import type { PrismaClient } from "../generated/prisma/client";
import { createAuth } from "../config/auth";

/**
 * Helper de autenticación para los tests que pasan por `createApp` (app.test.ts,
 * analysis.e2e.test.ts y app.auth.test.ts).
 *
 * Los tests de módulo que montan routers directos con `startTestServer` NO pasan
 * por `requireAuth` y no necesitan sesión. Los que construyen la app completa sí:
 * este helper crea el admin en la base aislada (mismo flujo de sign-up que el
 * seed) y devuelve la cookie de sesión httpOnly para mandarla en `headers`.
 */

// Mejor práctica de better-auth: el secreto debe ser estable por proceso, o las
// cookies firmadas por una instancia no se validan en otra del mismo proceso
// (p. ej. la segunda app aislada del e2e de análisis). En tests el .env no lo
// define; se fija un valor de test estable (>= 32 chars).
process.env.BETTER_AUTH_SECRET ??= "bia-backend-test-secret-0123456789abcdef";

export const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@example.com";
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "Admin123!";

/**
 * Crea el usuario admin en la base aislada vía el mismo flujo de sign-up de
 * better-auth que usa el seed. Idempotente: si el email ya existe, no hace nada.
 */
export async function ensureAdminUser(prisma: PrismaClient): Promise<void> {
  const auth = createAuth(prisma);
  const existing = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  if (existing) return;

  const result = await auth.api.signUpEmail({
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: "Administrador" },
  });
  if (!result.token) {
    throw new Error("authTestHelper: sign-up of admin user returned no token");
  }
}

/** Extrae la cookie de sesión (`better-auth.session_token=...`) de una respuesta. */
function extractSessionCookie(res: Response): string {
  const setCookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : ([res.headers.get("set-cookie")].filter(Boolean) as string[]);
  const sessionCookie =
    setCookies.find((cookie) => cookie.startsWith("better-auth.session_token=")) ?? setCookies[0];
  if (!sessionCookie) {
    throw new Error("authTestHelper: sign-in response carried no session cookie");
  }
  // El header Cookie solo lleva `name=value`; los atributos (Path, HttpOnly...) no.
  return sessionCookie.split(";")[0]!;
}

/**
 * Inicia sesión contra el servidor en `baseUrl` con las credenciales admin y
 * devuelve el header `cookie` listo para `fetch(headers: { cookie })`.
 */
export async function signInAndGetCookie(
  baseUrl: string,
  email: string = ADMIN_EMAIL,
  password: string = ADMIN_PASSWORD,
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) {
    throw new Error(`authTestHelper: sign-in failed with status ${res.status}`);
  }
  return extractSessionCookie(res);
}