import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// dotenv garantiza que DATABASE_URL se resuelva incluso cuando el proceso CLI no
// hereda el .env auto-cargado por Bun (p. ej. `bunx prisma`).
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});