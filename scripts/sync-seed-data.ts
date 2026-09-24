import { basename, dirname, join } from "node:path";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";

/**
 * Copia los CSVs canónicos del dataset desde docs/ a prisma/seed-data/ para que
 * el seed sea independiente del directorio de trabajo (decisión de diseño D1).
 *
 * Los archivos fuente se resuelven relativos a la ubicación de este script, NO
 * al cwd, de modo que `bun scripts/sync-seed-data.ts` funcione desde cualquier
 * directorio (docker compose incluido). Falla con ruido cuando un fuente falta
 * o está vacío.
 */

const REPO_ROOT = dirname(import.meta.dir);
const SEED_DATA_DIR = join(REPO_ROOT, "prisma", "seed-data");

const SOURCES = ["docs/readings.csv", "docs/events.csv"] as const;

export function copySeedData(): string[] {
  const copied: string[] = [];
  for (const relativePath of SOURCES) {
    const source = join(REPO_ROOT, relativePath);
    if (!existsSync(source)) {
      throw new Error(`sync-seed-data: source file missing: ${source}`);
    }
    if (statSync(source).size === 0) {
      throw new Error(`sync-seed-data: source file is empty: ${source}`);
    }
    mkdirSync(SEED_DATA_DIR, { recursive: true });
    const destination = join(SEED_DATA_DIR, basename(source));
    copyFileSync(source, destination);
    copied.push(destination);
  }
  return copied;
}

if (import.meta.main) {
  try {
    const copied = copySeedData();
    for (const file of copied) {
      console.log(`sync-seed-data: copied ${file}`);
    }
  } catch (error) {
    console.error(`sync-seed-data: ${(error as Error).message}`);
    process.exit(1);
  }
}