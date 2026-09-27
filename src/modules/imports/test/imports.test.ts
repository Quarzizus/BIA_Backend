import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createImportsRouter } from "../imports.routes";
import { createTestPrisma, provisionTestDb, seedTestDb } from "../../../testing/testDb";
import { startTestServer, type TestServer } from "../../../testing/testServer";

/**
 * Integración del módulo imports sobre una base aislada (bia_test_imports):
 * el router se monta directo con startTestServer (SIN requireAuth — el chequeo
 * de sesión vive en app.auth.test.ts). Se ejercitan el flujo async completo
 * (202 → polling → COMPLETED) y cada clase de error del contrato.
 */
const prisma = createTestPrisma("bia_test_imports");

const HEADER = "meter_id,timestamp,consumption_kwh,voltage_v,current_a,power_factor,status";

function csvBody(...rows: string[]): FormData {
  const form = new FormData();
  form.append(
    "file",
    new Blob([[HEADER, ...rows].join("\n")], { type: "text/csv" }),
    "readings.csv",
  );
  return form;
}

async function postImport(form: FormData): Promise<Response> {
  return fetch(`${baseUrl}/readings/import`, { method: "POST", body: form });
}

async function waitForStatus(importId: string, timeoutMs = 10000): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/readings/imports/${importId}`);
    const body = (await res.json()) as Record<string, any>;
    if (body.status === "COMPLETED" || body.status === "FAILED") return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`import ${importId} did not finish within ${timeoutMs}ms`);
}

let server: TestServer;
let baseUrl: string;

beforeAll(async () => {
  await provisionTestDb("bia_test_imports");
  await seedTestDb(prisma);
  server = await startTestServer([{ path: "/readings", router: createImportsRouter(prisma) }]);
  baseUrl = server.baseUrl;
});

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});

describe("POST /readings/import + GET /readings/imports/:id (CSV readings import)", () => {
  test("valid multi-meter CSV → 202 and COMPLETED with the imported counts", async () => {
    const res = await postImport(
      csvBody(
        "M-101,2026-10-01 00:00:00,12.5,220.1,55.2,0.95,OK",
        "M-102,2026-10-01 01:00:00,8.2,219.8,36.1,0.93,OK",
        "M-103,2026-10-01 02:00:00,15.7,221.3,71.4,0.97,OK",
      ),
    );
    expect(res.status).toBe(202);
    const accepted = (await res.json()) as { import_id: string; status: string };
    expect(accepted.import_id).toBeTruthy();
    expect(accepted.status).toBe("PENDING");

    const completed = await waitForStatus(accepted.import_id);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.summary).toEqual({
      total_rows: 3,
      imported: 3,
      skipped_duplicates: 0,
      failed_rows: 0,
    });
    expect(completed.errors).toEqual([]);
    expect(completed.completed_at).toBeTruthy();
  });

  test("in-file duplicates: first wins, the rest count as skipped_duplicates", async () => {
    const res = await postImport(
      csvBody(
        "M-101,2026-10-02 00:00:00,10.0,220.0,50.0,0.95,OK",
        "M-101,2026-10-02 00:00:00,99.9,220.0,50.0,0.95,OK",
      ),
    );
    expect(res.status).toBe(202);
    const { import_id } = (await res.json()) as { import_id: string };
    const completed = await waitForStatus(import_id);
    expect(completed.summary).toEqual({
      total_rows: 2,
      imported: 1,
      skipped_duplicates: 1,
      failed_rows: 0,
    });
    // La base conserva la PRIMERA fila (10.0), no la duplicada (99.9).
    const stored = await prisma.reading.findFirst({
      where: { meter: { meterId: "M-101" }, timestamp: new Date("2026-10-02T00:00:00.000Z") },
    });
    expect(stored?.consumptionKwh).toBe(10.0);
  });

  test("unknown meter → failed row with meter_not_found (does not block the batch)", async () => {
    const res = await postImport(
      csvBody(
        "M-999,2026-10-03 00:00:00,10.0,220.0,50.0,0.95,OK",
        "M-101,2026-10-03 01:00:00,11.0,220.0,50.0,0.95,OK",
      ),
    );
    const { import_id } = (await res.json()) as { import_id: string };
    const completed = await waitForStatus(import_id);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.summary).toEqual({
      total_rows: 2,
      imported: 1,
      skipped_duplicates: 0,
      failed_rows: 1,
    });
    expect(completed.errors).toEqual([
      { row: 2, meter_id: "M-999", error: "meter_not_found" },
    ]);
  });

  test("bad timestamp → failed row with invalid_timestamp", async () => {
    const res = await postImport(
      csvBody("M-101,not-a-date,10.0,220.0,50.0,0.95,OK"),
    );
    const { import_id } = (await res.json()) as { import_id: string };
    const completed = await waitForStatus(import_id);
    expect(completed.summary).toEqual({
      total_rows: 1,
      imported: 0,
      skipped_duplicates: 0,
      failed_rows: 1,
    });
    expect(completed.errors).toEqual([
      { row: 2, meter_id: "M-101", error: "invalid_timestamp" },
    ]);
  });

  test("missing consumption and out-of-range power factor → failed rows", async () => {
    const res = await postImport(
      csvBody(
        "M-101,2026-10-04 00:00:00,,220.0,50.0,0.95,OK",
        "M-101,2026-10-04 01:00:00,10.0,220.0,50.0,1.5,OK",
      ),
    );
    const { import_id } = (await res.json()) as { import_id: string };
    const completed = await waitForStatus(import_id);
    expect(completed.summary).toEqual({
      total_rows: 2,
      imported: 0,
      skipped_duplicates: 0,
      failed_rows: 2,
    });
    expect(completed.errors).toEqual([
      { row: 2, meter_id: "M-101", error: "missing_consumption" },
      { row: 3, meter_id: "M-101", error: "invalid_power_factor" },
    ]);
  });

  test("reading already in the DB → skipped_duplicates (skipDuplicates)", async () => {
    // Lectura real del seed: M-109 a las 14:00 del 2026-09-12 (consumo 110.35).
    const seeded = await prisma.reading.findFirst({
      where: { meter: { meterId: "M-109" }, timestamp: new Date("2026-09-12T14:00:00.000Z") },
    });
    expect(seeded).not.toBeNull();

    const res = await postImport(
      csvBody("M-109,2026-09-12 14:00:00,1.0,220.0,50.0,0.95,OK"),
    );
    const { import_id } = (await res.json()) as { import_id: string };
    const completed = await waitForStatus(import_id);
    expect(completed.summary).toEqual({
      total_rows: 1,
      imported: 0,
      skipped_duplicates: 1,
      failed_rows: 0,
    });
  });

  test("BOM (Excel/Windows) is tolerated", async () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([`\uFEFF${HEADER}\nM-101,2026-10-05 00:00:00,7.5,220.0,50.0,0.95,OK`], {
        type: "text/csv",
      }),
      "readings.csv",
    );
    const res = await postImport(form);
    expect(res.status).toBe(202);
    const { import_id } = (await res.json()) as { import_id: string };
    const completed = await waitForStatus(import_id);
    expect(completed.summary.imported).toBe(1);
    expect(completed.summary.failed_rows).toBe(0);
  });

  test("wrong header → 400 INVALID_HEADER (sync, no run created)", async () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob(["meter_id,timestamp,consumption_kwh\nM-101,2026-10-06 00:00:00,10.0"], {
        type: "text/csv",
      }),
      "readings.csv",
    );
    const res = await postImport(form);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_HEADER");
  });

  test("no file → 400 NO_FILE", async () => {
    const res = await fetch(`${baseUrl}/readings/import`, { method: "POST", body: new FormData() });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NO_FILE");
  });

  test("unknown import id → 404 NOT_FOUND", async () => {
    const res = await fetch(`${baseUrl}/readings/imports/clx-unknown`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("combined CSV: 3 valid + 1 in-file duplicate + 1 unknown meter + 1 bad timestamp", async () => {
    const res = await postImport(
      csvBody(
        "M-101,2026-10-07 00:00:00,10.0,220.0,50.0,0.95,OK",
        "M-101,2026-10-07 01:00:00,11.0,220.0,50.0,0.95,OK",
        "M-101,2026-10-07 02:00:00,12.0,220.0,50.0,0.95,OK",
        "M-101,2026-10-07 02:00:00,12.0,220.0,50.0,0.95,OK",
        "M-999,2026-10-07 03:00:00,13.0,220.0,50.0,0.95,OK",
        "M-101,not-a-date,14.0,220.0,50.0,0.95,OK",
      ),
    );
    expect(res.status).toBe(202);
    const { import_id } = (await res.json()) as { import_id: string };
    const completed = await waitForStatus(import_id);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.summary).toEqual({
      total_rows: 6,
      imported: 3,
      skipped_duplicates: 1,
      failed_rows: 2,
    });
    expect(completed.errors).toEqual([
      { row: 6, meter_id: "M-999", error: "meter_not_found" },
      { row: 7, meter_id: "M-101", error: "invalid_timestamp" },
    ]);
  });

  test("invariant: total_rows = imported + skipped_duplicates + failed_rows", async () => {
    // Fixture con los tres tipos: válidas, duplicado (en archivo + ya en BD) y
    // fila fallida — el reporte SIEMPRE debe cuadrar.
    const res = await postImport(
      csvBody(
        "M-101,2026-10-08 00:00:00,10.0,220.0,50.0,0.95,OK",
        "M-101,2026-10-08 01:00:00,11.0,220.0,50.0,0.95,OK",
        "M-101,2026-10-08 01:00:00,11.0,220.0,50.0,0.95,OK", // dup en archivo
        "M-101,2026-10-08 00:00:00,10.0,220.0,50.0,0.95,OK", // dup ya en BD (insertada arriba)
        "M-999,2026-10-08 02:00:00,13.0,220.0,50.0,0.95,OK", // fallida
      ),
    );
    expect(res.status).toBe(202);
    const { import_id } = (await res.json()) as { import_id: string };
    const status = await waitForStatus(import_id);
    expect(status.summary.total_rows).toBe(
      status.summary.imported +
        status.summary.skipped_duplicates +
        status.summary.failed_rows,
    );
  });

  test("header-only CSV → 400 EMPTY_FILE (sync, no run created)", async () => {
    const res = await postImport(csvBody());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("EMPTY_FILE");
  });
});