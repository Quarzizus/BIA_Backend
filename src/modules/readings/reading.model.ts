import { z } from "zod";

export const meterIdParam = z.object({
  meterId: z.string().min(1, "meterId is required"),
});

export const readingsQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type ReadingsQuery = z.infer<typeof readingsQuery>;

export interface ReadingDto {
  timestamp: string;
  consumption_kwh: number;
  voltage_v: number;
  current_a: number;
  power_factor: number;
  status: string;
}