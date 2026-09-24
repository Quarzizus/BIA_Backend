import { z } from "zod";
import { meterIdParam } from "../../shared/validation";

export { meterIdParam };
export type MeterIdParam = z.infer<typeof meterIdParam>;