import type { AnalysisRun } from "../../generated/prisma/client";
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

/** KPI "Último análisis" — fecha/hora y estado del run más reciente (sin datos completos). */
export interface LastAnalysisDto {
  id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  anomaly_count: number;
  /** Alcance del run: código del medidor si fue por medidor (?meter_id=), null si global. */
  meter_id: string | null;
}

export interface DashboardSummary {
  total_consumption: number;
  meters_alert: number;
  meters_critical: number;
  open_by_severity: { HIGH: number; MEDIUM: number; LOW: number };
  /** Conteos por severidad de TODAS las anomalías (cualquier estado, incl. RESOLVED) — agregación server-exacta para donut/KPIs. */
  severity_counts: { HIGH: number; MEDIUM: number; LOW: number };
  recent_anomalies: RecentAnomalyDto[];
  /** Último análisis ejecutado (null si nunca se ha corrido uno). */
  last_analysis: LastAnalysisDto | null;
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
  /** Run de análisis más reciente (null si nunca se ha ejecutado uno). */
  lastAnalysis(): Promise<AnalysisRun | null>;
}