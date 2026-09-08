// M8 T1: validate the cancel-as-checkpoint → SIGTERM → respawn → session/resume
// → re-issue requestPermission cycle through the real supervisor wire.
//
// Per user-locked decision (2026-05-29), this runs against the resumable mock
// adapter at `supervisor/test/fixtures/mock-acp-adapter-resumable.mjs` only —
// no paid `claude-agent-acp` run. The mock models the behaviour: a
// cancelled-with-reason permission is journaled and replayed by a fresh adapter
// process that resumes via the ACP `session/resume` call (reusing the prior
// acpSessionId), NOT a `--resume` CLI flag.
//
// Findings doc: docs/spikes/2026-05-29-m8-spike-findings.md
import type { ChildProcess } from "node:child_process";
import type { SessionEvent } from "../types";

import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pendingPermissions } from "../pending-permissions";
import { SessionRegistry, SESSION_EVENT_CHANNEL } from "../registry";

import {
  bootHost,
  cleanupRuntimeRoot,
  createSession as createHandleSession,
  envelope,
  fenceFor,
  postJson,
  waitFor,
  type BootedHost,
} from "./_fixtures/boot-host";

const RUN_ID = "run-spike";

type BootResult = BootedHost & { stateDir: string };

async function boot(stateDir: string): Promise<BootResult> {
  const host = await bootHost({ fixture: "mock-acp-adapter-resumable.mjs" });

  return { ...host, stateDir };
}

function createSession(
  host: BootedHost,
  resumeSessionId?: string,
): Promise<{ sessionId: string; pid: number; acpSessionId: string }> {
  return createHandleSession(
    host,
    { runId: RUN_ID },
    resumeSessionId ? { resumeSessionId } : {},
  );
}

function command(
  host: BootedHost,
  kind: "session.prompt" | "session.input" | "session.delete",
  payload: Record<string, unknown> = {},
) {
  return envelope(kind, fenceFor(host, RUN_ID), payload);
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

async function awaitChildExit(
  child: ChildProcess,
  maxMs = 5_000,
): Promise<void> {
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
    await booted.stop();
    await cleanupRuntimeRoot(booted.runtimeRoot);
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
  it("journals a cancelled-with-reason permission and replays it on session/resume", async () => {
    if (!booted) throw new Error("not booted");
    const host = booted;
    const { url, registry, stateDir } = host;

    const first = await createSession(host);

    const entry1 = registry.get(first.sessionId);

    expect(entry1).toBeDefined();

    // Admit the first prompt; its canonical command remains in flight while it
    // parks on requestPermission.
    const prompt1 = command(host, "session.prompt", {
      stepId: "step-1",
      prompt: "do thing",
    });
    const admitted1 = await postJson(
      `${url}/sessions/${first.sessionId}/prompts`,
      prompt1,
    );

    expect(admitted1.status).toBe(202);

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
    await waitFor(
      () =>
        host.hostState.getReceipt(prompt1.command.id)?.phase === "completed",
    );
    expect(host.hostState.getReceipt(prompt1.command.id)?.httpStatus).toBe(200);

    // Now SIMULATED CHECKPOINT step 2: SIGTERM the worker.
    const delRes = await postJson(
      `${url}/sessions/${first.sessionId}`,
      command(host, "session.delete"),
      "DELETE",
    );

    expect(delRes.status).toBe(204);
    await awaitChildExit(entry1!.child as ChildProcess);

    // Journal proof: the mock recorded the pending permission so a
    // fresh --resume process can replay it.
    const journalPath = join(stateDir, `${first.acpSessionId}.json`);
    const journal = JSON.parse(await readFile(journalPath, "utf8"));

    expect(journal.acpSessionId).toBe(first.acpSessionId);
    expect(journal.pendingPermission).toBeDefined();
    expect(journal.pendingPermission.toolCall.toolCallId).toBe("tc-1");

    // Spawn a FRESH supervisor session that resumes <acpSessionId>. Resume is
    // an ACP protocol call: createAcpConnection invokes session/resume (the
    // adapter advertises sessionCapabilities.resume) — NOT a --resume CLI flag.
    const second = await createSession(host, first.acpSessionId);

    // Resume REUSES the prior acpSessionId (never mints a new one), so the
    // checkpoint handle keeps pointing at the real conversation. The supervisor
    // session id differs (fresh process) but the ACP session id is preserved.
    expect(second.acpSessionId).toBe(first.acpSessionId);
    expect(second.sessionId).not.toBe(first.sessionId);

    const prompt2 = command(host, "session.prompt", {
      stepId: "step-1",
      prompt: "resumed",
    });
    const admitted2 = await postJson(
      `${url}/sessions/${second.sessionId}/prompts`,
      prompt2,
    );

    expect(admitted2.status).toBe(202);

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

    // Resolve the re-issued permission so prompt2 terminalizes.
    const inputRes = await postJson(
      `${url}/sessions/${second.sessionId}/input`,
      command(host, "session.input", {
        kind: "permission",
        action: "select",
        requestId: reissued.requestId,
        optionId: "allow",
      }),
    );

    expect(inputRes.status).toBe(200);

    await waitFor(
      () =>
        host.hostState.getReceipt(prompt2.command.id)?.phase === "completed",
    );
    expect(host.hostState.getReceipt(prompt2.command.id)?.httpStatus).toBe(200);

    // Journal cleared (pendingPermission gone) after successful replay.
    const journalAfter = JSON.parse(await readFile(journalPath, "utf8"));

    expect(journalAfter.pendingPermission).toBeUndefined();
  }, 20_000);
});
