import express from "express";
import type { Router } from "express";
import { errorMiddleware, notFoundHandler } from "../shared/errors";

export interface RouterMount {
  path: string;
  router: Router;
}

export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Levanta una app express en un puerto efímero con los routers indicados,
 * cableada con parseo JSON, el 404 catch-all y el middleware de errores — el
 * mismo cableado que usa la app de producción.
 */
export async function startTestServer(mounts: RouterMount[]): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  for (const mount of mounts) {
    app.use(mount.path, mount.router);
  }
  app.use(notFoundHandler);
  app.use(errorMiddleware);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server failed to bind a port");
  }
  return {
    baseUrl: `http://localhost:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}