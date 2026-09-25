import { createHash, randomUUID } from "node:crypto";
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

/** Tabla de tracking de Prisma; se crea si falta (bases legacy sin tracking). */
const PRISMA_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id" TEXT PRIMARY KEY,
    "checksum" TEXT NOT NULL,
    "finished_at" TIMESTAMPTZ,
    "migration_name" TEXT NOT NULL,
    "logs" TEXT,
    "rolled_back_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count" INTEGER NOT NULL DEFAULT 0
  );
`;

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

  // 2. Aplicar TODAS las migraciones pendientes en orden cronológico, con
  //    tracking en _prisma_migrations (mismo contrato que `prisma migrate`).
  //    Antes solo se aplicaba la migración init cuando faltaba la tabla
  //    "meters"; una base existente se quedaba con el schema viejo y rompía
  //    al añadir columnas nuevas. Ahora toda base (nueva o existente) termina
  //    con el schema actual.
  await withPg(testDbUrl(dbName), async (client) => {
    const migrationDir = join(import.meta.dir, "../../prisma/migrations");
    const fs = await import("node:fs/promises");
    const dirs = (await fs.readdir(migrationDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    // Tracking: asegura la tabla y lee las migraciones ya aplicadas.
    await client.query(PRISMA_MIGRATIONS_TABLE_SQL);
    const appliedResult = await client.query<{ migration_name: string }>(
      'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',
    );
    const applied = new Set(appliedResult.rows.map((row) => row.migration_name));

    const recordApplied = async (name: string, sql: string): Promise<void> => {
      // Prisma calcula el checksum de una migración SQL como el SHA-256 del archivo.
      const checksum = createHash("sha256").update(sql).digest("hex");
      await client.query(
        `INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "applied_steps_count")
         VALUES ($1, $2, now(), $3, 1)`,
        [randomUUID(), checksum, name],
      );
    };

    for (const dir of dirs) {
      if (applied.has(dir)) continue;
      const sql = readFileSync(join(migrationDir, dir, "migration.sql"), "utf8");

      // Bases legacy (aprovisionadas aplicando la init con SQL crudo, sin
      // tracking): la init ya está aplicada aunque _prisma_migrations no lo
      // diga. Se registra como aplicada SIN re-ejecutarla (los objetos existen).
      if (dir.includes("init")) {
        const meters = await client.query(
          "SELECT 1 FROM information_schema.tables WHERE table_name = 'meters'",
        );
        if ((meters.rowCount ?? 0) > 0) {
          await recordApplied(dir, sql);
          continue;
        }
      }

      // Migración pendiente: se aplica y se registra atómicamente.
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await recordApplied(dir, sql);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
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