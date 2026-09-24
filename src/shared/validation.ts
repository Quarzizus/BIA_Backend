import { z } from "zod";

export const meterIdParam = z.object({
  meterId: z.string().min(1, "meterId is required"),
});