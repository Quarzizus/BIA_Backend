import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// dotenv ensures DATABASE_URL resolves even when the CLI process does not
// inherit Bun's auto-loaded .env (e.g. `bunx prisma`).
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});