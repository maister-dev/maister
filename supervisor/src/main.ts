import type { HostState } from "./host-state";
import type { RegisterRoutesOptions } from "./http-api";

import Fastify, { type FastifyInstance } from "fastify";
import pino, { type Logger } from "pino";

import { startHeartbeatWatcher } from "./heartbeat";
import {
  HostKeyConflictError,
  HostStateUnwritableError,
  hostStateDirFromEnv,
  openHostState,
  startReceiptPruner,
} from "./host-state";
import { registerRoutes } from "./http-api";
import { createDefaultModelSourceRegistry } from "./model-catalog/sources";
import { pendingPermissions } from "./pending-permissions";
import { SessionRegistry } from "./registry";
import { runtimeRoot } from "./runtime-root";
import { resolveWorkspaceRoots } from "./workspace-roots";

const DEFAULT_PORT = 7777;
const DEFAULT_SHUTDOWN_GRACE_MS = 15_000;
const DEFAULT_KILL_GRACE_MS = 5_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];

  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);

  return Number.isFinite(parsed) ? parsed : fallback;
}

export function buildRegisterRoutesOptions(deps: {
  app: FastifyInstance;
  registry: SessionRegistry;
  logger: Logger;
  runtimeRoot: string;
  killGraceMs: number;
  // ADR-165: the execution-host state store + adoption roots. Required in
  // production; tests that boot routes without them get an in-memory store.
  hostState?: HostState;
  workspaceRoots?: string[];
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

// ADR-165 D1: open the execution-host state store BEFORE routes register. The
// two boot-fatal errors are logged with their remediation and rethrown so the
// process exits 1 — a conflicting pin never silently changes identity.
export function bootExecutionHost(deps: {
  runtimeRoot: string;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
}): HostState {
  const env = deps.env ?? process.env;
  const stateDir = hostStateDirFromEnv(deps.runtimeRoot, env);

  try {
    return openHostState({
      stateDir,
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
  const workspaceRoots = await resolveWorkspaceRoots({
    runtimeRoot: root,
    logger,
  });
  const stopReceiptPruner = startReceiptPruner(hostState, logger);

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

  const shutdown = async (signal: NodeJS.Signals) => {
    const startedAt = Date.now();
    const liveSessions = registry.size();
    const pendingPermissionsCount = pendingPermissions.totalSize();

    logger.info(
      { signal, liveSessions, pendingPermissionsCount },
      "shutdown-start",
    );
    stopHeartbeat();
    stopReceiptPruner();

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

    hostState.close();
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
