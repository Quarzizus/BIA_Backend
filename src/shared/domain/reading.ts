/**
 * Reading API DTO + mapper — shared by the meters and readings modules
 * (previously duplicated in meter.service and reading.service).
 *
 * The mapper accepts any row structurally shaped like a Prisma Reading; it
 * intentionally does not import the Prisma client.
 */

export interface ReadingRow {
  timestamp: Date;
  consumptionKwh: number;
  voltageV: number;
  currentA: number;
  powerFactor: number;
  status: string;
}

export interface ReadingDto {
  timestamp: string;
  consumption_kwh: number;
  voltage_v: number;
  current_a: number;
  power_factor: number;
  status: string;
}

export function toReadingDto(reading: ReadingRow): ReadingDto {
  return {
    timestamp: reading.timestamp.toISOString(),
    consumption_kwh: reading.consumptionKwh,
    voltage_v: reading.voltageV,
    current_a: reading.currentA,
    power_factor: reading.powerFactor,
    status: reading.status,
  };
}