import type { Logger } from "pino";

import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import pino from "pino";

import { isSupervisorError, SupervisorError } from "./types";

export type CcrState = "idle" | "starting" | "ready" | "failed" | "stopping";

export type CcrInstanceConfig = {
  id: string;
  lifecycle?: "managed" | "external";
  configPath?: string;
  baseUrl?: string;
  healthcheckUrl?: string;
};

export interface CcrManager {
  ensureRunning(opts?: {
    signal?: AbortSignal;
    instance?: CcrInstanceConfig;
  }): Promise<void>;
  getProxyUrl(instanceId?: string): string;
  getState(instanceId?: string): CcrState;
  shutdown(opts?: {
    signal?: NodeJS.Signals;
    timeoutMs?: number;
  }): Promise<void>;
  // ADR-094: stop a SINGLE instance (default instance when no id). Distinct from
  // shutdown(), which stops every instance — admin stop must not kill unrelated
  // sidecars or live sessions routing through CCR.
  stop(instanceId?: string): Promise<void>;
}

export type CreateCcrManagerOptions = {
  binaryOverride?: string;
  argsOverride?: string[];
  configPath?: string;
  logger?: Logger;
  spawnOptions?: SpawnOptions;
  healthCheckTotalMs?: number;
};

const DEFAULT_HEALTH_TOTAL_MS = 10_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
const HEALTH_BACKOFF_MS = [100, 200, 400, 800, 1_600, 3_200, 6_400];

function defaultConfigPath(): string {
  return (
    process.env.MAISTER_CCR_CONFIG_PATH ??
    join(homedir(), ".claude-code-router", "config.json")
  );
}

type CcrConfigShape = { host: string; port: number };

function parseConfig(raw: string, path: string): CcrConfigShape {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      `CCR config malformed at ${path}: ${(err as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      `CCR config malformed at ${path}: root is not an object`,
    );
  }

  const obj = parsed as Record<string, unknown>;
  const portRaw = obj.PORT ?? obj.port;
  const hostRaw = obj.HOST ?? obj.host;
  let port = 3456;

  if (portRaw !== undefined) {
    const n =
      typeof portRaw === "number"
        ? portRaw
        : Number.parseInt(String(portRaw), 10);

    if (!Number.isFinite(n) || n <= 0 || n > 65535) {
      throw new SupervisorError(
        "EXECUTOR_UNAVAILABLE",
        `CCR config malformed at ${path}: PORT must be a valid TCP port`,
      );
    }
    port = n;
  }

  const host =
    typeof hostRaw === "string" && hostRaw.length > 0 ? hostRaw : "127.0.0.1";

  return { host, port };
}

async function probeHealth(opts: {
  host: string;
  port: number;
  totalMs: number;
  signal?: AbortSignal;
  logger: Logger;
}): Promise<void> {
  const { host, port, totalMs, signal, logger } = opts;
  // CCR exposes /health (confirmed by grep on the installed
  // @musistudio/claude-code-router@2.0.0 dist/cli.js). Probing /health
  // distinguishes "CCR is up" from "some other HTTP service answered on
  // the same port" — generic GET / 200 is insufficient: a leftover
  // process can return 200 after CCR fails to bind with EADDRINUSE.
  // See `.ai-factory/rules/backend.md` "Managed-sidecar health probes
  // MUST validate target identity".
  const url = `http://${host}:${port}/health`;
  const deadline = Date.now() + totalMs;
  let lastIdentityMiss = false;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    const delay =
      HEALTH_BACKOFF_MS[Math.min(attempt - 1, HEALTH_BACKOFF_MS.length - 1)];

    if (attempt > 1) {
      logger.debug({ attempt, delayMs: delay }, "ccr health-check retry");
      try {
        await wait(delay, undefined, { signal });
      } catch {
        // aborted
        break;
      }
    }
    if (signal?.aborted) break;

    const remaining = Math.max(deadline - Date.now(), 1);
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();

    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), Math.min(remaining, 2_000));

    try {
      const res = await fetch(url, { signal: ctl.signal });

      if (res.status === 200) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        logger.debug({ host, port, attempt, status: 200 }, "ccr ready");

        return;
      }

      if (res.status === 404) {
        // 404 on /health means *something* answered the port but it is
        // NOT CCR (or it's an incompatible CCR version). Keep retrying
        // briefly in case the real CCR comes up later, but mark this
        // case so the error message identifies the cause.
        lastIdentityMiss = true;
        logger.warn(
          { host, port, attempt, status: 404 },
          "ccr health-check identity miss (/health 404 — wrong process on port?)",
        );
      } else {
        logger.warn(
          { host, port, attempt, status: res.status },
          "ccr health-check non-200",
        );
      }
    } catch (err) {
      logger.warn(
        { host, port, attempt, err: (err as Error).message },
        "ccr health-check probe failed",
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  if (signal?.aborted) {
    throw new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      `CCR readiness probe aborted (host=${host} port=${port})`,
    );
  }

  if (lastIdentityMiss) {
    throw new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      `CCR identity check failed at http://${host}:${port}/health (got 404 — another process appears to own the port)`,
    );
  }

  throw new SupervisorError(
    "EXECUTOR_UNAVAILABLE",
    `CCR daemon failed to become ready within ${totalMs}ms (host=${host} port=${port})`,
  );
}

