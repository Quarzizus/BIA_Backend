// Superficie pública del módulo imports (importación de lecturas CSV).
// Los consumidores externos importan desde aquí — nunca desde rutas internas.

export { createImportsRouter } from "./imports.routes";

export { createImportsService } from "./imports.service";
export type { ImportsService } from "./imports.service";

export type {
  ImportRowError,
  ImportRunStatus,
  ImportSummary,
  ImportsRepository,
} from "./imports.domain";
export {
  IMPORT_CSV_HEADER,
  IMPORT_MAX_DATA_ROWS,
  IMPORT_MAX_FILE_SIZE_BYTES,
  IMPORT_ROW_ERRORS,
} from "./imports.domain";