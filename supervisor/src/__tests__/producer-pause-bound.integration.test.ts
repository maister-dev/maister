// ADR-183 D6/D7 — a producer paused by outbox pressure is bounded: past
// PRODUCER_PAUSE_MAX_MS the host checkpoints it with ADR-180's graceful
// teardown (`cause: "outbox_pressure"`), and the interrupted prompt's rejection
// names the park. Driven through the PRODUCTION boot (`main.ts` as a child
// process); the bound is shortened through the test-only seam, which only a
// NODE_ENV=test process reads.
//
// Controls:
//   D3-host   the park is graceful, ordered (terminal before the rejection),
//             and the ACP handle resumes with its prior context
//   D3-perm   a permission pending during the pause answers 410
//             session_checkpointed
//   control   pressure relieved before the bound: no park, the turn finishes
import type { SessionEvent } from "../types";

import { randomUUID } from "node:crypto";
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

const WHOLE_LOG = Number.MAX_SAFE_INTEGER;
const BOUND_MS = 1_500;

type Booted = { sup: RealSupervisor; target: HostTarget };

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function boot(env: Record<string, string>): Promise<Booted> {
  const stateDir = await mkdtemp(join(tmpdir(), "adr183-journal-"));
  const sup = await startRealSupervisor({
    fixture: "mock-acp-adapter-resumable.mjs",
    env: {
      // The seam is read only by a test process.
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      MAISTER_TEST_PRODUCER_PAUSE_MAX_MS: String(BOUND_MS),
      // Tiny row budgets: a few dozen unACKed rows are pressure.
      MAISTER_EVENT_OUTBOX_LOW_ROWS: "8",
      MAISTER_EVENT_OUTBOX_SOFT_ROWS: "20",
      MAISTER_EVENT_OUTBOX_HARD_ROWS: "400",
      MAISTER_KILL_GRACE_MS: "3000",
      MOCK_ACP_STATE_DIR: stateDir,
      MOCK_ACP_REMEMBER: "1",
      MOCK_ACP_FLOOD_FRAMES: "60",
      MOCK_ACP_FLOOD_BYTES: "4096",
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

async function start(
  booted: Booted,
  runId: string,
  resumeSessionId?: string,
): Promise<{ sessionId: string; acpSessionId: string; stream: SseCollector }> {
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
  text: string,
): Promise<string> {
  const body = envelope(
    "session.prompt",
    { hostKey: booted.target.hostState.hostKey, runId },
    { stepId: "step-1", prompt: text },
  );
  const admitted = await postJson(
    `${booted.sup.url}/sessions/${sessionId}/prompts`,
    body,
  );

  expect(admitted.status).toBe(202);

  return body.command.id;
}

async function receipt(
  booted: Booted,
  commandId: string,
): Promise<{ phase: string; body: Record<string, any> }> {
  const response = await fetch(`${booted.sup.url}/commands/${commandId}`);

  return (await response.json()) as {
    phase: string;
    body: Record<string, any>;
  };
}

async function ackEverything(booted: Booted): Promise<void> {
  const health = (await (
    await fetch(`${booted.sup.url}/health?includeStream=true`)
  ).json()) as { stream: { streamId: string; headSequence: string | null } };

  if (health.stream.headSequence === null) return;
  const acked = await postJson(`${booted.sup.url}/runtime-events/ack`, {
    streamId: health.stream.streamId,
    throughSequence: health.stream.headSequence,
  });

  expect(acked.status).toBe(200);
}

type OutboxEnvelope = {
  sequence: string;
  eventType: string;
  hostSessionId: string | null;
  payload: unknown;
};

async function durableEvents(booted: Booted): Promise<OutboxEnvelope[]> {
  const health = (await (
    await fetch(`${booted.sup.url}/health?includeStream=true`)
  ).json()) as { stream: { streamId: string; headSequence: string } };
  const events: OutboxEnvelope[] = [];
  let after = "0";

  for (;;) {
    const page = (await (
      await fetch(
        `${booted.sup.url}/runtime-events/span?streamId=${health.stream.streamId}&after=${after}&through=${health.stream.headSequence}`,
      )
    ).json()) as {
      state: string;
      nextAfter: string | null;
      events: OutboxEnvelope[];
    };

    expect(page.state).not.toBe("unavailable");
    events.push(...page.events);
    if (page.nextAfter === null) return events;
    after = page.nextAfter;
  }
}

function count(log: string, needle: string): number {
  return log.split(needle).length - 1;
}

describe("ADR-183 producer pause bound", () => {
  it("D3-host: a paused producer is checkpointed gracefully, its prompt names the park, and the handle resumes with prior context", async () => {
    const booted = await boot({ MOCK_ACP_HOLD_AFTER_FLOOD: "1" });
    const runId = `run-pause-${randomUUID()}`;
    const session = await start(booted, runId);
    const commandId = await prompt(
      booted,
      runId,
      session.sessionId,
      "ALBATROSS-42",
    );
    const terminal = await session.stream.waitFor(
      (e) => e.type === "session.exited" || e.type === "session.crashed",
      30_000,
    );

    expect(terminal).toMatchObject({
      type: "session.exited",
      reason: "checkpoint",
      cause: "outbox_pressure",
    });
    await expect
      .poll(async () => (await receipt(booted, commandId)).phase, {
        timeout: 10_000,
      })
      .toBe("rejected");
    expect((await receipt(booted, commandId)).body).toMatchObject({
      code: "ACP_PROTOCOL",
      details: { reason: "session_checkpointed", cause: "outbox_pressure" },
    });
    // ADR-180 order, on the durable outbox: the terminal is committed before
    // the prompt's rejection.
    const outbox = await durableEvents(booted);
    const exitedAt = outbox.findIndex(
      (e) =>
        e.eventType === "session.exited" &&
        e.hostSessionId === session.sessionId,
    );
    const rejectedAt = outbox.findIndex(
      (e) =>
        e.eventType === "session.command" &&
        (e.payload as { commandId?: string; phase?: string }).commandId ===
          commandId &&
        (e.payload as { phase?: string }).phase === "completed",
    );

    expect(exitedAt).toBeGreaterThanOrEqual(0);
    expect(rejectedAt).toBeGreaterThan(exitedAt);

    await expect
      .poll(
        async () =>
          (await booted.sup.logTail(WHOLE_LOG)).includes("checkpoint complete"),
        { timeout: 5_000, interval: 50 },
      )
      .toBe(true);
    const log = await booted.sup.logTail(WHOLE_LOG);

    expect(count(log, "producer-pause-exceeded")).toBe(1);
    expect(log).not.toContain("sigterm-grace-expired-sigkill");
    expect(log).not.toContain("checkpoint-pause-bound-escalated");

    // The manager catches up; the same ACP session resumes WITH its context.
    await ackEverything(booted);
    const resumed = await start(booted, runId, session.acpSessionId);

    expect(resumed.acpSessionId).toBe(session.acpSessionId);
    await prompt(booted, runId, resumed.sessionId, "what did I say?");
    await resumed.stream.waitFor(
      (e: SessionEvent) =>
        e.type === "session.update" &&
        JSON.stringify(e.update).includes("recall: ALBATROSS-42"),
      15_000,
    );

    await resumed.stream.close();
    await session.stream.close();
  }, 120_000);

  it("D3-perm: a permission pending during the pause is cancelled as a checkpoint and its answer is told to resume", async () => {
    const booted = await boot({
      MOCK_ACP_PERMISSION_THEN_FLOOD: "1",
    });
    const runId = `run-pause-perm-${randomUUID()}`;
    const session = await start(booted, runId);

    await prompt(booted, runId, session.sessionId, "needs a tool");
    const permission = (await session.stream.waitFor(
      (e) => e.type === "session.permission_request",
      30_000,
    )) as Extract<SessionEvent, { type: "session.permission_request" }>;

    await session.stream.waitFor((e) => e.type === "session.exited", 30_000);
    const answered = await postJson(
      `${booted.sup.url}/sessions/${session.sessionId}/input`,
      envelope(
        "session.input",
        { hostKey: booted.target.hostState.hostKey, runId },
        {
          kind: "permission",
          action: "select",
          requestId: permission.requestId,
          optionId: "allow",
        },
      ),
    );

    expect(answered.status).toBe(410);
    expect(answered.body.details).toMatchObject({
      reason: "session_checkpointed",
    });
    await session.stream.close();
  }, 120_000);

  it("control: pressure relieved before the bound wakes the producer without a park", async () => {
    const booted = await boot({
      MAISTER_TEST_PRODUCER_PAUSE_MAX_MS: "6000",
    });
    const runId = `run-pause-control-${randomUUID()}`;
    const session = await start(booted, runId);
    const commandId = await prompt(
      booted,
      runId,
      session.sessionId,
      "flood then finish",
    );

    // Keep ACKing like a caught-up manager until the turn finishes.
    const deadline = Date.now() + 20_000;

    while ((await receipt(booted, commandId)).phase === "accepted") {
      expect(Date.now()).toBeLessThan(deadline);
      await ackEverything(booted);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect((await receipt(booted, commandId)).phase).toBe("completed");
    // Past the bound: no park was ever started.
    await new Promise((resolve) => setTimeout(resolve, 6_500));
    const log = await booted.sup.logTail(WHOLE_LOG);

    expect(log).not.toContain("producer-pause-exceeded");
    expect(session.stream.events.some((e) => e.type === "session.exited")).toBe(
      false,
    );
    await session.stream.close();
  }, 120_000);
});
