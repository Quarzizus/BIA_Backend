import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { EventType } from "../src/generated/prisma/enums";

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
 * Normaliza un timestamp CSV naive ("2026-09-01 00:00:00" o "2026-09-11 00:00")
 * a un Date UTC reemplazando el espacio por "T", completando segundos y
 * añadiendo "Z". Determinista: la misma fila produce siempre el mismo instante.
 */
export function normalizeTimestampToUtc(raw: string): Date {
  const withT = raw.trim().replace(" ", "T");
  const hasSeconds = /T\d{2}:\d{2}:\d{2}$/.test(withT);
  const normalized = hasSeconds ? withT : `${withT}:00`;
  return new Date(`${normalized}Z`);
}

export function splitCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

export function parseCsv<T>(text: string): T[] {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0];
  if (!header) {
    throw new Error("seed: CSV is empty");
  }
  const columns = splitCsvLine(header).map((column) => column.trim());
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const record: Record<string, string> = {};
    columns.forEach((column, index) => {
      record[column] = values[index] ?? "";
    });
    return record as T;
  });
}

function readSeedCsv<T>(fileName: string): T[] {
  const filePath = join(SEED_DATA_DIR, fileName);
  if (!existsSync(filePath)) {
    throw new Error(`seed: missing seed data file: ${filePath}. Run \`bun run sync-seed\` first.`);
  }
  return parseCsv<T>(readFileSync(filePath, "utf8"));
}

/**
 * Seed determinista e idempotente. Cuando los conteos ya coinciden con el
 * dataset (12 meters / 4032 readings / 4 events) omite; si no, borra y recrea
 * los datos dentro de una sola transacción.
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
    return;
  }

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
        consumptionKwh: Number(reading.consumption_kwh),
        voltageV: Number(reading.voltage_v),
        currentA: Number(reading.current_a),
        powerFactor: Number(reading.power_factor),
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

if (import.meta.main) {
  await seed();
}