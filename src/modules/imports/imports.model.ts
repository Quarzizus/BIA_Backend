import { z } from "zod";

/** Parámetro de ruta de GET /readings/imports/:id — el id es un cuid. */
export const importIdParam = z.object({
  id: z.string().min(1, "id is required"),
});