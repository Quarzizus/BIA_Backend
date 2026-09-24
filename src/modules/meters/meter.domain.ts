/**
 * Meters domain — pure types, DTOs and the service/repository contracts.
 *
 * No zod schemas (they live in meter.model.ts) and no Prisma client: the
 * repository interface only imports Prisma types for its rows.
 */

import type { Meter, Reading } from "../../generated/prisma/client";
import type { BaselineStats } from "../../shared/domain/baseline";
import type { ReadingDto } from "../../shared/domain/reading";

/* ------------------------------------------------------------------ */
/* API DTOs (previously in meter.model.ts)                             */
/* ------------------------------------------------------------------ */

export interface MeterSummary {
  id: string;
  meter_id: string;
  name: string;
  location: string;
  status: string;
  consumption_kwh: number | null;
  variation_pct: number | null;
  latest_reading_at: string | null;
}

export interface MeterDetail {
  id: string;
  meter_id: string;
  name: string;
  location: string;
  status: string;
  current: {
    consumption_kwh: number;
    voltage_v: number;
    current_a: number;
    power_factor: number;
    timestamp: string;
    status: string;
  } | null;
  baseline: BaselineStats;
  variation_pct: number | null;
  history: ReadingDto[];
}

/* ------------------------------------------------------------------ */
/* Service contract                                                    */
/* ------------------------------------------------------------------ */

export interface MeterService {
  list(): Promise<MeterSummary[]>;
  detail(meterId: string): Promise<MeterDetail>;
}

/* ------------------------------------------------------------------ */
/* Repository contract                                                 */
/* ------------------------------------------------------------------ */

export interface MeterRepository {
  listMeters(): Promise<Meter[]>;
  findMeterByCode(meterId: string): Promise<Meter | null>;
  /** Latest reading per meter, keyed by meter CODE (the `meterId` column). */
  latestReadings(meterCodes: string[]): Promise<Reading[]>;
  /** First-7-days baseline window per meter, keyed by meter CODE. */
  baselineReadings(meterCodes: string[]): Promise<Reading[]>;
  history(meterId: string): Promise<Reading[]>;
}