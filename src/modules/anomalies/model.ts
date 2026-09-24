import { z } from "zod";

export const anomalyIdParam = z.object({
  id: z.string().min(1, "id is required"),
});

export const listQuery = z.object({
  status: z.enum(["OPEN", "INVESTIGATING", "RESOLVED"]).optional(),
  severity: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
});
export type ListQuery = z.infer<typeof listQuery>;

export const statusUpdate = z.object({
  status: z.enum(["OPEN", "INVESTIGATING", "RESOLVED"]),
});
export type StatusUpdate = z.infer<typeof statusUpdate>;

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