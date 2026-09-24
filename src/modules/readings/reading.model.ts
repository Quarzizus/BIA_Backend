import { z } from "zod";
import { meterIdParam } from "../../shared/validation";

export { meterIdParam };

export const readingsQuery = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .refine(
    (query) =>
      query.from === undefined ||
      query.to === undefined ||
      new Date(query.from).getTime() <= new Date(query.to).getTime(),
    { message: "from must not be after to", path: ["from"] },
  );
export type ReadingsQuery = z.infer<typeof readingsQuery>;