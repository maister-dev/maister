import type { HostState } from "./host-state";
import type { RegisterRoutesOptions } from "./http-api";

import { createHash } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import pino, { type Logger } from "pino";

import { assertSupportedNode } from "../../runtime/node-version";

import { startHeartbeatWatcher } from "./heartbeat";
import {
  HostKeyConflictError,
  HostStateUnwritableError,
  hostStateDirFromEnv,
  openHostState,
  startReceiptPruner,
  startRuntimeEventPruner,
} from "./host-state";
import { registerRoutes } from "./http-api";
import { createDefaultModelSourceRegistry } from "./model-catalog/sources";
import { pendingPermissions } from "./pending-permissions";
import { SessionRegistry } from "./registry";
import { stopRegisteredSessions } from "./shutdown";
import { runtimeLimitsFromEnv } from "./runtime-limits";
import { runtimeRoot } from "./runtime-root";
import { resolveWorkspaceRoots } from "./workspace-roots";

const DEFAULT_PORT = 7777;
const DEFAULT_SHUTDOWN_GRACE_MS = 15_000;
const DEFAULT_KILL_GRACE_MS = 5_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];

  if (!raw) return fallback;

  const parsed = Number(raw);

  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < 1)
    throw new RangeError(`${name} must be a positive safe integer`);

  return parsed;
}

export function buildRegisterRoutesOptions(deps: {
  app: FastifyInstance;
  registry: SessionRegistry;
  logger: Logger;
  runtimeRoot: string;
  killGraceMs: number;
  // ADR-166: the execution-host state store + the realpath'd adoption roots,
  // both derived once here — registerRoutes has no fallback for either.
  hostState: HostState;
  workspaceRoots: string[];
}): RegisterRoutesOptions {
  return {
    app: deps.app,
    registry: deps.registry,
    logger: deps.logger,
    runtimeRoot: deps.runtimeRoot,
    killGraceMs: deps.killGraceMs,
    modelCatalog: {
      registry: createDefaultModelSourceRegistry(),
    },
    hostState: deps.hostState,
    workspaceRoots: deps.workspaceRoots,
  };
}

// ADR-166 D1: open the execution-host state store BEFORE routes register. The
// two boot-fatal errors are logged with their remediation and rethrown so the
// process exits 1 — a conflicting pin never silently changes identity.
export function bootExecutionHost(deps: {
  runtimeRoot: string;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
}): HostState {
  assertSupportedNode(process.versions.node);
  const env = deps.env ?? process.env;
  const stateDir = hostStateDirFromEnv(deps.runtimeRoot, env);

  try {
    return openHostState({
      stateDir,
      limits: runtimeLimitsFromEnv(env),
      pinnedKey: env.MAISTER_EXECUTION_HOST_KEY,
      logger: deps.logger,
    });
  } catch (err) {
    if (err instanceof HostKeyConflictError) {
      deps.logger.fatal(
        {
          storedKeyPrefix: err.storedKeyPrefix,
          pinnedKeyPrefix: err.pinnedKeyPrefix,
          stateDir,
          remediation:
            "unset MAISTER_EXECUTION_HOST_KEY, or deliberately wipe the execution-host state dir",
        },
        "execution-host-key-conflict",
      );
    } else if (err instanceof HostStateUnwritableError) {
      deps.logger.fatal(
        { stateDir, err: err.message },
        "execution-host-state-unwritable",
      );
    }

    throw err;
  }
}

export async function start(): Promise<void> {
  const port = envInt("MAISTER_SUPERVISOR_PORT", DEFAULT_PORT);
  const shutdownGraceMs = envInt(
    "MAISTER_SHUTDOWN_GRACE_MS",
    DEFAULT_SHUTDOWN_GRACE_MS,
  );
  const killGraceMs = envInt("MAISTER_KILL_GRACE_MS", DEFAULT_KILL_GRACE_MS);
  const heartbeatIntervalMs = envInt("MAISTER_HEARTBEAT_INTERVAL_MS", 5_000);
  const root = runtimeRoot();
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
    { port, runtimeRoot: root, logLevel, heartbeatIntervalMs },
    "supervisor-starting",
  );

  const registry = new SessionRegistry(logger);
  const app = Fastify({ logger: loggerConfig });
  const hostState = bootExecutionHost({ runtimeRoot: root, logger });

  logger.info(
    {
      node: process.versions.node,
      configHash: createHash("sha256")
        .update(JSON.stringify(hostState.limits))
        .digest("hex"),
      limits: hostState.limits,
    },
    "runtime-config-accepted",
  );
  const workspaceRoots = await resolveWorkspaceRoots({
    runtimeRoot: root,
    logger,
  });
  const stopReceiptPruner = startReceiptPruner(hostState, logger);
  const stopRuntimeEventPruner = startRuntimeEventPruner(hostState, logger);

  registerRoutes(
    buildRegisterRoutesOptions({
      app,
      registry,
      logger,
      runtimeRoot: root,
      killGraceMs,
      hostState,
      workspaceRoots,
    }),
  );

  const stopHeartbeat = startHeartbeatWatcher({
    registry,
    logger,
    intervalMs: heartbeatIntervalMs,
  });

  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port, host: "0.0.0.0" }, "supervisor-listening");

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    const startedAt = Date.now();
    const liveSessions = registry.size();
    const pendingPermissionsCount = pendingPermissions.totalSize();

    logger.info(
      { signal, liveSessions, pendingPermissionsCount },
      "shutdown-start",
    );
    stopHeartbeat();
    stopReceiptPruner();
    stopRuntimeEventPruner();

    const deadline = setTimeout(
      () => {
        // An unconfirmed drain leaves durable receipts for startup recovery.
        logger.fatal({}, "shutdown-deadline");
        process.exit(1);
      },
      shutdownGraceMs + killGraceMs + 5_000,
    );
    const closeConnections = setTimeout(
      () => app.server.closeAllConnections(),
      1_000,
    );

    try {
      // Fastify stops admission before the first await. Concurrent accepted
      // handlers finish before the final registry snapshot is drained.
      await Promise.all([
        app.close(),
        stopRegisteredSessions(registry, logger, shutdownGraceMs),
      ]);
      await stopRegisteredSessions(registry, logger, 1);
      registry.clear("shutdown");
      hostState.close();
      logger.info({ elapsedMs: Date.now() - startedAt }, "shutdown-done");
      await new Promise<void>((resolve, reject) =>
        logger.flush((error) => (error ? reject(error) : resolve())),
      );
      clearTimeout(closeConnections);
      clearTimeout(deadline);
      process.exit(0);
    } catch (error) {
      logger.fatal({ err: error }, "shutdown-failed");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

// Guard the auto-start so tests can import buildRegisterRoutesOptions without
// binding a port. Vitest sets process.env.VITEST in every test worker; prod and
// dev (tsx) never set it.
if (!process.env.VITEST) {
  start().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("supervisor failed to start:", err);
    process.exit(1);
  });
}
