/**
 * Anomalies domain — pure types, DTOs and the service/repository contracts.
 *
 * No zod schemas (they live in anomaly.model.ts) and no Prisma client. The
 * repository contract works against the structural `AnomalyRow` shape; the
 * concrete persistence-coupled payload (`AnomalyWithRelations`) stays in
 * anomaly.repository.ts and structurally satisfies it.
 */

import type {
  AnomalyStatus,
  AnomalyType,
  EventType,
  Severity,
} from "../../generated/prisma/enums";

/* ------------------------------------------------------------------ */
/* List filters (typed with Prisma enums — kills the repository casts) */
/* ------------------------------------------------------------------ */

export interface AnomalyFilters {
  status?: AnomalyStatus;
  severity?: Severity;
}

/* ------------------------------------------------------------------ */
/* API DTOs (previously in anomaly.model.ts)                           */
/* ------------------------------------------------------------------ */

export interface AnomalyListItem {
  id: string;
  meter_id: string;
  type: string;
  severity: string;
  confidence: number;
  status: string;
  recommended_action: string | null;
  detected_at: string;
}

export interface RelatedEventDto {
  id: string;
  type: string;
  timestamp: string;
  description: string;
}

export interface AnomalyDetail extends AnomalyListItem {
  range_start: string;
  range_end: string;
  detection_type: string;
  signals: Record<string, unknown>;
  reason: string | null;
  related_event: RelatedEventDto | null;
  analysis_run_id: string;
}

/* ------------------------------------------------------------------ */
/* Repository row shape (what the service consumes)                    */
/* ------------------------------------------------------------------ */

export interface AnomalyRow {
  id: string;
  meterId: string;
  meter: { meterId: string } | null;
  type: AnomalyType;
  severity: Severity;
  confidence: number;
  status: AnomalyStatus;
  recommendedAction: string | null;
  detectedAt: Date;
  rangeStart: Date;
  rangeEnd: Date;
  detectionType: string;
  signals: unknown;
  reason: string | null;
  relatedEvent: {
    id: string;
    eventType: EventType;
    eventTimestamp: Date;
    description: string;
  } | null;
  analysisRunId: string;
}

/* ------------------------------------------------------------------ */
/* Contracts                                                           */
/* ------------------------------------------------------------------ */

export interface AnomalyService {
  list(filters: AnomalyFilters): Promise<AnomalyListItem[]>;
  detail(id: string): Promise<AnomalyDetail>;
  updateStatus(id: string, status: AnomalyStatus): Promise<AnomalyDetail>;
}

export interface AnomalyRepository {
  list(filters: AnomalyFilters): Promise<AnomalyRow[]>;
  findById(id: string): Promise<AnomalyRow | null>;
  /** Persists the transition and recomputes Meter.status atomically (design D4). */
  updateStatusWithMeterRecompute(id: string, status: AnomalyStatus): Promise<void>;
}