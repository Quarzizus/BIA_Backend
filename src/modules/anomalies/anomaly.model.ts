import { z } from "zod";
import { AnomalyStatus, AnomalyType, Severity } from "../../generated/prisma/enums";

export const anomalyIdParam = z.object({
  id: z.string().min(1, "id is required"),
});

export const listQuery = z.object({
  status: z.enum(AnomalyStatus).optional(),
  severity: z.enum(Severity).optional(),
  sort: z.enum(["priority", "detected_at"]).default("priority"),
  /** Página solicitada (1-indexada); los query strings llegan como texto y se coercionan a número. */
  page: z.coerce.number().int().min(1, "page must be >= 1").default(1),
  /** Tamaño de página, 1..100. */
  page_size: z.coerce.number().int().min(1, "page_size must be >= 1").max(100, "page_size must be <= 100").default(20),
  /** Filtra por tipo de anomalía. */
  type: z.enum(AnomalyType).optional(),
  /** Filtra por el CÓDIGO público del medidor (p. ej. `M-109`), no por el FK interno. */
  meter_id: z.string().min(1, "meter_id must not be empty").optional(),
});
export type ListQuery = z.infer<typeof listQuery>;

export const statusUpdate = z.object({
  status: z.enum(AnomalyStatus),
});
export type StatusUpdate = z.infer<typeof statusUpdate>;