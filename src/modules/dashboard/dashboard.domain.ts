/**
 * Dashboard domain — pure types, the DTOs and the service/repository contracts.
 *
 * No zod schemas (nothing to validate on the summary route yet — a
 * dashboard.model.ts will appear when query params exist) and no Prisma
 * client: the repository contract only imports Prisma enums for its rows.
 */

import type { MeterStatus, Severity } from "../../generated/prisma/enums";

/** How many recent anomalies the dashboard summary exposes. */
export const RECENT_ANOMALIES_LIMIT = 5;

/* ------------------------------------------------------------------ */
/* API DTOs (previously in dashboard.service.ts)                       */
/* ------------------------------------------------------------------ */

export interface RecentAnomalyDto {
  id: string;
  meter_id: string;
  type: string;
  severity: string;
  status: string;
  detected_at: string;
}

export interface DashboardSummary {
  total_consumption: number;
  meters_alert: number;
  meters_critical: number;
  open_by_severity: { HIGH: number; MEDIUM: number; LOW: number };
  recent_anomalies: RecentAnomalyDto[];
}

/* ------------------------------------------------------------------ */
/* Repository row shapes                                               */
/* ------------------------------------------------------------------ */

export interface RecentAnomalyRow {
  id: string;
  meterId: string;
  meter: { meterId: string } | null;
  type: string;
  severity: string;
  status: string;
  detectedAt: Date;
}

/* ------------------------------------------------------------------ */
/* Contracts                                                           */
/* ------------------------------------------------------------------ */

export interface DashboardService {
  summary(): Promise<DashboardSummary>;
}

export interface DashboardRepository {
  totalConsumption(): Promise<number | null>;
  meterStatusCounts(): Promise<Array<{ status: MeterStatus; count: number }>>;
  openBySeverityCounts(): Promise<Array<{ severity: Severity; count: number }>>;
  recentAnomalies(limit: number): Promise<RecentAnomalyRow[]>;
}