export function createCcrManager(
  opts: CreateCcrManagerOptions = {},
): CcrManager {
  const logger =
    opts.logger ??
    pino({ name: "ccr-manager", level: process.env.LOG_LEVEL ?? "info" });
  const binary = opts.binaryOverride ?? "ccr";
  const argsBase = opts.argsOverride ?? ["start"];
  const configPath = opts.configPath ?? defaultConfigPath();
  const totalHealthMs = opts.healthCheckTotalMs ?? DEFAULT_HEALTH_TOTAL_MS;

  let state: CcrState = "idle";
  let child: ChildProcess | null = null;
  let host = "127.0.0.1";
  let port = 3456;
  let startPromise: Promise<void> | null = null;

  function setState(next: CcrState, fields?: Record<string, unknown>): void {
    state = next;
    logger.info({ state: next, ...fields }, `ccr.${next}`);
  }

  async function preflight(): Promise<CcrConfigShape> {
    try {
      await access(configPath, fsConstants.R_OK);
    } catch (err) {
      throw new SupervisorError(
        "EXECUTOR_UNAVAILABLE",
        `CCR config not found at ${configPath} — see docs/system-analytics/executors.md#ccr-setup`,
        { cause: err as Error },
      );
    }
    const raw = await readFile(configPath, "utf8");

    return parseConfig(raw, configPath);
  }

  async function spawnDaemon(
    cfg: CcrConfigShape,
    signal?: AbortSignal,
  ): Promise<void> {
    const proc = spawn(binary, argsBase, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      ...opts.spawnOptions,
    });

    child = proc;

    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim().length === 0) continue;
        logger.debug({ src: "stdout", line }, "ccr stdout");
      }
    });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim().length === 0) continue;
        logger.debug({ src: "stderr", line }, "ccr stderr");
      }
    });

    // Early-exit guard: if the spawned child exits BEFORE probeHealth
    // succeeds, abort the probe immediately and surface a
    // target-identifying error. Without this, an EADDRINUSE crash on
    // CCR followed by an unrelated process answering 200 on the port
    // would race the probe to success against the wrong process. See
    // `.ai-factory/skill-context/aif-implement/SKILL.md` rule "Health
    // probes must validate target identity".
    const probeCtl = new AbortController();
    let earlyExit: {
      code: number | null;
      signal: NodeJS.Signals | null;
    } | null = null;

    const earlyExitHandler = (
      code: number | null,
      sig: NodeJS.Signals | null,
    ) => {
      earlyExit = { code, signal: sig };
      probeCtl.abort();
    };

    proc.once("exit", earlyExitHandler);

    proc.once("exit", (code, sig) => {
      logger.info({ code, signal: sig, pid: proc.pid }, "ccr child exited");
      if (child === proc) {
        child = null;
        if (state === "ready" || state === "starting") {
          setState("idle", { reason: "child-exit" });
        }
      }
    });
    proc.once("error", (err) => {
      logger.warn({ err: err.message }, "ccr child error");
    });

    // Forward an external abort (caller's signal) into the probe controller
    // so callers can still cancel start-up.
    if (signal) {
      if (signal.aborted) probeCtl.abort();
      else
        signal.addEventListener("abort", () => probeCtl.abort(), {
          once: true,
        });
    }

    try {
      await probeHealth({
        host: cfg.host,
        port: cfg.port,
        totalMs: totalHealthMs,
        signal: probeCtl.signal,
        logger,
      });
    } catch (err) {
      proc.off("exit", earlyExitHandler);
      // Kill the child if health check failed so it doesn't linger.
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      const exitInfo = earlyExit as {
        code: number | null;
        signal: NodeJS.Signals | null;
      } | null;

      if (exitInfo) {
        throw new SupervisorError(
          "EXECUTOR_UNAVAILABLE",
          `CCR child exited before becoming ready (code=${exitInfo.code} signal=${exitInfo.signal ?? "null"})`,
          { cause: err as Error },
        );
      }
      throw err;
    }

    proc.off("exit", earlyExitHandler);
  }

  async function doStart(signal?: AbortSignal): Promise<void> {
    let cfg: CcrConfigShape;

    try {
      cfg = await preflight();
    } catch (err) {
      setState("failed", { reason: (err as Error).message });
      throw err;
    }

    host = cfg.host;
    port = cfg.port;
    setState("starting", { host, port });

    try {
      await spawnDaemon(cfg, signal);
      setState("ready", { host, port });
    } catch (err) {
      setState("failed", { reason: (err as Error).message });
      throw err;
    }
  }

  async function ensureRunning(
    callOpts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    if (state === "ready") return;
    if (startPromise) return startPromise;

    startPromise = doStart(callOpts.signal).finally(() => {
      startPromise = null;
    });

    return startPromise;
  }

  function getProxyUrl(): string {
    if (state !== "ready") {
      throw new SupervisorError(
        "EXECUTOR_UNAVAILABLE",
        `CCR not ready (state=${state})`,
      );
    }

    return `http://${host}:${port}`;
  }

  function getState(): CcrState {
    return state;
  }

  async function shutdown(
    shutdownOpts: { signal?: NodeJS.Signals; timeoutMs?: number } = {},
  ): Promise<void> {
    if (state === "idle") return;
    if (!child) {
      setState("idle", { reason: "no-child" });

      return;
    }

    const sig = shutdownOpts.signal ?? "SIGTERM";
    const timeoutMs = shutdownOpts.timeoutMs ?? DEFAULT_SHUTDOWN_GRACE_MS;

    setState("stopping", { signal: sig, timeoutMs });

    const proc = child;
    const exited = new Promise<void>((resolveP) => {
      proc.once("exit", () => resolveP());
    });

    try {
      proc.kill(sig);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "ccr kill failed");
    }

    // Escalation gates on the OBSERVED `exit` event, never on `proc.killed`
    // — `proc.killed` becomes true after `kill()` successfully *sends* a
    // signal, not after the child exits. A SIGTERM-resistant child would
    // otherwise be reported as `idle` while still alive with the port
    // bound. See `.ai-factory/rules/backend.md` "Process-lifecycle
    // escalation".
    const exitedInTime = await Promise.race([
      exited.then(() => true),
      wait(timeoutMs).then(() => false),
    ]);

    let escalated: NodeJS.Signals = sig;

    if (!exitedInTime) {
      logger.warn(
        { pid: proc.pid, graceMs: timeoutMs },
        "ccr SIGKILL after grace",
      );
      try {
        proc.kill("SIGKILL");
        escalated = "SIGKILL";
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "ccr SIGKILL failed");
      }
      await exited;
    }

    child = null;
    setState("idle", { reason: "shutdown-complete", escalated });
  }

  // A single (default) manager owns one child, so stop is shutdown — the
  // instanceId is accepted for interface symmetry and logged for trace.
  async function stop(instanceId?: string): Promise<void> {
    await shutdown();
    logger.debug({ instanceId: instanceId ?? null, state }, "ccr.stop");
  }

  return {
    ensureRunning,
    getProxyUrl,
    getState,
    shutdown,
    stop,
  };
}

