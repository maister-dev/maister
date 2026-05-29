// M8 T1 spike: validate the cancel-as-checkpoint → SIGTERM → respawn --resume
// → re-issue requestPermission cycle through the real supervisor wire.
//
// Per user-locked decision (2026-05-29), this spike runs against the
// resumable mock adapter at `web/lib/__tests__/_fixtures/mock-acp-adapter-resumable.mjs`
// only — no paid `claude-agent-acp` run. The mock models the assumed
// behaviour: a cancelled-with-reason permission is journaled and replayed
// by a fresh adapter process spawned with `--resume <acpSessionId>`.
//
// Findings doc: docs/kaa-maister-m8-spike-findings-20260529.md
import type { ChildProcess } from "node:child_process";
import type { SessionEvent } from "../types";

import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerRoutes, type SpawnOverrides } from "../http-api";
import { pendingPermissions } from "../pending-permissions";
import { SessionRegistry, SESSION_EVENT_CHANNEL } from "../registry";

const RESUMABLE_MOCK = resolve(
  fileURLToPath(import.meta.url),
  "../../../test/fixtures/mock-acp-adapter-resumable.mjs",
);
const silentLogger = pino({ level: "silent" });

type BootResult = {
  app: FastifyInstance;
  url: string;
  registry: SessionRegistry;
  runtimeRoot: string;
  stateDir: string;
};

async function boot(stateDir: string): Promise<BootResult> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "m8-spike-rt-"));
  const registry = new SessionRegistry(silentLogger);
  const app = Fastify({ logger: false });
  const spawnOverrides: SpawnOverrides = {
    binary: "node",
    preArgs: [RESUMABLE_MOCK],
  };

  registerRoutes({
    app,
    registry,
    logger: silentLogger,
    runtimeRoot,
    killGraceMs: 2_000,
    spawnOverrides,
  });

  const address = await app.listen({ port: 0, host: "127.0.0.1" });

  return { app, url: address, registry, runtimeRoot, stateDir };
}

