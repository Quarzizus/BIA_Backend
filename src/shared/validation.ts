import { z } from "zod";

/** Shared route-param validation for meter-scoped endpoints (meters + readings). */
export const meterIdParam = z.object({
  meterId: z.string().min(1, "meterId is required"),
});