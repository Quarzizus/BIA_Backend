import type { MeterStatus, Severity } from "../../generated/prisma/enums";

export const RECENT_ANOMALIES_LIMIT = 5;

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
  /** Conteos por severidad de TODAS las anomalías (cualquier estado, incl. RESOLVED) — agregación server-exacta para donut/KPIs. */
  severity_counts: { HIGH: number; MEDIUM: number; LOW: number };
  recent_anomalies: RecentAnomalyDto[];
}

export interface RecentAnomalyRow {
  id: string;
  meterId: string;
  meter: { meterId: string } | null;
  type: string;
  severity: string;
  status: string;
  detectedAt: Date;
}

export interface DashboardService {
  summary(): Promise<DashboardSummary>;
}

export interface DashboardRepository {
  totalConsumption(): Promise<number | null>;
  meterStatusCounts(): Promise<Array<{ status: MeterStatus; count: number }>>;
  openBySeverityCounts(): Promise<Array<{ severity: Severity; count: number }>>;
  severityCounts(): Promise<Array<{ severity: Severity; count: number }>>;
  recentAnomalies(limit: number): Promise<RecentAnomalyRow[]>;
}