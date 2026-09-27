import type { PrismaClient } from "../../generated/prisma/client";
import { ApiError } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { normalizeTimestampToUtc, parseCsv, splitCsvLine } from "../../shared/csv";
import { createImportsRepository } from "./imports.repository";
import {
  IMPORT_CSV_HEADER,
  IMPORT_MAX_DATA_ROWS,
  IMPORT_ROW_ERRORS,
  type ImportRowError,
  type ImportsRepository,
  type ImportsService,
  type ImportRunStatus,
} from "./imports.domain";

export type { ImportsService } from "./imports.domain";

/**
 * Orquestación de la importación de lecturas por CSV (espejo del patrón async
 * del análisis):
 *  - start(): valida estructura/header/límites de forma SÍNCRONA (400/413 antes
 *    del 202), crea el run PENDING y dispara `processImport` desacoplado.
 *  - processImport(): pipeline en segundo plano — BOM → parseCsv → header →
 *    validación fila a fila → dedupe en archivo → createMany con skipDuplicates
 *    → conteos → completeRun. Las filas inválidas NO bloquean el lote: se
 *    registran en `errors` y se persisten las válidas. Un error catastrófico
 *    (estructura ilegible, FK rota) → failRun.
 *  - getStatus(): contrato de polling para GET /readings/imports/:id.
 *
 * Solo orquestación: la persistencia vive en imports.repository y los tipos
 * puros en imports.domain.
 */

/** Headers de error por fila (códigos del contrato). */
const R = IMPORT_ROW_ERRORS;

/** Header esperado como array plano (para comparar con la primera fila). */
const EXPECTED_HEADER: readonly string[] = IMPORT_CSV_HEADER;

/**
 * Decodifica el buffer del CSV: tolera BOM de Excel/Windows (UTF-8 BOM) y
 * devuelve la primera fila (header) + las filas de datos (sin líneas en blanco).
 */
function decodeImportText(buffer: Buffer): { header: string[]; rows: Record<string, string>[] } {
  // BOM UTF-8 (\uFEFF) añadido por Excel/Windows al guardar CSV — se elimina
  // antes de cualquier parseo.
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0] ? splitCsvLine(lines[0]).map((column) => column.trim()) : [];
  if (!lines[0] || lines[0].trim() === "") {
    throw new ApiError(400, "EMPTY_FILE", "CSV is empty");
  }
  // parseCsv (helper compartido con el seed) + filtro de líneas totalmente en
  // blanco: no son datos, se ignoran (no cuentan como filas fallidas).
  const rows = parseCsv<Record<string, string>>(text).filter((row) =>
    Object.values(row).some((value) => value.trim() !== ""),
  );
  return { header, rows };
}

/**
 * Valida el header y los límites de forma SÍNCRONA (para responder 400/413
 * ANTES del 202). Lanza ApiError si el CSV no cumple el contrato.
 */
function assertValidStructure(text: Buffer): void {
  const { header } = decodeImportText(text);
  const headerOk =
    header.length === EXPECTED_HEADER.length &&
    header.every((column, index) => column === EXPECTED_HEADER[index]);
  if (!headerOk) {
    throw new ApiError(
      400,
      "INVALID_HEADER",
      `CSV header must be exactly: ${EXPECTED_HEADER.join(",")}`,
    );
  }
  const dataRows = decodeImportText(text).rows.length;
  if (dataRows === 0) {
    // CSV con solo el header (o sin filas de datos): no es un import, es un
    // archivo vacío → 400 (no un COMPLETED con total_rows: 0).
    throw new ApiError(400, "EMPTY_FILE", "CSV has no data rows");
  }
  if (dataRows > IMPORT_MAX_DATA_ROWS) {
    throw new ApiError(
      413,
      "IMPORT_LIMIT_EXCEEDED",
      `CSV has ${dataRows} data rows; the maximum is ${IMPORT_MAX_DATA_ROWS}`,
    );
  }
}

/**
 * Timestamp determinista: formatos naive ("2026-09-01 00:00:00", sin zona) se
 * interpretan como UTC vía normalizeTimestampToUtc (misma semántica que el
 * seed); ISO con zona (Z/offset) se parsea directo. Devuelve null si no es
 * parseable.
 */
function parseTimestamp(raw: string): Date | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const naive =
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(trimmed) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed);
  if (naive) {
    const normalized = normalizeTimestampToUtc(trimmed);
    return Number.isNaN(normalized.getTime()) ? null : normalized;
  }
  const direct = new Date(trimmed);
  return Number.isNaN(direct.getTime()) ? null : direct;
}

/** Número de línea real del CSV para una fila (1 = header, 2 = primera de datos). */
function csvLineNumber(index: number): number {
  return index + 2;
}

