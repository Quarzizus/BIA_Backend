/**
 * DTO de lectura + mapper — compartido por los módulos meters y readings
 * (antes duplicado en meter.service y reading.service).
 *
 * El mapper acepta cualquier fila con la forma estructural de una Reading de
 * Prisma; a propósito no importa el cliente de Prisma.
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