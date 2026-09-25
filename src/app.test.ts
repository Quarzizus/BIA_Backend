import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import { createTestPrisma, provisionTestDb, seedTestDb } from "./testing/testDb";
import { createApp } from "./app";

const prisma = createTestPrisma("bia_test_app");

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await provisionTestDb("bia_test_app");
  await seedTestDb(prisma);
  const app = createApp(prisma);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe("createApp wiring", () => {
  test("GET / returns a health status", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
  });

  test("CORS is enabled for direct frontend calls (F11)", async () => {
    const res = await fetch(`${baseUrl}/meters`, {
      headers: { Origin: "http://localhost:5173" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("meters, readings, anomalies and dashboard routers are wired", async () => {
    const meters = await fetch(`${baseUrl}/meters`);
    expect(meters.status).toBe(200);
    // Exacto: la base aislada solo contiene los 12 medidores sembrados.
    expect(((await meters.json()) as unknown[]).length).toBe(12);

    const readings = await fetch(`${baseUrl}/meters/M-109/readings?from=2026-09-12T13:00:00Z&to=2026-09-12T15:00:00Z`);
    expect(readings.status).toBe(200);
    const readingsBody = (await readings.json()) as { items: unknown[] };
    expect(readingsBody.items.length).toBe(3);

    const anomalies = await fetch(`${baseUrl}/anomalies`);
    expect(anomalies.status).toBe(200);
    const anomaliesBody = (await anomalies.json()) as { items: unknown[]; total: number };
    expect(Array.isArray(anomaliesBody.items)).toBe(true);
    expect(anomaliesBody.items.length).toBe(anomaliesBody.total);

    const dashboard = await fetch(`${baseUrl}/dashboard/summary`);
    expect(dashboard.status).toBe(200);
    const summary = (await dashboard.json()) as Record<string, unknown>;
    expect(typeof summary.total_consumption).toBe("number");
  });

  test("unknown routes return a 404 JSON error", async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("error middleware maps service ApiError to a JSON error response", async () => {
    const res = await fetch(`${baseUrl}/meters/M-999`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("NOT_FOUND");
  });
});