import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { parseCsv, normalizeTimestampToUtc } from "../../prisma/seed";

/**
 * Isolated analysis-pipeline test database.
 *
 * The analysis tests persist RUNNING analysis runs and anomalies; running them
 * against the shared bia_dev DB would race with parallel test files that assert
 * exact global state (server.test.ts sweeps RUNNING runs; anomalies.test.ts
 * asserts an exact anomaly count). This helper provisions a dedicated `bia_test`
 * database inside the same compose Postgres server and seeds it with the same
 * deterministic dataset, so the pipeline tests are fully isolated.
 */

const ADMIN_URL = process.env.DATABASE_URL ?? "postgresql://bia:bia@localhost:5432/bia_dev";
export const TEST_DB_URL = "postgresql://bia:bia@localhost:5432/bia_test";

async function withPg(url: string, fn: (client: any) => Promise<void>): Promise<void> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

async function databaseExists(client: any, name: string): Promise<boolean> {
  const result = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  return result.rowCount > 0;
}

/**
 * Ensures the isolated `bia_test` database exists with the current schema.
 * Idempotent: safe to call from every test file's beforeAll.
 */
export async function provisionTestDb(): Promise<void> {
  // 1. Create the database if missing (admin connection to the maintenance DB).
  const adminUrl = ADMIN_URL.replace(/\/[^/]*$/, "/postgres");
  await withPg(adminUrl, async (admin) => {
    if (!(await databaseExists(admin, "bia_test"))) {
      await admin.query('CREATE DATABASE bia_test OWNER bia');
    }
  });

  // 2. Apply the migration SQL if the schema is missing (idempotent).
  await withPg(TEST_DB_URL, async (client) => {
    const tables = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'meters'",
    );
    if (tables.rowCount === 0) {
      const migrationDir = join(import.meta.dir, "../../prisma/migrations");
      const migrationName = readFileSync(join(migrationDir, "migration_lock.toml"), "utf8");
      void migrationName;
      const files = await import("node:fs/promises").then((fs) => fs.readdir(migrationDir));
      const initMigration = files.find((f) => f.includes("init"));
      if (!initMigration) throw new Error("provisionTestDb: init migration not found");
      const sql = readFileSync(join(migrationDir, initMigration, "migration.sql"), "utf8");
      await client.query(sql);
    }
  });
}

/**
 * Seeds the isolated database with the same 12/4032/4 dataset, reusing the
 * seed's exported pure helpers. Idempotent.
 */
export async function seedTestDb(prisma: PrismaClient): Promise<void> {
  const meterCount = await prisma.meter.count();
  const readingCount = await prisma.reading.count();
  const eventCount = await prisma.event.count();
  if (meterCount === 12 && readingCount === 4032 && eventCount === 4) {
    return;
  }

  const seedDir = join(import.meta.dir, "../../prisma/seed-data");
  const rawReadings = parseCsv<Record<string, string>>(
    readFileSync(join(seedDir, "readings.csv"), "utf8"),
  );
  const rawEvents = parseCsv<Record<string, string>>(
    readFileSync(join(seedDir, "events.csv"), "utf8"),
  );
  const meterIds = [...new Set(rawReadings.map((r) => r.meter_id))];

  await prisma.$transaction(async (tx) => {
    await tx.analysisRun.deleteMany();
    await tx.anomaly.deleteMany();
    await tx.event.deleteMany();
    await tx.reading.deleteMany();
    await tx.meter.deleteMany();

    await tx.meter.createMany({
      data: meterIds.map((meterId, index) => ({
        meterId: meterId!,
        name: `Meter ${meterId}`,
        location: `Site ${String(index + 1).padStart(2, "0")}`,
      })),
    });
    const meters = await tx.meter.findMany();
    const meterIdByCode = new Map(meters.map((m) => [m.meterId, m.id]));

    await tx.reading.createMany({
      data: rawReadings.map((r) => ({
        meterId: meterIdByCode.get(r.meter_id!)!,
        timestamp: normalizeTimestampToUtc(r.timestamp!),
        consumptionKwh: Number(r.consumption_kwh),
        voltageV: Number(r.voltage_v),
        currentA: Number(r.current_a),
        powerFactor: Number(r.power_factor),
        status: r.status!,
      })),
    });
    await tx.event.createMany({
      data: rawEvents.map((e) => ({
        meterId: meterIdByCode.get(e.meter_id!)!,
        eventTimestamp: normalizeTimestampToUtc(e.event_timestamp!),
        eventType: e.event_type as never,
        description: e.description!,
      })),
    });
  });
}

/** Builds a PrismaClient bound to the isolated test database. */
export function createTestPrisma(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: TEST_DB_URL });
  return new PrismaClient({ adapter });
}