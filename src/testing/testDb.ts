import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { parseCsv, normalizeTimestampToUtc } from "../../prisma/seed";

/**
 * Bases de datos aisladas por archivo de test de integración.
 *
 * Cada archivo de test que toca la base aprovisiona la suya propia
 * (`bia_test_<dominio>`) dentro del mismo servidor Postgres de compose, de modo
 * que los archivos que `bun test` corre en paralelo (un proceso por archivo)
 * nunca compiten por el mismo estado: se eliminan las carreras por conteos
 * exactos (p. ej. 12 vs 13 medidores) y las afirmaciones pueden ser estrictas.
 * El dataset sembrado es idéntico al del seed real (12 meters / 4032 readings /
 * 4 events), reutilizando los helpers puros del seed.
 */

const ADMIN_URL = process.env.DATABASE_URL ?? "postgresql://bia:bia@localhost:5432/bia_dev";

/** URL de una base aislada por nombre, en el mismo servidor Postgres de compose. */
export function testDbUrl(dbName: string): string {
  return `postgresql://bia:bia@localhost:5432/${dbName}`;
}

async function withPg(url: string, fn: (client: import("pg").Client) => Promise<void>): Promise<void> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

async function databaseExists(client: import("pg").Client, name: string): Promise<boolean> {
  const result = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Garantiza que la base aislada `<dbName>` exista con el schema actual.
 * Idempotente: seguro llamarlo desde el beforeAll de cada archivo de test.
 */
export async function provisionTestDb(dbName: string): Promise<void> {
  // 1. Crear la base si falta (conexión admin a la base de mantenimiento).
  const adminUrl = ADMIN_URL.replace(/\/[^/]*$/, "/postgres");
  await withPg(adminUrl, async (admin) => {
    if (!(await databaseExists(admin, dbName))) {
      await admin.query(`CREATE DATABASE ${dbName} OWNER bia`);
    }
  });

  // 2. Aplicar el SQL de migración si falta el schema (idempotente).
  await withPg(testDbUrl(dbName), async (client) => {
    const tables = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'meters'",
    );
    if (tables.rowCount === 0) {
      const migrationDir = join(import.meta.dir, "../../prisma/migrations");
      const files = await import("node:fs/promises").then((fs) => fs.readdir(migrationDir));
      const initMigration = files.find((f) => f.includes("init"));
      if (!initMigration) throw new Error(`provisionTestDb: init migration not found for ${dbName}`);
      const sql = readFileSync(join(migrationDir, initMigration, "migration.sql"), "utf8");
      await client.query(sql);
    }
  });
}

/**
 * Siembra la base aislada con el mismo dataset 12/4032/4, reutilizando los
 * helpers puros exportados del seed. Idempotente: si los conteos ya coinciden
 * no toca nada; si no, borra y recrea los datos dentro de una transacción.
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

/** Cliente Prisma conectado a la base aislada `<dbName>`. */
export function createTestPrisma(dbName: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: testDbUrl(dbName) });
  return new PrismaClient({ adapter });
}