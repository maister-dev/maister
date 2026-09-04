// ADR-166 test harness: boot the supervisor routes in-process on a REAL
// execution-host state store (temp dir) with a fake ACP adapter fixture.
import type { FastifyInstance } from "fastify";
import type { HostState } from "../../host-state";
import type { CommandEnvelope, CommandKind } from "../../types";

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
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
  // Full override (a custom spawn function without a binary override); wins
  // over `fixture` / `fixtureArgs`.
  spawnOverrides?: SpawnOverrides;
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
  const spawnOverrides: SpawnOverrides = opts.spawnOverrides ?? {
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
      const exits: Promise<void>[] = [];
      for (const entry of registry.list()) {
        const live = registry.get(entry.sessionId);

        // Unit suites register fake children (bare EventEmitters) — nothing to kill.
        if (
          live?.record.status === "live" &&
          typeof live.child.kill === "function"
        ) {
          exits.push(
            new Promise<void>((resolve) => {
              live.child.once("exit", () => resolve());
            }),
          );
          live.child.kill("SIGKILL");
        }
      }
      await Promise.all(exits);
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

// Tests that need a terminal prompt outcome intentionally perform two distinct
// protocol phases: a short admission request followed by receipt observation.
// This keeps legacy tests from accidentally restoring a long-lived HTTP API.
export async function completePrompt(
  host: BootedHost,
  sessionId: string,
  body: CommandEnvelope,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const admitted = await postJson(
    `${host.url}/sessions/${sessionId}/prompts`,
    body,
  );
  if (admitted.status !== 202) {
    return admitted;
  }

  await waitFor(() => {
    const receipt = host.hostState.getReceipt(body.command.id);
    return receipt?.phase === "completed" || receipt?.phase === "rejected";
  });
  const receipt = host.hostState.getReceipt(body.command.id);
  if (!receipt) {
    throw new Error(`prompt ${body.command.id} completed without a receipt`);
  }
  if (
    !receipt.body ||
    typeof receipt.body !== "object" ||
    Array.isArray(receipt.body)
  ) {
    throw new Error(`prompt ${body.command.id} completed with a malformed receipt body`);
  }

  return {
    status: receipt.httpStatus,
    body: receipt.body as Record<string, unknown>,
    headers: admitted.headers,
  };
}

export type HostTarget = {
  url: string;
  runtimeRoot: string;
  hostState: Pick<HostState, "hostKey">;
};

export type FenceInput = {
  runId: string;
  hostKey?: string;
  assignmentId?: string;
  assignmentEpoch?: number;
};

export function fenceFor(
  host: HostTarget,
  runId: string,
  extra: Omit<FenceInput, "runId"> = {},
): FenceInput & { hostKey: string } {
  return { hostKey: host.hostState.hostKey, runId, ...extra };
}

// ADR-166 strict contract: every create is handle-form, so a test adopts a
// plain directory under the host's runtime root first. ONE handle per
// (host key, run): later creates for the same run reuse it, which keeps a
// test's fence choreography (epochs, assignment ids, foreign host keys) on the
// CREATE rather than on the adoption. Adoption itself always fences with the
// real host key and the first caller's assignment.
const adoptedHandles = new Map<string, string>();

export async function adoptDirectory(
  host: HostTarget,
  fence: FenceInput,
  opts: { projectSlug?: string; dir?: string } = {},
): Promise<string> {
  const key = `${host.hostState.hostKey}:${fence.runId}`;
  const cached = adoptedHandles.get(key);

  if (cached) return cached;

  const dir = opts.dir ?? join(host.runtimeRoot, "workspaces", fence.runId);

  await mkdir(dir, { recursive: true });
  const res = await postJson(
    `${host.url}/workspaces/adopt`,
    envelope(
      "workspace.adopt",
      { ...fence, hostKey: host.hostState.hostKey },
      {
        runId: fence.runId,
        projectSlug: opts.projectSlug ?? "demo",
        kind: "directory",
        path: dir,
      },
    ),
  );

  if (res.status !== 200) {
    throw new Error(
      `POST /workspaces/adopt failed: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }

  const id = res.body.executionWorkspaceId as string;

  adoptedHandles.set(key, id);

  return id;
}

export function createBody(
  executionWorkspaceId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    executionWorkspaceId,
    stepId: "step-1",
    executor: { agent: "claude", model: "claude-sonnet-4-6" },
    ...extra,
  };
}

export async function createEnvelope(
  host: HostTarget,
  fence: FenceInput,
  extra: Record<string, unknown> = {},
  commandId?: string,
): Promise<CommandEnvelope> {
  const executionWorkspaceId = await adoptDirectory(host, fence);

  return envelope(
    "session.create",
    { hostKey: host.hostState.hostKey, ...fence },
    createBody(executionWorkspaceId, extra),
    commandId,
  );
}

export async function createSession(
  host: HostTarget,
  fence: FenceInput,
  extra: Record<string, unknown> = {},
): Promise<{ sessionId: string; pid: number; acpSessionId: string }> {
  const res = await postJson(
    `${host.url}/sessions`,
    await createEnvelope(host, fence, extra),
  );

  if (res.status !== 201) {
    throw new Error(
      `POST /sessions failed: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }

  return res.body as { sessionId: string; pid: number; acpSessionId: string };
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
