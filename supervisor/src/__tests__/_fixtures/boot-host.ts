// ADR-164 test harness: boot the supervisor routes in-process on a REAL
// execution-host state store (temp dir) with a fake ACP adapter fixture.
import type { FastifyInstance } from "fastify";
import type { HostState } from "../../host-state";
import type { CommandEnvelope, CommandKind } from "../../types";

import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import pino, { type Logger } from "pino";

import { startHeartbeatWatcher } from "../../heartbeat";
import { openHostState } from "../../host-state";
import { registerRoutes, type SpawnOverrides } from "../../http-api";
import { SessionRegistry } from "../../registry";

export const FIXTURES_DIR = resolve(
  fileURLToPath(import.meta.url),
  "../../../../test/fixtures",
);

export const silentLogger = pino({ level: "silent" });

export type BootedHost = {
  app: FastifyInstance;
  url: string;
  registry: SessionRegistry;
  hostState: HostState;
  runtimeRoot: string;
  stateDir: string;
  workspaceRoots: string[];
  stop: () => Promise<void>;
};

export type BootHostOptions = {
  fixture?: string;
  fixtureArgs?: string[];
  stateDir?: string;
  runtimeRoot?: string;
  workspaceRoots?: string[];
  pinnedKey?: string;
  killGraceMs?: number;
  logger?: Logger;
  hostState?: HostState;
};

export async function bootHost(
  opts: BootHostOptions = {},
): Promise<BootedHost> {
  const runtimeRoot =
    opts.runtimeRoot ?? (await mkdtemp(join(tmpdir(), "eh-rt-")));
  const stateDir =
    opts.stateDir ?? join(runtimeRoot, ".maister", "execution-host");
  const logger = opts.logger ?? silentLogger;
  const ownsHostState = !opts.hostState;
  const hostState =
    opts.hostState ??
    openHostState({ stateDir, pinnedKey: opts.pinnedKey, logger });
  const registry = new SessionRegistry(logger);
  const app = Fastify({ logger: false });
  const workspaceRoots = opts.workspaceRoots ?? [await realpath(runtimeRoot)];
  const spawnOverrides: SpawnOverrides = {
    binary: "node",
    preArgs: [
      join(FIXTURES_DIR, opts.fixture ?? "mock-acp-lifecycle.mjs"),
      ...(opts.fixtureArgs ?? []),
    ],
  };

  registerRoutes({
    app,
    registry,
    logger,
    runtimeRoot,
    killGraceMs: opts.killGraceMs ?? 2_000,
    spawnOverrides,
    hostState,
    workspaceRoots,
  });

  const stopHeartbeat = startHeartbeatWatcher({
    registry,
    logger,
    intervalMs: 60_000,
  });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });

  return {
    app,
    url,
    registry,
    hostState,
    runtimeRoot,
    stateDir,
    workspaceRoots,
    stop: async () => {
      stopHeartbeat();
      for (const entry of registry.list()) {
        const live = registry.get(entry.sessionId);

        if (live && live.record.status === "live") live.child.kill("SIGKILL");
      }
      await app.close();
      if (ownsHostState) hostState.close();
    },
  };
}

export async function cleanupRuntimeRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export function envelope(
  kind: CommandKind,
  fence: {
    hostKey: string;
    runId: string;
    assignmentId?: string;
    assignmentEpoch?: number;
  },
  payload: Record<string, unknown> = {},
  commandId: string = randomUUID(),
): CommandEnvelope {
  return {
    command: { id: commandId, kind, issuedAt: new Date().toISOString() },
    fence: {
      hostKey: fence.hostKey,
      assignmentId:
        fence.assignmentId ?? "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d",
      assignmentEpoch: fence.assignmentEpoch ?? 1,
      runId: fence.runId,
    },
    payload,
  };
}

export async function postJson(
  url: string,
  body: unknown,
  method: "POST" | "DELETE" = "POST",
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();

  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    headers: res.headers,
  };
}

export function legacyCreateBody(
  runId: string,
  worktreePath: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    runId,
    projectSlug: "demo",
    worktreePath,
    stepId: "step-1",
    executor: { agent: "claude", model: "claude-sonnet-4-6" },
    ...extra,
  };
}

export async function readEventsLog(
  runtimeRoot: string,
  projectSlug: string,
  runId: string,
): Promise<Array<Record<string, unknown>>> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(
    join(
      runtimeRoot,
      ".maister",
      projectSlug,
      "runs",
      runId,
      "run.events.jsonl",
    ),
    "utf8",
  );

  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  intervalMs = 25,
): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) {
        resolveP();

        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        rejectP(new Error("waitFor timed out"));

        return;
      }
      setTimeout(tick, intervalMs);
    };

    tick();
  });
}
