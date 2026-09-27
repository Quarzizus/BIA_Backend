/**
 * Helpers CSV compartidos (seed + importación de lecturas).
 *
 * Viven aquí para que `prisma/seed.ts` y `src/modules/imports/` reutilicen la
 * MISMA implementación de parseo y normalización de timestamps — una sola
 * fuente de verdad para el formato de los archivos CSV del proyecto.
 */

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