async function createSession(
  url: string,
  resumeSessionId?: string,
): Promise<{ sessionId: string; pid: number; acpSessionId: string }> {
  const res = await fetch(`${url}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId: "run-spike",
      projectSlug: "demo",
      worktreePath: process.cwd(),
      stepId: "step-1",
      executor: {
        agent: "claude",
        model: "claude-sonnet-4-6",
      },
      ...(resumeSessionId ? { resumeSessionId } : {}),
    }),
  });

  if (res.status !== 201) {
    throw new Error(`POST /sessions failed: ${res.status} ${await res.text()}`);
  }

  return (await res.json()) as {
    sessionId: string;
    pid: number;
    acpSessionId: string;
  };
}

function listenForEvent(
  registry: SessionRegistry,
  sessionId: string,
  predicate: (e: SessionEvent) => boolean,
  timeoutMs = 5_000,
): Promise<SessionEvent> {
  return new Promise((resolveP, rejectP) => {
    const entry = registry.get(sessionId);

    if (!entry) {
      rejectP(new Error(`session ${sessionId} not registered`));

      return;
    }

    const onEvent = (event: SessionEvent) => {
      if (event.sessionId !== sessionId) return;
      if (!predicate(event)) return;
      cleanup();
      resolveP(event);
    };
    const timer = setTimeout(() => {
      cleanup();
      rejectP(
        new Error(`timeout waiting for predicate on session ${sessionId}`),
      );
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      entry.emitter.off(SESSION_EVENT_CHANNEL, onEvent);
    };

    entry.emitter.on(SESSION_EVENT_CHANNEL, onEvent);
  });
}

async function awaitChildExit(child: ChildProcess, maxMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolveP) => {
      const onExit = () => {
        (child as unknown as EventEmitter).off("exit", onExit);
        resolveP();
      };

      (child as unknown as EventEmitter).on("exit", onExit);
    }),
    new Promise<void>((_, rejectP) => {
      const timer = setTimeout(
        () => rejectP(new Error("child did not exit")),
        maxMs,
      );

      timer.unref?.();
    }),
  ]);
}

let booted: BootResult | null = null;
let stateDirRoot: string | null = null;
let originalStateDir: string | undefined;

beforeEach(async () => {
  stateDirRoot = await mkdtemp(join(tmpdir(), "m8-spike-state-"));
  originalStateDir = process.env.MOCK_ACP_STATE_DIR;
  process.env.MOCK_ACP_STATE_DIR = stateDirRoot;
  process.env.MOCK_ACP_REQUEST_PERMISSION = "1";
  booted = await boot(stateDirRoot);
});

afterEach(async () => {
  if (booted) {
    for (const entry of booted.registry.list()) {
      pendingPermissions.purgeSession(entry.sessionId);
    }
    await booted.app.close();
    await rm(booted.runtimeRoot, { recursive: true, force: true });
    booted = null;
  }
  if (stateDirRoot) {
    await rm(stateDirRoot, { recursive: true, force: true });
    stateDirRoot = null;
  }
  if (originalStateDir === undefined) {
    delete process.env.MOCK_ACP_STATE_DIR;
  } else {
    process.env.MOCK_ACP_STATE_DIR = originalStateDir;
  }
  delete process.env.MOCK_ACP_REQUEST_PERMISSION;
});

describe("M8 T1 spike — cancel→checkpoint→resume→re-issue round-trip", () => {
  it(
    "journals a cancelled-with-reason permission and replays it on --resume",
    async () => {
      if (!booted) throw new Error("not booted");
      const { url, registry, stateDir } = booted;

      const first = await createSession(url);

      const entry1 = registry.get(first.sessionId);

      expect(entry1).toBeDefined();

      // Drive the first prompt in the background; it parks on requestPermission.
      const prompt1 = fetch(`${url}/sessions/${first.sessionId}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stepId: "step-1", prompt: "do thing" }),
      });

      const permEvent = await listenForEvent(
        registry,
        first.sessionId,
        (e) => e.type === "session.permission_request",
      );

      expect(permEvent.type).toBe("session.permission_request");
      const requestId =
        permEvent.type === "session.permission_request"
          ? permEvent.requestId
          : "";

      expect(requestId).toMatch(/[0-9a-f-]{36}/);

      // SIMULATED CHECKPOINT step 1: cancel with reason="checkpoint".
      // This is the exact call T4 will issue from the new
      // POST /sessions/:id/checkpoint endpoint before SIGTERMing.
      const cancelled = pendingPermissions.cancel(
        first.sessionId,
        requestId,
        "checkpoint",
      );

      expect(cancelled).toBe(true);

      // The mock's prompt() observes outcome:"cancelled", emits an
      // "agent_message_chunk", and resolves.
      const r1 = await prompt1;

      expect(r1.status).toBe(200);

      // Now SIMULATED CHECKPOINT step 2: SIGTERM the worker.
      const delRes = await fetch(`${url}/sessions/${first.sessionId}`, {
        method: "DELETE",
      });

      expect(delRes.status).toBe(204);
      await awaitChildExit(entry1!.child as ChildProcess);

      // Journal proof: the mock recorded the pending permission so a
      // fresh --resume process can replay it.
      const journalPath = join(stateDir, `${first.acpSessionId}.json`);
      const journal = JSON.parse(await readFile(journalPath, "utf8"));

      expect(journal.acpSessionId).toBe(first.acpSessionId);
      expect(journal.pendingPermission).toBeDefined();
      expect(journal.pendingPermission.toolCall.toolCallId).toBe("tc-1");

      // Spawn a FRESH supervisor session with --resume <acpSessionId>.
      // The supervisor's spawn.ts already wires this arg through.
      const second = await createSession(url, first.acpSessionId);

      // The mock's newSession() returns the SAME acpSessionId because
      // the journal is hydrated. This is the protocol invariant
      // claude-agent-acp also preserves (verified M0 spike).
      expect(second.acpSessionId).toBe(first.acpSessionId);
      expect(second.sessionId).not.toBe(first.sessionId);

      const prompt2 = fetch(`${url}/sessions/${second.sessionId}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stepId: "step-1", prompt: "resumed" }),
      });

      // The re-issued permission MUST carry the original toolCall.
      const reissued = await listenForEvent(
        registry,
        second.sessionId,
        (e) => e.type === "session.permission_request",
      );

      expect(reissued.type).toBe("session.permission_request");
      if (reissued.type !== "session.permission_request") {
        throw new Error("type narrowing failed");
      }
      expect((reissued.toolCall as { toolCallId?: string }).toolCallId).toBe(
        "tc-1",
      );
      expect(reissued.requestId).not.toBe(requestId);

      // Resolve the re-issued permission so prompt2 returns.
      const inputRes = await fetch(`${url}/sessions/${second.sessionId}/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "permission",
          action: "select",
          requestId: reissued.requestId,
          optionId: "allow",
        }),
      });

      expect(inputRes.status).toBe(200);

      const r2 = await prompt2;

      expect(r2.status).toBe(200);

      // Journal cleared (pendingPermission gone) after successful replay.
      const journalAfter = JSON.parse(await readFile(journalPath, "utf8"));

      expect(journalAfter.pendingPermission).toBeUndefined();
    },
    20_000,
  );
});
