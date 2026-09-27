import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import type { PrismaClient } from "../../generated/prisma/client";
import { ApiError } from "../../shared/errors";
import { createImportsService, type ImportsService } from "./imports.service";
import { importIdParam } from "./imports.model";
import { IMPORT_MAX_FILE_SIZE_BYTES } from "./imports.domain";

/**
 * Rutas de importación de lecturas (CSV) — solo transporte:
 *  - POST /readings/import (multipart, campo `file`) → 202 {import_id, status};
 *    400 sin archivo o header incorrecto; 413 si el archivo supera 5 MB.
 *  - GET  /readings/imports/:id → estado + resumen + errores por fila; 404.
 *
 * El procesamiento es asíncrono (espejo del análisis): el 202 se responde antes
 * de procesar; el cliente hace polling con GET /readings/imports/:id.
 */
export function createImportsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service: ImportsService = createImportsService(prisma);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: IMPORT_MAX_FILE_SIZE_BYTES },
  });

  // Envuelve upload.single para traducir el error de multer LIMIT_FILE_SIZE a
  // ApiError 413 IMPORT_LIMIT_EXCEEDED (el envelope uniforme de la app).
  const uploadSingleFile = (req: Request, res: Response, next: NextFunction): void => {
    upload.single("file")(req, res, (err: unknown) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          next(
            new ApiError(
              413,
              "IMPORT_LIMIT_EXCEEDED",
              `File exceeds the ${IMPORT_MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB limit`,
            ),
          );
          return;
        }
        next(err);
        return;
      }
      next();
    });
  };

  router.post("/import", uploadSingleFile, async (req, res) => {
    // Sin archivo en el campo `file` del multipart → 400 (contrato).
    if (!req.file) {
      throw new ApiError(400, "NO_FILE", "Multipart field 'file' (CSV) is required");
    }
    const result = await service.start(req.file.originalname, req.file.buffer);
    res.status(202).json({ import_id: result.import_id, status: result.status });
  });

  router.get("/imports/:id", async (req, res) => {
    const params = importIdParam.safeParse(req.params);
    if (!params.success) {
      throw new ApiError(400, "VALIDATION_ERROR", params.error.message);
    }
    res.json(await service.getStatus(params.data.id));
  });

  return router;
}