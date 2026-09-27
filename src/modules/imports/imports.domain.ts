import type { ImportRun } from "../../generated/prisma/client";

/**
 * Tipos de dominio puro del módulo de importación de lecturas (CSV).
 *
 * El flujo es asíncrono (espejo del análisis): `POST /readings/import` responde
 * 202 con `{import_id, status}` y el procesamiento corre en segundo plano;
 * `GET /readings/imports/:id` expone el progreso y el resumen final.
 */

/** Header EXACTO del CSV (primera fila). El orden importa. */
export const IMPORT_CSV_HEADER = [
  "meter_id",
  "timestamp",
  "consumption_kwh",
  "voltage_v",
  "current_a",
  "power_factor",
  "status",
] as const;

/** Tamaño máximo del archivo (5 MB) — 413 IMPORT_LIMIT_EXCEEDED. */
export const IMPORT_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/** Máximo de filas de datos por importación (20.000) — 413 IMPORT_LIMIT_EXCEEDED. */
export const IMPORT_MAX_DATA_ROWS = 20_000;

/** Códigos de error por fila del CSV (contrato con el frontend). */
export const IMPORT_ROW_ERRORS = {
  meter_not_found: "meter_not_found",
  invalid_timestamp: "invalid_timestamp",
  missing_consumption: "missing_consumption",
  invalid_number: "invalid_number",
  invalid_power_factor: "invalid_power_factor",
} as const;

/** Resumen agregado de la importación (contrato GET /readings/imports/:id). */
export interface ImportSummary {
  total_rows: number;
  imported: number;
  skipped_duplicates: number;
  failed_rows: number;
}

/** Error de UNA fila del CSV (no bloquea el resto del lote). */
export interface ImportRowError {
  /** Número de línea del CSV (1 = header, 2 = primera fila de datos). */
  row: number;
  /** Código público del medidor de la fila (vacío si no se pudo leer). */
  meter_id: string;
  /** Código del error: meter_not_found | invalid_timestamp | missing_consumption | invalid_number | invalid_power_factor. */
  error: string;
}

/** Estado completo de un run de importación (contrato de polling). */
export interface ImportRunStatus {
  id: string;
  /** PENDING → PROCESSING → COMPLETED, o FAILED ante un error catastrófico. */
  status: string;
  started_at: string;
  completed_at: string | null;
  summary: ImportSummary;
  /** Errores por fila; en un run FAILED contiene el error fatal (row 0). */
  errors: ImportRowError[];
}

export interface ImportsService {
  /**
   * Valida estructura/header/límites de forma SÍNCRONA (400/413 antes del 202),
   * crea el run PENDING y dispara `processImport` desacoplado.
   */
  start(fileName: string, buffer: Buffer): Promise<{ import_id: string; status: string }>;
  /** Pipeline asíncrono: valida filas, deduplica e inserta; completa o falla el run. */
  processImport(runId: string, buffer: Buffer): Promise<void>;
  getStatus(runId: string): Promise<ImportRunStatus>;
}

export interface ImportsRepository {
  createRun(fileName: string): Promise<{ id: string; status: string }>;
  findRun(runId: string): Promise<ImportRun | null>;
  completeRun(
    runId: string,
    data: {
      totalRows: number;
      imported: number;
      skippedDuplicates: number;
      failedRows: number;
      errors: ImportRowError[];
    },
  ): Promise<void>;
  failRun(runId: string, message?: string): Promise<void>;
  /** Todos los medidores (id interno + código público) para el lookup meter_id → id. */
  meterCodes(): Promise<Array<{ id: string; meterId: string }>>;
  /** Inserta lecturas con `skipDuplicates` (meterId+timestamp ya existente se omite); devuelve el número insertado. */
  insertReadings(data: Array<{ meterId: string; timestamp: Date; consumptionKwh: number; voltageV: number; currentA: number; powerFactor: number; status: string }>): Promise<number>;
}