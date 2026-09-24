import { z } from "zod";

export const analysisIdParam = z.object({
  id: z.string().min(1, "id is required"),
});