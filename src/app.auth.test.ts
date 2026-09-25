import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import { createTestPrisma, provisionTestDb, seedTestDb } from "./testing/testDb";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ensureAdminUser,
  signInAndGetCookie,
} from "./testing/authTestHelper";
import { createApp } from "./app";

/**
 * Tests de autenticación (Opción A): todas las rutas de negocio requieren la
 * cookie de sesión httpOnly emitida por better-auth; `/`, `/docs`,
 * `/openapi.yaml` y `/api/auth/*` son públicas. Base aislada propia
 * (bia_test_auth) para no romper el patrón una-base-por-archivo.
 */
const prisma = createTestPrisma("bia_test_auth");

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await provisionTestDb("bia_test_auth");
  await seedTestDb(prisma);
  await ensureAdminUser(prisma);
  const app = createApp(prisma);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe("authentication (Option A)", () => {
  test("GET /meters without a cookie → 401 UNAUTHORIZED envelope", async () => {
    const res = await fetch(`${baseUrl}/meters`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("GET /meters with the session cookie → 200", async () => {
    const cookie = await signInAndGetCookie(baseUrl);
    const res = await fetch(`${baseUrl}/meters`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(12);
  });

  test("GET /api/auth/get-session returns the authenticated user", async () => {
    const cookie = await signInAndGetCookie(baseUrl);
    const res = await fetch(`${baseUrl}/api/auth/get-session`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { email: string }; session: { userId: string } };
    expect(body.user.email).toBe(ADMIN_EMAIL);
    expect(body.session.userId).toBeTruthy();
  });

  test("GET /api/auth/get-session without a cookie → 200 with null (better-auth contract)", async () => {
    const res = await fetch(`${baseUrl}/api/auth/get-session`);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  test("public routes still work without auth: / and /openapi.yaml", async () => {
    const health = await fetch(`${baseUrl}/`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { status: string }).status).toBe("ok");

    const spec = await fetch(`${baseUrl}/openapi.yaml`);
    expect(spec.status).toBe(200);
    expect(spec.headers.get("content-type")).toContain("application/yaml");
  });

  test("sign-in flow: wrong password → 401 error; correct → session cookie", async () => {
    const wrong = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: "wrong-password" }),
    });
    expect(wrong.status).toBe(401);

    const ok = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { token: string; user: { email: string } };
    expect(body.token).toBeTruthy();
    expect(body.user.email).toBe(ADMIN_EMAIL);
    expect(ok.headers.get("set-cookie")).toContain("better-auth.session_token=");
  });

  test("sign-out invalidates the session: cookie stops working on business routes", async () => {
    const cookie = await signInAndGetCookie(baseUrl);

    const signedOut = await fetch(`${baseUrl}/api/auth/sign-out`, {
      method: "POST",
      headers: { cookie },
    });
    expect(signedOut.status).toBe(200);

    const afterSignOut = await fetch(`${baseUrl}/meters`, { headers: { cookie } });
    expect(afterSignOut.status).toBe(401);
  });
});