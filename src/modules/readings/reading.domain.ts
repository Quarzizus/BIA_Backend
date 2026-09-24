/**
 * Readings domain — pure types and the service/repository contracts.
 *
 * No zod schemas (they live in reading.model.ts) and no Prisma client: the
 * repository interface only imports Prisma types for its rows.
 */

import type { Reading } from "../../generated/prisma/client";
import type { ReadingDto } from "../../shared/domain/reading";

/* ------------------------------------------------------------------ */
/* Service contract                                                    */
/* ------------------------------------------------------------------ */

export interface ReadingsService {
  list(meterId: string, range: { from?: string; to?: string }): Promise<ReadingDto[]>;
}

/* ------------------------------------------------------------------ */
/* Repository contract                                                 */
/* ------------------------------------------------------------------ */

export interface ReadingsRepository {
  meterExists(meterId: string): Promise<boolean>;
  findInRange(meterId: string, from?: Date, to?: Date): Promise<Reading[]>;
}