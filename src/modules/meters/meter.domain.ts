import type { Meter, Reading } from "../../generated/prisma/client";
import type { BaselineStats } from "../../shared/domain/baseline";

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
  // Nota: sin `history` — el frontend carga el historial paginado vía
  // GET /meters/:meterId/readings.
}

export interface MeterService {
  list(): Promise<MeterSummary[]>;
  detail(meterId: string): Promise<MeterDetail>;
}

export interface MeterRepository {
  listMeters(): Promise<Meter[]>;
  findMeterByCode(meterId: string): Promise<Meter | null>;
  /** Última lectura por medidor, keyed por el CÓDIGO del medidor (la columna `meterId`). */
  latestReadings(meterCodes: string[]): Promise<Reading[]>;
  /** Ventana de baseline de primeros 7 días por medidor, keyed por el CÓDIGO del medidor. */
  baselineReadings(meterCodes: string[]): Promise<Reading[]>;
}