export function createImportsService(prisma: PrismaClient): ImportsService {
  const repository: ImportsRepository = createImportsRepository(prisma);

  async function processImport(runId: string, buffer: Buffer): Promise<void> {
    const run = await repository.findRun(runId);
    if (!run || run.status !== "PENDING") return;

    try {
      // Guard defensivo: start() ya validó estructura/header/límites, pero el
      // pipeline debe ser robusto si se invoca directamente.
      assertValidStructure(buffer);
      const { rows } = decodeImportText(buffer);

      // Códigos de medidor cargados UNA vez para todo el lote (en memoria).
      const meters = await repository.meterCodes();
      const meterIdByCode = new Map(meters.map((meter) => [meter.meterId, meter.id]));

      const errors: ImportRowError[] = [];
      const validRows: Array<{
        code: string;
        timestamp: Date;
        consumptionKwh: number;
        voltageV: number;
        currentA: number;
        powerFactor: number;
        status: string;
      }> = [];

      for (const [index, row] of rows.entries()) {
        const lineNumber = csvLineNumber(index);
        const meterCode = (row.meter_id ?? "").trim();

        // 1. Medidor: obligatorio y debe existir (código público → meter_not_found).
        if (!meterCode || !meterIdByCode.has(meterCode)) {
          errors.push({ row: lineNumber, meter_id: meterCode, error: R.meter_not_found });
          continue;
        }

        // 2. Timestamp: obligatorio y parseable.
        const timestamp = parseTimestamp(row.timestamp ?? "");
        if (!timestamp) {
          errors.push({ row: lineNumber, meter_id: meterCode, error: R.invalid_timestamp });
          continue;
        }

        // 3. Consumo: obligatorio, numérico y >= 0.
        const consumptionRaw = (row.consumption_kwh ?? "").trim();
        if (!consumptionRaw) {
          errors.push({ row: lineNumber, meter_id: meterCode, error: R.missing_consumption });
          continue;
        }
        const consumptionKwh = Number(consumptionRaw);
        if (!Number.isFinite(consumptionKwh) || consumptionKwh < 0) {
          errors.push({ row: lineNumber, meter_id: meterCode, error: R.invalid_number });
          continue;
        }

        // 4. Opcionales numéricos: vacíos → 0 (columnas Float no anulables en
        //    Prisma); no numéricos → invalid_number.
        const parseOptional = (raw: string | undefined): number | null => {
          const trimmed = (raw ?? "").trim();
          if (!trimmed) return 0;
          const value = Number(trimmed);
          return Number.isFinite(value) ? value : null;
        };
        const voltageV = parseOptional(row.voltage_v);
        if (voltageV === null) {
          errors.push({ row: lineNumber, meter_id: meterCode, error: R.invalid_number });
          continue;
        }
        const currentA = parseOptional(row.current_a);
        if (currentA === null) {
          errors.push({ row: lineNumber, meter_id: meterCode, error: R.invalid_number });
          continue;
        }

        // 5. Factor de potencia: opcional, numérico y en [0, 1].
        const powerFactor = parseOptional(row.power_factor);
        if (powerFactor === null) {
          errors.push({ row: lineNumber, meter_id: meterCode, error: R.invalid_number });
          continue;
        }
        if (powerFactor < 0 || powerFactor > 1) {
          errors.push({ row: lineNumber, meter_id: meterCode, error: R.invalid_power_factor });
          continue;
        }

        // 6. Status: opcional, default "OK".
        const status = (row.status ?? "").trim() || "OK";

        validRows.push({
          code: meterCode,
          timestamp,
          consumptionKwh,
          voltageV,
          currentA,
          powerFactor,
          status,
        });
      }

      // Dedupe EN ARCHIVO: mismo (meter_id, timestamp) → gana la primera fila;
      // las siguientes cuentan como skipped_duplicates.
      const seen = new Set<string>();
      const uniqueRows: typeof validRows = [];
      let skippedInFile = 0;
      for (const row of validRows) {
        const key = `${row.code}|${row.timestamp.getTime()}`;
        if (seen.has(key)) {
          skippedInFile++;
          continue;
        }
        seen.add(key);
        uniqueRows.push(row);
      }

      // Carrera benigna con otras operaciones (documentada a propósito):
      //  - entre meterCodes() y el createMany un medidor podría eliminarse →
      //    FK rota → P2003 → error catastrófico → failRun (run FAILED claro).
      //  - dos importaciones concurrentes con el mismo (meterId, timestamp):
      //    skipDuplicates hace que UNA gane y la otra cuente como
      //    skipped_duplicates — sin locks, sin deadlocks, sin duplicados.
      const data = uniqueRows.map((row) => ({
        meterId: meterIdByCode.get(row.code)!,
        timestamp: row.timestamp,
        consumptionKwh: row.consumptionKwh,
        voltageV: row.voltageV,
        currentA: row.currentA,
        powerFactor: row.powerFactor,
        status: row.status,
      }));

      const inserted = data.length > 0 ? await repository.insertReadings(data) : 0;
      // Omitidas por la base (par meterId+timestamp ya existente).
      const skippedInDb = data.length - inserted;
      const skippedDuplicates = skippedInFile + skippedInDb;

      await repository.completeRun(runId, {
        totalRows: rows.length,
        imported: inserted,
        skippedDuplicates,
        failedRows: errors.length,
        errors,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("import run failed", { runId, error: message });
      await repository.failRun(runId, message);
    }
  }

  return {
    async start(fileName, buffer) {
      // Validación síncrona ANTES del 202: header incorrecto → 400, límite de
      // filas excedido → 413 (el cliente ve el error sin crear un run).
      assertValidStructure(buffer);

      const run = await repository.createRun(fileName);
      // Ejecución asíncrona desacoplada: responder 202 primero, luego procesar.
      void processImport(run.id, buffer).catch((err) => {
        logger.error("import run crashed outside FAILED handler", {
          runId: run.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return { import_id: run.id, status: "PENDING" };
    },

    async processImport(runId, buffer) {
      await processImport(runId, buffer);
    },

    async getStatus(runId: string): Promise<ImportRunStatus> {
      const run = await repository.findRun(runId);
      if (!run) {
        throw new ApiError(404, "NOT_FOUND", `Import run ${runId} not found`);
      }
      return {
        id: run.id,
        status: run.status,
        started_at: run.startedAt.toISOString(),
        completed_at: run.completedAt?.toISOString() ?? null,
        summary: {
          total_rows: run.totalRows,
          imported: run.imported,
          skipped_duplicates: run.skippedDuplicates,
          failed_rows: run.failedRows,
        },
        errors: (run.errors as ImportRowError[] | null) ?? [],
      };
    },
  };
}