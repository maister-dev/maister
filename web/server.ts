import { createServer, type Server } from "node:http";

import next from "next";
import pino from "pino";

import { assertSupportedNode } from "../runtime/node-version";

import {
  applicationLifecycle,
  quiesceApplication,
  waitForApplicationLifecycle,
} from "./lib/server-lifecycle";

const HTTP_DRAIN_MS = 5_000;
const SHUTDOWN_BUDGET_MS = 25_000;
const log = pino({
  name: "web-server",
  level: process.env.LOG_LEVEL ?? "info",
  serializers: { error: pino.stdSerializers.err },
});

function closeHttp(server: Server): Promise<void> {
  // SSE may stay open indefinitely. Stop admission immediately, then close
  // remaining connections within the application shutdown budget.
  const timer = setTimeout(() => server.closeAllConnections(), HTTP_DRAIN_MS);

  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}

async function start(): Promise<void> {
  assertSupportedNode(process.versions.node);
  const rawPort = process.env.PORT ?? "3000";
  const port = Number(rawPort);

  if (
    !/^\d+$/.test(rawPort) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  )
    throw new RangeError("PORT must be an integer between 1 and 65535");
  const app = next({ dev: false, hostname: "0.0.0.0", port });

  await Promise.all([app.prepare(), waitForApplicationLifecycle(60_000)]);
  const handler = app.getRequestHandler();
  const server = createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      log.error({ error }, "request-failed");
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "web-shutdown-start");
    const deadline = setTimeout(() => {
      log.fatal({ budgetMs: SHUTDOWN_BUDGET_MS }, "web-shutdown-deadline");
      process.exit(1);
    }, SHUTDOWN_BUDGET_MS);

    try {
      const httpClosed = closeHttp(server);

      quiesceApplication();
      await httpClosed;
      await applicationLifecycle()?.drain();
      await app.close();
      log.info({}, "web-shutdown-done");
      await new Promise<void>((resolve, reject) =>
        log.flush((error) => (error ? reject(error) : resolve())),
      );
      clearTimeout(deadline);
      process.exit(0);
    } catch (error) {
      log.fatal({ error }, "web-shutdown-failed");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  log.info({ port, node: process.versions.node }, "web-listening");
}

void start().catch((error: unknown) => {
  log.fatal({ error }, "web-start-failed");
  process.exit(1);
});
