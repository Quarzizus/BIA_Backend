import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { EventType } from "../src/generated/prisma/enums";
import { createAuth } from "../src/config/auth";
import { normalizeTimestampToUtc, parseCsv } from "../src/shared/csv";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("seed: DATABASE_URL environment variable is required");
}

const adapter = new PrismaPg({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// Resuelto relativo a este archivo, nunca al cwd (decisión de diseño D1) —
// docker compose up debe funcionar desde cualquier directorio.
const SEED_DATA_DIR = join(import.meta.dir, "seed-data");

interface ReadingCsvRow {
  meter_id: string;
  timestamp: string;
  consumption_kwh: string;
  voltage_v: string;
  current_a: string;
  power_factor: string;
  status: string;
}

interface EventCsvRow {
  meter_id: string;
  event_timestamp: string;
  event_type: string;
  description: string;
}

const EVENT_TYPES: readonly string[] = [
  "OPERATIONAL_CHANGE",
  "SCHEDULED_OUTAGE",
  "DATA_QUALITY",
  "UNKNOWN",
];

/**
 * F8: convierte un campo numérico del CSV a number con validación explícita.
 * Un valor que no parsea (NaN) rompe el seed con un error claro en vez de
 * persistir silenciosamente un número corrupto en la base.
 */
export function parseNumericCsvField(
  raw: string,
  field: string,
  context: { meterId?: string; timestamp?: string } = {},
): number {
  // Número("") === 0: un campo vacío no debe silenciosamente volverse 0.
  if (raw.trim() === "") {
    const where = context.meterId ? ` (meter ${context.meterId}${context.timestamp ? `, ${context.timestamp}` : ""})` : "";
    throw new Error(`seed: empty value for numeric field "${field}"${where}`);
  }
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    const where = context.meterId ? ` (meter ${context.meterId}${context.timestamp ? `, ${context.timestamp}` : ""})` : "";
    throw new Error(`seed: invalid numeric value "${raw}" for field "${field}"${where}`);
  }
  return parsed;
}

function readSeedCsv<T>(fileName: string): T[] {
  const filePath = join(SEED_DATA_DIR, fileName);
  if (!existsSync(filePath)) {
    throw new Error(`seed: missing seed data file: ${filePath}. Run \`bun run sync-seed\` first.`);
  }
  return parseCsv<T>(readFileSync(filePath, "utf8"));
}

/**
 * Credenciales del usuario admin sembrado para la demo (ver README).
 * `ADMIN_PASSWORD` y `ADMIN_EMAIL` vienen del entorno; si faltan se usan los
 * defaults documentados. El password NO se imprime en los logs del seed.
 */
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@example.com";
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "Admin123!";

/**
 * Crea el usuario admin (idempotente) usando el flujo de sign-up de
 * better-auth: se reutiliza su hashing de password (scrypt) y la fila de
 * `account` con provider "credential", de modo que `/api/auth/sign-in/email`
 * acepta estas credenciales sin pasos extra.
 */
export async function seedAdminUser(prisma: PrismaClient): Promise<void> {
  const auth = createAuth(prisma);
  const existing = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  if (existing) {
    console.log(`seed: admin user ${ADMIN_EMAIL} already present — skipping`);
    return;
  }
  const result = await auth.api.signUpEmail({
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: "Administrador" },
  });
  if (!result.token) {
    throw new Error("seed: failed to create admin user (sign-up returned no token)");
  }
  console.log(
    `seed: admin user created (${ADMIN_EMAIL}) — password via ADMIN_PASSWORD env or documented default`,
  );
}

/**
 * Seed determinista e idempotente. Cuando los conteos ya coinciden con el
 * dataset (12 meters / 4032 readings / 4 events) omite; si no, borra y recrea
 * los datos dentro de una sola transacción. El usuario admin se asegura en
 * ambos caminos (dataset presente o recién insertado).
 */
export async function seed(): Promise<void> {
  const readings = readSeedCsv<ReadingCsvRow>("readings.csv");
  const events = readSeedCsv<EventCsvRow>("events.csv");
  const meterIds = [...new Set(readings.map((reading) => reading.meter_id))];

  for (const event of events) {
    if (!EVENT_TYPES.includes(event.event_type)) {
      throw new Error(`seed: unknown event type in events.csv: ${event.event_type}`);
    }
  }

  // F8: valida los campos numéricos de readings.csv ANTES de tocar la base —
  // un valor que no parsea (NaN) rompe el seed con un error claro, incluso en
  // un re-run idempotente que de otro modo haría skip.
  for (const reading of readings) {
    const context = { meterId: reading.meter_id, timestamp: reading.timestamp };
    parseNumericCsvField(reading.consumption_kwh, "consumption_kwh", context);
    parseNumericCsvField(reading.voltage_v, "voltage_v", context);
    parseNumericCsvField(reading.current_a, "current_a", context);
    parseNumericCsvField(reading.power_factor, "power_factor", context);
  }

  const [meterCount, readingCount, eventCount] = await Promise.all([
    prisma.meter.count(),
    prisma.reading.count(),
    prisma.event.count(),
  ]);

  if (
    meterCount === meterIds.length &&
    readingCount === readings.length &&
    eventCount === events.length
  ) {
    console.log(
      `seed: data already present (${meterCount} meters, ${readingCount} readings, ${eventCount} events) — skipping`,
    );
  } else {
    await prisma.$transaction(async (tx) => {
      await tx.analysisRun.deleteMany();
      await tx.anomaly.deleteMany();
      await tx.event.deleteMany();
      await tx.reading.deleteMany();
      await tx.meter.deleteMany();

      await tx.meter.createMany({
        data: meterIds.map((meterId, index) => ({
          meterId,
          name: `Meter ${meterId}`,
          location: `Site ${String(index + 1).padStart(2, "0")}`,
        })),
      });

      const meters = await tx.meter.findMany();
      const meterIdByCode = new Map(meters.map((meter) => [meter.meterId, meter.id]));

      await tx.reading.createMany({
        data: readings.map((reading) => ({
          meterId: meterIdByCode.get(reading.meter_id)!,
          timestamp: normalizeTimestampToUtc(reading.timestamp),
          consumptionKwh: parseNumericCsvField(reading.consumption_kwh, "consumption_kwh", {
            meterId: reading.meter_id,
            timestamp: reading.timestamp,
          }),
          voltageV: parseNumericCsvField(reading.voltage_v, "voltage_v", {
            meterId: reading.meter_id,
            timestamp: reading.timestamp,
          }),
          currentA: parseNumericCsvField(reading.current_a, "current_a", {
            meterId: reading.meter_id,
            timestamp: reading.timestamp,
          }),
          powerFactor: parseNumericCsvField(reading.power_factor, "power_factor", {
            meterId: reading.meter_id,
            timestamp: reading.timestamp,
          }),
          status: reading.status,
        })),
      });

      await tx.event.createMany({
        data: events.map((event) => ({
          meterId: meterIdByCode.get(event.meter_id)!,
          eventTimestamp: normalizeTimestampToUtc(event.event_timestamp),
          eventType: event.event_type as EventType,
          description: event.description,
        })),
      });
    });

    console.log(
      `seed: inserted ${meterIds.length} meters, ${readings.length} readings, ${events.length} events`,
    );
  }

  // Usuario admin para la demo (autenticación por cookie, Opción A) — en ambos
  // caminos: dataset presente o recién insertado.
  await seedAdminUser(prisma);
}

if (import.meta.main) {
  await seed();
}