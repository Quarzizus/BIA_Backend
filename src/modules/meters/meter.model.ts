import { z } from "zod";

export const meterIdParam = z.object({
  meterId: z.string().min(1, "meterId is required"),
});
export type MeterIdParam = z.infer<typeof meterIdParam>;

export interface SignalStatsDto {
  mean: number | null;
  std: number | null;
}

export interface BaselineDto {
  consumption_kwh: SignalStatsDto;
  voltage_v: SignalStatsDto;
  current_a: SignalStatsDto;
  power_factor: SignalStatsDto;
}

export interface ReadingDto {
  timestamp: string;
  consumption_kwh: number;
  voltage_v: number;
  current_a: number;
  power_factor: number;
  status: string;
}

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
  baseline: BaselineDto;
  variation_pct: number | null;
  history: ReadingDto[];
}