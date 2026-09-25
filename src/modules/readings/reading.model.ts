import { z } from "zod";
import { meterIdParam } from "../../shared/validation";

export { meterIdParam };

export const readingsQuery = z
  .object({
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    /** Página solicitada (1-indexada); los query strings llegan como texto y se coercionan a número. */
    page: z.coerce.number().int().min(1, "page must be >= 1").default(1),
    /** Tamaño de página, 1..1000 (las lecturas son la lista más grande de la API). */
    page_size: z.coerce.number().int().min(1, "page_size must be >= 1").max(1000, "page_size must be <= 1000").default(100),
  })
  .refine(
    (query) =>
      query.from === undefined ||
      query.to === undefined ||
      new Date(query.from).getTime() <= new Date(query.to).getTime(),
    { message: "from must not be after to", path: ["from"] },
  );
export type ReadingsQuery = z.infer<typeof readingsQuery>;