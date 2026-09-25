import type { Reading } from "../../generated/prisma/client";
import type { ReadingDto } from "../../shared/domain/reading";

/** Consulta de lecturas: rango opcional + paginación (página 1-indexada). */
export interface ReadingsQuery {
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

/** Envelope paginado de lecturas (contrato API, snake_case). */
export interface ReadingsListResponse {
  items: ReadingDto[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

export interface ReadingsService {
  list(meterId: string, query: ReadingsQuery): Promise<ReadingsListResponse>;
}

export interface ReadingsRepository {
  meterExists(meterId: string): Promise<boolean>;
  findInRange(meterId: string, from?: Date, to?: Date): Promise<Reading[]>;
}