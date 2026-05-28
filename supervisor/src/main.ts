import Fastify from "fastify";
import pino from "pino";

import { ccrManager } from "./ccr-manager";
import { startHeartbeatWatcher } from "./heartbeat";
import { registerRoutes } from "./http-api";
import { pendingPermissions } from "./pending-permissions";
import { SessionRegistry } from "./registry";

const DEFAULT_PORT = 7777;
const DEFAULT_SHUTDOWN_GRACE_MS = 15_000;
const DEFAULT_KILL_GRACE_MS = 5_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];

  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);

  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function start(): Promise<void> {
  const port = envInt("MAISTER_SUPERVISOR_PORT", DEFAULT_PORT);
  const shutdownGraceMs = envInt(
    "MAISTER_SHUTDOWN_GRACE_MS",
    DEFAULT_SHUTDOWN_GRACE_MS,
  );
  const killGraceMs = envInt("MAISTER_KILL_GRACE_MS", DEFAULT_KILL_GRACE_MS);
  const heartbeatIntervalMs = envInt("MAISTER_HEARTBEAT_INTERVAL_MS", 5_000);
  const runtimeRoot = process.env.MAISTER_RUNTIME_ROOT ?? process.cwd();
  const logLevel = (process.env.LOG_LEVEL ?? "debug") as pino.Level;

  const loggerConfig = {
    level: logLevel,
    transport:
      process.env.NODE_ENV === "production"
        ? undefined
        : { target: "pino-pretty", options: { colorize: true } },
  };

  const logger = pino(loggerConfig);

  logger.info(
    { port, runtimeRoot, logLevel, heartbeatIntervalMs },
    "supervisor-starting",
  );

  const registry = new SessionRegistry(logger);
  const app = Fastify({ logger: loggerConfig });

  registerRoutes({ app, registry, logger, runtimeRoot, killGraceMs });

  const stopHeartbeat = startHeartbeatWatcher({
    registry,
    logger,
    intervalMs: heartbeatIntervalMs,
  });

  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port, host: "0.0.0.0" }, "supervisor-listening");

  const shutdown = async (signal: NodeJS.Signals) => {
    const startedAt = Date.now();
    const liveSessions = registry.size();
    const pendingPermissionsCount = pendingPermissions.totalSize();

    logger.info(
      { signal, liveSessions, pendingPermissionsCount },
      "shutdown-start",
    );
    stopHeartbeat();

    registry.forEach((entry) => {
      if (entry.record.status !== "live") return;

      pendingPermissions.purgeSession(entry.record.sessionId);
      registry.markIntentionalShutdown(entry.record.sessionId);
      entry.child.kill("SIGTERM");
    });

    const deadline = startedAt + shutdownGraceMs;

    while (Date.now() < deadline) {
      let anyLive = false;

      registry.forEach((entry) => {
        if (entry.record.status === "live") anyLive = true;
      });

      if (!anyLive) break;
      await sleep(100);
    }

    registry.forEach((entry) => {
      if (entry.record.status === "live") {
        logger.warn({ sessionId: entry.record.sessionId }, "shutdown-sigkill");
        entry.child.kill("SIGKILL");
      }
    });

    await app.close();

    try {
      await ccrManager.shutdown({ timeoutMs: 5_000 });
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "ccr-manager shutdown failed; continuing",
      );
    }

    logger.info({ elapsedMs: Date.now() - startedAt }, "shutdown-done");
    await new Promise<void>((r) => logger.flush(() => r()));
    process.exit(0);
  };

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("supervisor failed to start:", err);
  process.exit(1);
});
