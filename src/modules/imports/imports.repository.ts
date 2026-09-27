import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import type { ImportRowError, ImportsRepository } from "./imports.domain";

/**
 * Capa de persistencia de la importación de lecturas — TODO el acceso a Prisma
 * del módulo vive aquí.
 *
 * El servicio decide el negocio (validación de filas, dedupe, conteos); el
 * repositorio solo persiste: crear/completar/fallar el run, cargar los códigos
 * de medidor y hacer el `createMany` con `skipDuplicates`.
 */
export function createImportsRepository(prisma: PrismaClient): ImportsRepository {
  return {
    async createRun(fileName) {
      const run = await prisma.importRun.create({
        data: { status: "PENDING", fileName },
      });
      return { id: run.id, status: run.status };
    },

    async findRun(runId) {
      return prisma.importRun.findUnique({ where: { id: runId } });
    },

    async completeRun(runId, data) {
      await prisma.importRun.update({
        where: { id: runId },
        data: {
          status: "COMPLETED",
          totalRows: data.totalRows,
          imported: data.imported,
          skippedDuplicates: data.skippedDuplicates,
          failedRows: data.failedRows,
          // El campo Json de Prisma exige el cast: ImportRowError[] es un array
          // de objetos sin index signature (InputJsonObject lo requiere).
          errors: data.errors as unknown as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
    },

    async failRun(runId, message) {
      const errors: ImportRowError[] = message
        ? [{ row: 0, meter_id: "", error: message }]
        : [];
      await prisma.importRun.update({
        where: { id: runId },
        data: {
          status: "FAILED",
          errors: errors as unknown as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
    },

    async meterCodes() {
      return prisma.meter.findMany({ select: { id: true, meterId: true } });
    },

    async insertReadings(data) {
      // skipDuplicates: la fila cuyo par (meterId, timestamp) YA existe en la
      // base se omite sin romper el lote. En Prisma, createMany con
      // skipDuplicates devuelve { count } = filas REALMENTE insertadas.
      const result = await prisma.reading.createMany({ data, skipDuplicates: true });
      return result.count;
    },
  };
}