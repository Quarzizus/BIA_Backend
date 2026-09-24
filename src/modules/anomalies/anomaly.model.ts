import { z } from "zod";
import { AnomalyStatus, Severity } from "../../generated/prisma/enums";

export const anomalyIdParam = z.object({
  id: z.string().min(1, "id is required"),
});

export const listQuery = z.object({
  status: z.enum(AnomalyStatus).optional(),
  severity: z.enum(Severity).optional(),
});
export type ListQuery = z.infer<typeof listQuery>;

export const statusUpdate = z.object({
  status: z.enum(AnomalyStatus),
});
export type StatusUpdate = z.infer<typeof statusUpdate>;