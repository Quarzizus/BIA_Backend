import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getPrisma } from "../../config/database";
import { startTestServer, type TestServer } from "../../testing/testServer";
import { createReadingsRouter } from "./routes";

const prisma = getPrisma();
let server: TestServer;

beforeAll(async () => {
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
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(3);
    expect(body[0]!.timestamp).toBe("2026-09-12T13:00:00.000Z");
    expect(body[1]!.timestamp).toBe("2026-09-12T14:00:00.000Z");
    expect(body[1]!.consumption_kwh).toBeCloseTo(110.35, 2);
    expect(body[2]!.timestamp).toBe("2026-09-12T15:00:00.000Z");
  });

  test("returns all readings ascending when no range is given", async () => {
    const res = await fetch(`${server.baseUrl}/meters/M-109/readings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(336);
    expect(body[0]!.timestamp).toBe("2026-09-01T00:00:00.000Z");
    expect(body[335]!.timestamp).toBe("2026-09-14T23:00:00.000Z");
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