function externalCcrManager(
  instance: CcrInstanceConfig,
  logger: Logger,
): CcrManager {
  let state: CcrState = "idle";
  const baseUrl = instance.baseUrl;

  if (!baseUrl) {
    throw new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      `CCR sidecar ${instance.id} is external but baseUrl is not configured`,
    );
  }
  const proxyUrl = baseUrl;

  async function ensureRunning(
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    state = "starting";
    const healthUrl =
      instance.healthcheckUrl ?? new URL("/health", baseUrl).toString();
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();

    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), 2_000);

    try {
      const res = await fetch(healthUrl, { signal: ctl.signal });

      if (res.status !== 200) {
        state = "failed";
        throw new SupervisorError(
          "EXECUTOR_UNAVAILABLE",
          `CCR sidecar ${instance.id} healthcheck failed at ${healthUrl} (status=${res.status})`,
        );
      }
      state = "ready";
      logger.info({ instanceId: instance.id, healthUrl }, "ccr.external.ready");
    } catch (err) {
      state = "failed";
      if (isSupervisorError(err)) throw err;
      throw new SupervisorError(
        "EXECUTOR_UNAVAILABLE",
        `CCR sidecar ${instance.id} healthcheck failed at ${healthUrl}: ${(err as Error).message}`,
        { cause: err as Error },
      );
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  function getProxyUrl(): string {
    if (state !== "ready") {
      throw new SupervisorError(
        "EXECUTOR_UNAVAILABLE",
        `CCR sidecar ${instance.id} not ready (state=${state})`,
      );
    }

    return proxyUrl;
  }

  return {
    ensureRunning,
    getProxyUrl,
    getState: () => state,
    shutdown: async () => {
      state = "idle";
    },
    stop: async () => {
      state = "idle";
    },
  };
}

