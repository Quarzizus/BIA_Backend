import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestPrisma, provisionTestDb, seedTestDb } from "../../../testing/testDb";
import { startTestServer, type TestServer } from "../../../testing/testServer";
import { createReadingsRouter } from "../reading.routes";

const prisma = createTestPrisma("bia_test_readings");
let server: TestServer;

beforeAll(async () => {
  await provisionTestDb("bia_test_readings");
  await seedTestDb(prisma);
  server = await startTestServer([{ path: "/meters", router: createReadingsRouter(prisma) }]);
});

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});

describe("GET /meters/:meterId/readings", () => {
  test("returns ascending readings in the requested range (spec scenario)", async () => {
    const res = await fetch(
      `${server.baseUrl}/meters/M-109/readings?from=2026-09-12T13:00:00Z&to=2026-09-12T15:00:00Z`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
      total: number;
      page: number;
      page_size: number;
      has_more: boolean;
    };
    expect(body.items).toHaveLength(3);
    expect(body.total).toBe(3);
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(100);
    expect(body.has_more).toBe(false);
    expect(body.items[0]!.timestamp).toBe("2026-09-12T13:00:00.000Z");
    expect(body.items[1]!.timestamp).toBe("2026-09-12T14:00:00.000Z");
    expect(body.items[1]!.consumption_kwh).toBeCloseTo(110.35, 2);
    expect(body.items[2]!.timestamp).toBe("2026-09-12T15:00:00.000Z");
  });

  test("returns the first page (100 items) of 336 ascending readings by default", async () => {
    const res = await fetch(`${server.baseUrl}/meters/M-109/readings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
      total: number;
      has_more: boolean;
    };
    expect(body.total).toBe(336);
    expect(body.items).toHaveLength(100);
    expect(body.has_more).toBe(true);
    expect(body.items[0]!.timestamp).toBe("2026-09-01T00:00:00.000Z");
  });

  test("page 4 slices the remaining 36 readings and has_more false", async () => {
    const res = await fetch(`${server.baseUrl}/meters/M-109/readings?page=4`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
      total: number;
      page: number;
      has_more: boolean;
    };
    expect(body.total).toBe(336);
    expect(body.items).toHaveLength(36);
    expect(body.page).toBe(4);
    expect(body.has_more).toBe(false);
    // Offset 300 → 300 h después de 2026-09-01T00:00 = 2026-09-13T12:00.
    expect(body.items[0]!.timestamp).toBe("2026-09-13T12:00:00.000Z");
    expect(body.items[35]!.timestamp).toBe("2026-09-14T23:00:00.000Z");
  });

  test("from/to combined with pagination: page_size=2 over a 3-reading range", async () => {
    const range = "from=2026-09-12T13:00:00Z&to=2026-09-12T15:00:00Z";
    const page1 = (await (
      await fetch(`${server.baseUrl}/meters/M-109/readings?${range}&page_size=2`)
    ).json()) as { items: Array<Record<string, unknown>>; total: number; has_more: boolean };
    expect(page1.total).toBe(3);
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0]!.timestamp).toBe("2026-09-12T13:00:00.000Z");
    expect(page1.has_more).toBe(true);

    const page2 = (await (
      await fetch(`${server.baseUrl}/meters/M-109/readings?${range}&page_size=2&page=2`)
    ).json()) as { items: Array<Record<string, unknown>>; total: number; has_more: boolean };
    expect(page2.total).toBe(3);
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]!.timestamp).toBe("2026-09-12T15:00:00.000Z");
    expect(page2.has_more).toBe(false);
  });

  test.each([
    ["page=0", "page=0"],
    ["page_size=0", "page_size=0"],
    ["page_size=1001", "page_size=1001"],
  ])("returns 400 VALIDATION_ERROR for invalid param %s", async (_label, query) => {
    const res = await fetch(`${server.baseUrl}/meters/M-109/readings?${query}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  test("returns 400 VALIDATION_ERROR when from is after to", async () => {
    const res = await fetch(
      `${server.baseUrl}/meters/M-109/readings?from=2026-09-12T15:00:00Z&to=2026-09-12T13:00:00Z`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  test("returns 400 VALIDATION_ERROR for a malformed date", async () => {
    const res = await fetch(`${server.baseUrl}/meters/M-109/readings?from=not-a-date`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  test("returns 404 NOT_FOUND for an unknown meter", async () => {
    const res = await fetch(`${server.baseUrl}/meters/M-999/readings`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("NOT_FOUND");
  });
});