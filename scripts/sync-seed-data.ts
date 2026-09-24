import { basename, dirname, join } from "node:path";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";

/**
 * Copies the canonical dataset CSVs from docs/ into prisma/seed-data/ so the
 * seed is independent of the working directory (design decision D1).
 *
 * Source files are resolved relative to this script's location, NOT the cwd,
 * so `bun scripts/sync-seed-data.ts` works from any directory (docker compose
 * included). Fails loudly when a source is missing or empty.
 */

const REPO_ROOT = dirname(import.meta.dir); // scripts/ -> repo root
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