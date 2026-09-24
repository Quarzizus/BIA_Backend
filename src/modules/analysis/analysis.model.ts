import { z } from "zod";

/** Route-param validation for GET /ai/analysis/:id. */
export const analysisIdParam = z.object({
  id: z.string().min(1, "id is required"),
});