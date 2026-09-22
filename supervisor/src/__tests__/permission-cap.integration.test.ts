// ADR-180 — the host's absolute permission cap and the graceful teardown it
// performs, driven through the PRODUCTION boot (`supervisor/src/main.ts` as a
// child process) so the wiring itself is under test and not assumed.
//
// The cap window is compressed through the CHILD'S ENVIRONMENT only
// (`MAISTER_PERMISSION_MAX_HOURS` is parsed as a positive float), because
// `pendingPermissions` is a module-level singleton that reads its timeout once
// at import — there is no injectable clock on either side.
//
// Controls (each fails on master for a reason no other control fails for):
//   RED 1  the teardown is graceful and the ACP handle is provably usable
//   RED 3  graceful shutdown does not race its own SIGKILL
//   RED 5  the cap handler is installed by the real boot path
//   RED 6  a genuine producer fault still SIGKILLs (guard — must stay green)
import type { SessionEvent } from "../types";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSession,
  envelope,
  postJson,
  type HostTarget,
} from "./_fixtures/boot-host";
import {
  startRealSupervisor,
  type RealSupervisor,
} from "./_fixtures/real-supervisor";
import {
  collectSessionEvents,
  type SseCollector,
} from "./_fixtures/sse-collector";

// 1.44 s — small enough for the lane, large enough to admit a prompt and park
// on requestPermission before it fires.
const CAP_HOURS = "0.0004";
// Far out of reach: only the path under test may release the deferred.
const CAP_UNREACHABLE = "24";

type PermissionRequestEvent = Extract<
  SessionEvent,
  { type: "session.permission_request" }
>;

type Booted = {
  sup: RealSupervisor;
  target: HostTarget;
};

type Parked = {
  sessionId: string;
  acpSessionId: string;
  permission: PermissionRequestEvent;
  stream: SseCollector;
};

const cleanups: Array<() => Promise<void>> = [];

async function boot(env: Record<string, string> = {}): Promise<Booted> {
  const stateDir = await mkdtemp(join(tmpdir(), "adr180-journal-"));
  const sup = await startRealSupervisor({
    fixture: "mock-acp-adapter-resumable.mjs",
    env: {
      LOG_LEVEL: "info",
      MOCK_ACP_REQUEST_PERMISSION: "1",
      MOCK_ACP_STATE_DIR: stateDir,
      MAISTER_PERMISSION_MAX_HOURS: CAP_HOURS,
      ...env,
    },
  });
  const health = (await (await fetch(`${sup.url}/health`)).json()) as {
    host: { hostKey: string };
  };

  cleanups.push(async () => {
    await sup.kill();
    await rm(stateDir, { recursive: true, force: true });
  });

  return {
    sup,
    target: {
      url: sup.url,
      runtimeRoot: sup.runtimeRoot,
      hostState: { hostKey: health.host.hostKey },
    },
  };
}

async function startSession(
  booted: Booted,
  runId: string,
  resumeSessionId?: string,
): Promise<{
  sessionId: string;
  acpSessionId: string;
  stream: SseCollector;
}> {
  const session = await createSession(
    booted.target,
    { runId },
    resumeSessionId ? { resumeSessionId } : {},
  );

  return {
    ...session,
    stream: await collectSessionEvents(booted.sup.url, session.sessionId),
  };
}

async function prompt(
  booted: Booted,
  runId: string,
  sessionId: string,
): Promise<void> {
  const admitted = await postJson(
    `${booted.sup.url}/sessions/${sessionId}/prompts`,
    envelope(
      "session.prompt",
      { hostKey: booted.target.hostState.hostKey, runId },
      { stepId: "step-1", prompt: "do thing" },
    ),
  );

  expect(admitted.status).toBe(202);
}

async function promptAndPark(
  booted: Booted,
  runId: string,
  resumeSessionId?: string,
): Promise<Parked> {
  const session = await startSession(booted, runId, resumeSessionId);

  await prompt(booted, runId, session.sessionId);
  const permission = (await session.stream.waitFor(
    (e) => e.type === "session.permission_request",
  )) as PermissionRequestEvent;

  return { ...session, permission };
}

async function awaitTerminal(stream: SseCollector): Promise<SessionEvent> {
  return stream.waitFor(
    (e) => e.type === "session.exited" || e.type === "session.crashed",
    30_000,
  );
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe("host permission cap (ADR-180)", () => {
  // RED 1. The observable is the OUTCOME, not the shape: the handle is resumed
  // and the adapter replays the SAME tool call, rather than the column merely
  // being non-null.
  it("RED 1: the cap checkpoints the session and leaves a usable ACP handle", async () => {
    const booted = await boot();
    const runId = "run-cap-graceful";
    const parked = await promptAndPark(booted, runId);
    const terminal = await awaitTerminal(parked.stream);

    expect(terminal.type).toBe("session.exited");
    expect(terminal).toMatchObject({
      reason: "checkpoint",
      cause: "permission_cap",
    });

    const log = await booted.sup.logTail();

    expect(log).not.toContain("producer_permission_failed");
    expect(log).not.toContain("producer-output-incomplete");
    expect(log).not.toContain("sigterm-grace-expired-sigkill");

    const resumed = await promptAndPark(booted, runId, parked.acpSessionId);

    expect(resumed.acpSessionId).toBe(parked.acpSessionId);
    expect(resumed.sessionId).not.toBe(parked.sessionId);
    expect(resumed.permission.requestId).not.toBe(parked.permission.requestId);
    expect(resumed.permission.toolCall).toMatchObject({ toolCallId: "tc-1" });

    await resumed.stream.close();
    await parked.stream.close();
  }, 120_000);

  // RED 5. The WIRING only — that a production boot arms a cap at all. It
  // asserts nothing about teardown semantics; RED 1 owns those.
  it("RED 5: the production boot installs the cap — a pending permission is torn down", async () => {
    const booted = await boot();
    const parked = await promptAndPark(booted, "run-cap-wiring");

    await awaitTerminal(parked.stream);
    await parked.stream.close();
  }, 120_000);

  // RED 3. SIGTERM the supervisor itself while a permission is open. The
  // discriminant is `producer-output-incomplete`: it is logged only when
  // `abortOutput` fired, which is exactly what a REJECTED deferred causes.
  it("RED 3: graceful shutdown cancels the deferred instead of rejecting it", async () => {
    const booted = await boot({
      MAISTER_PERMISSION_MAX_HOURS: CAP_UNREACHABLE,
    });
    const parked = await promptAndPark(booted, "run-shutdown");

    await booted.sup.stop();

    const log = await booted.sup.logTail();

    expect(log).not.toContain("producer-output-incomplete");
    expect(log).not.toContain("producer_permission_failed");
    expect(log).not.toContain("shutdown-sigkill");
    await parked.stream.close();
  }, 120_000);

  // RED 6. The producer boundary is UNCHANGED: a malformed permission request
  // is a real fault and must still abort the output and SIGKILL the child.
  it("RED 6: a malformed permission request still fails the producer and SIGKILLs", async () => {
    const booted = await boot({
      MAISTER_PERMISSION_MAX_HOURS: CAP_UNREACHABLE,
      MOCK_ACP_PERMISSION_MALFORMED: "1",
    });
    const session = await startSession(booted, "run-producer-fault");

    await prompt(booted, "run-producer-fault", session.sessionId);

    const terminal = await awaitTerminal(session.stream);
    const log = await booted.sup.logTail();

    expect(terminal.type).toBe("session.crashed");
    expect(log).toContain("producer_permission_invalid");
    expect(log).toContain("producer-output-incomplete");
    await session.stream.close();
  }, 120_000);
});