export function createKeyedCcrManager(
  opts: CreateCcrManagerOptions = {},
): CcrManager {
  const logger =
    opts.logger ??
    pino({ name: "ccr-manager", level: process.env.LOG_LEVEL ?? "info" });
  const defaultManager = createCcrManager({ ...opts, logger });
  const managers = new Map<string, CcrManager>();

  function managerFor(instance: CcrInstanceConfig): CcrManager {
    const existing = managers.get(instance.id);

    if (existing) return existing;

    const next =
      instance.lifecycle === "external"
        ? externalCcrManager(instance, logger)
        : createCcrManager({
            ...opts,
            logger,
            configPath: instance.configPath ?? opts.configPath,
          });

    managers.set(instance.id, next);

    return next;
  }

  return {
    ensureRunning: async (callOpts = {}) => {
      if (!callOpts.instance) {
        await defaultManager.ensureRunning({ signal: callOpts.signal });

        return;
      }

      await managerFor(callOpts.instance).ensureRunning({
        signal: callOpts.signal,
      });
    },
    getProxyUrl: (instanceId?: string) => {
      if (!instanceId) return defaultManager.getProxyUrl();
      const manager = managers.get(instanceId);

      if (!manager) {
        throw new SupervisorError(
          "EXECUTOR_UNAVAILABLE",
          `CCR sidecar ${instanceId} has not been started`,
        );
      }

      return manager.getProxyUrl();
    },
    getState: (instanceId?: string) => {
      if (!instanceId) return defaultManager.getState();

      return managers.get(instanceId)?.getState() ?? "idle";
    },
    shutdown: async (shutdownOpts = {}) => {
      await Promise.all(
        [defaultManager, ...managers.values()].map((manager) =>
          manager.shutdown(shutdownOpts),
        ),
      );
      managers.clear();
    },
    stop: async (instanceId?: string) => {
      if (!instanceId) {
        await defaultManager.stop();
        logger.debug(
          { instanceId: null, state: defaultManager.getState() },
          "ccr.keyed.stop default",
        );

        return;
      }

      const manager = managers.get(instanceId);

      if (!manager) {
        logger.debug({ instanceId, state: "idle" }, "ccr.keyed.stop noop");

        return;
      }

      await manager.stop(instanceId);
      managers.delete(instanceId);
      logger.debug({ instanceId, state: "idle" }, "ccr.keyed.stop");
    },
  };
}

export const ccrManager: CcrManager = createKeyedCcrManager();
