/**
 * Dominio de anomalías — tipos puros, DTOs y contratos service/repository.
 *
 * Sin schemas zod (viven en anomaly.model.ts) y sin Prisma client. El contrato
 * del repository trabaja contra la forma estructural `AnomalyRow`; el payload
 * concreto acoplado a persistencia (`AnomalyWithRelations`) queda en
 * anomaly.repository.ts y lo satisface estructuralmente.
 */

import type {
  AnomalyStatus,
  AnomalyType,
  EventType,
  Severity,
} from "../../generated/prisma/enums";

export interface AnomalyFilters {
  status?: AnomalyStatus;
  severity?: Severity;
}

export interface AnomalyListItem {
  id: string;
  meter_id: string;
  type: string;
  severity: string;
  confidence: number;
  status: string;
  recommended_action: string | null;
  recommended_action_simple: string | null;
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
  reason_simple: string | null;
  related_event: RelatedEventDto | null;
  analysis_run_id: string;
}

export interface AnomalyRow {
  id: string;
  meterId: string;
  meter: { meterId: string } | null;
  type: AnomalyType;
  severity: Severity;
  confidence: number;
  status: AnomalyStatus;
  recommendedAction: string | null;
  recommendedActionSimple: string | null;
  detectedAt: Date;
  rangeStart: Date;
  rangeEnd: Date;
  detectionType: string;
  signals: unknown;
  reason: string | null;
  reasonSimple: string | null;
  relatedEvent: {
    id: string;
    eventType: EventType;
    eventTimestamp: Date;
    description: string;
  } | null;
  analysisRunId: string;
}

export interface AnomalyService {
  list(filters: AnomalyFilters): Promise<AnomalyListItem[]>;
  detail(id: string): Promise<AnomalyDetail>;
  updateStatus(id: string, status: AnomalyStatus): Promise<AnomalyDetail>;
}

export interface AnomalyRepository {
  list(filters: AnomalyFilters): Promise<AnomalyRow[]>;
  findById(id: string): Promise<AnomalyRow | null>;
  /** Persiste la transición y recalcula Meter.status atómicamente (diseño D4). */
  updateStatusWithMeterRecompute(id: string, status: AnomalyStatus): Promise<void>;
}