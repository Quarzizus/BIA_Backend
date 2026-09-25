import { z } from "zod";

export const analysisIdParam = z.object({
  id: z.string().min(1, "id is required"),
});

/** Query de POST /ai/analyze: `meter_id` opcional limita el análisis a un medidor. */
export const analyzeQuery = z.object({
  meter_id: z.string().min(1).optional(),
});