import type { Reading } from "../../generated/prisma/client";
import type { ReadingDto } from "../../shared/domain/reading";

export interface ReadingsService {
  list(meterId: string, range: { from?: string; to?: string }): Promise<ReadingDto[]>;
}

export interface ReadingsRepository {
  meterExists(meterId: string): Promise<boolean>;
  findInRange(meterId: string, from?: Date, to?: Date): Promise<Reading[]>;
}