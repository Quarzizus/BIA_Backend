import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import type { PrismaClient } from "../generated/prisma/client";

/**
 * Instancia de better-auth cableada al mismo PrismaClient de la app (el
 * singleton de getPrisma() en producción, o el cliente de la base aislada en
 * tests). El adaptador Prisma persiste User/Session/Account/Verification.
 *
 * `secret` y `baseURL` vienen del entorno (BETTER_AUTH_SECRET / BETTER_AUTH_URL,
 * ver .env.example). Sin `secret` better-auth advierte y genera uno por
 * proceso: suficiente para desarrollo, pero en producción es obligatorio.
 */
export function createAuth(prisma: PrismaClient) {
  return betterAuth({
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailAndPassword: {
      enabled: true,
      // MVP sin registro público: la única cuenta se siembra en el seed (admin).
      disableSignUp: false,
    },
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
    // Orígenes que better-auth acepta en el header Origin (CSRF). El navegador
    // manda Origin: http://localhost:5173 aunque la llamada vaya por el proxy de
    // Vite (la página es de ese origen); sin esto el sign-in devuelve
    // INVALID_ORIGIN. Se sobreescribe con FRONTEND_ORIGIN si el frontend corre
    // en otro puerto/dominio.
    trustedOrigins: [process.env.FRONTEND_ORIGIN ?? "http://localhost:5173"],
  });
}

export type Auth = ReturnType<typeof createAuth>;