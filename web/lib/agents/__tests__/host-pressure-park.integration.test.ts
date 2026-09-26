// ADR-183 T4.3 — RED D3-agent: an agent turn the execution host parks under
// outbox pressure parks its RUN (it is interrupted, not failed) and resumes on
// the same ACP session when the host catches up.
//
//   C24      a ONE-SHOT agent's initial turn floods while the manager is
//            behind (the fault proxy holds every runtime-event frame); the
//            host parks it; the run parks `NeedsInputIdle` (the persistent
//            predicate is relaxed for this cause), the initial turn closes
//            `applied` (its input is what the resume repeats), and the
//            continuation worker's arm 3 resumes it on the same session — the
//            resumed session recalls the pre-park prompt.
//   message  a persistent agent's message turn the host parked is superseded
//            and re-queued as its successor (same variant, same text,
//            `message:requeue:<turnId>`); the run parks; a same-key retry of
//            the parent answers with the successor.
//   dispatch a claimed message turn whose dispatch the host refused is
//            superseded and re-queued as its successor (a claimed turn's
//            binding is immutable), and the run parks.
import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { ExecutionHost } from "@/lib/db/schema";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { SupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";

import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { startAgentContinuationWorker } from "@/lib/agents/continuation-worker";
import { parkClaimedAgentTurnForHostPressure } from "@/lib/agents/create-failure";
import { sendAgentMessage, startAgentSession } from "@/lib/agents/launch";
import { agentPromptOwner } from "@/lib/agents/prompt-owner";
import { acceptAgentMessage } from "@/lib/agents/turns";
import { claimAgentMessage } from "@/lib/agents/turn-claim";
import { mintAssignment } from "@/lib/execution-host/assignments";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { setDefaultTransportForTests } from "@/lib/execution-host/default-transport";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import {
  startProjectionWorker,
  type ProjectionWorker,
} from "@/lib/execution-host/events/projection-worker";
import { issueOwnedPrompt } from "@/lib/execution-host/ledger";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import {
  localHost,
  resetResolverForTests,
} from "@/lib/execution-host/resolver";
import { applyHostPressureSample } from "@/lib/scheduler/system-sweeps";
import { seedAgentRun } from "@/test-support/agent-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";
import { startSupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";

// FIXME(any): dual drizzle-orm peer-dep variants.
const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: Db;
let sup: RealSupervisor;
let proxy: SupervisorFaultProxy;
let projectionWorker: ProjectionWorker;
let continuationWorker: { stop: () => Promise<void> } | null = null;
let restoreUrl: () => void = () => {};
let hosts: ExecutionHosts;
const previousWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
const previousRuntimeRoot = process.env.MAISTER_RUNTIME_ROOT;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const PROMPT = "Remember ALBATROSS-42 and report back";
const AGENT_DEFINITION = `---\nname: Researcher\ndescription: d\nworkspace: none\nmode: session\nplatform_mcp: false\ntriggers:\n  - manual\nrisk_tier: read_only\n---\n${PROMPT}\n`;

const HOST_PARK_ERROR = {
  code: "ACP_PROTOCOL",
  message: "the host parked this session",
  details: { reason: "session_checkpointed", cause: "outbox_pressure" },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await probe();

    if (value) return value as T;
    if (Date.now() > deadline)
      throw new Error(
        `timed out waiting for ${what}\nsupervisor log:\n${await sup.logTail(4_000)}`,
      );
    await sleep(100);
  }
}

async function runRow(runId: string) {
  const [row] = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as Array<Record<string, any>>;

  return row;
}

async function turnsOf(runId: string) {
  return (await db
    .select()
    .from(schema.agentTurns)
    .where(eq(schema.agentTurns.runId, runId))
    .orderBy(asc(schema.agentTurns.ordinal))) as Array<Record<string, any>>;
}

async function hostHealth(): Promise<{ stream?: { pressured: boolean } }> {
  return (await (
    await fetch(`${sup.url}/health?includeStream=true`)
  ).json()) as { stream?: { pressured: boolean } };
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "adr183_agent_host_park",
  });
  db = testDatabase.db as unknown as Db;
  const journalDir = await mkdtemp(join(tmpdir(), "adr183-agent-journal-"));

  sup = await startRealSupervisor({
    fixture: "mock-acp-adapter-resumable.mjs",
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      MAISTER_TEST_PRODUCER_PAUSE_MAX_MS: "4000",
      MAISTER_KILL_GRACE_MS: "3000",
      MAISTER_EVENT_OUTBOX_LOW_ROWS: "4",
      MAISTER_EVENT_OUTBOX_SOFT_ROWS: "24",
      MAISTER_EVENT_OUTBOX_HARD_ROWS: "4000",
      MOCK_ACP_STATE_DIR: journalDir,
      MOCK_ACP_REMEMBER: "1",
      MOCK_ACP_FLOOD_FRAMES: "30",
      MOCK_ACP_FLOOD_BYTES: "1024",
      MOCK_ACP_HOLD_AFTER_FLOOD: "1",
    },
  });
  proxy = await startSupervisorFaultProxy(sup.url);
  restoreUrl = useRealSupervisorUrl(proxy.url);
  process.env.MAISTER_WORKTREES_ROOT = join(sup.runtimeRoot, "worktrees");
  process.env.MAISTER_RUNTIME_ROOT = join(sup.runtimeRoot, "manager");
  setDefaultTransportForTests(null);
  resetRegistrarStateForTests();
  resetResolverForTests();
  hosts = createExecutionHosts({ db });
  projectionWorker = startProjectionWorker({
    db,
    projectors: canonicalProjectors,
  });
}, 180_000);

afterAll(async () => {
  restoreUrl();
  if (previousWorktreesRoot === undefined)
    delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = previousWorktreesRoot;
  if (previousRuntimeRoot === undefined)
    delete process.env.MAISTER_RUNTIME_ROOT;
  else process.env.MAISTER_RUNTIME_ROOT = previousRuntimeRoot;
  await continuationWorker?.stop();
  await stopRuntimeEventConsumers();
  await projectionWorker?.stop();
  await proxy?.close();
  await sup?.kill();
  await testDatabase?.stop();
});

describe("ADR-183 D3-agent — host-pressure park of agent turns", () => {
  it("C24: a one-shot agent's initial turn parks its run and resumes on the same session with its context", async () => {
    const runId = await seedAgentRun(db, {
      runtimeRoot: sup.runtimeRoot,
      definition: AGENT_DEFINITION,
      workspace: "none",
      resultContract: null,
    });
    const held = proxy.arm(
      {
        caseId: "adr183-agent-behind",
        method: "GET",
        path: /^\/runtime-events$/,
      },
      "hold-events",
    );

    try {
      void startAgentSession(runId, { db, executionHosts: hosts }).catch(
        () => undefined,
      );
      await waitFor(
        async () => (await hostHealth()).stream?.pressured === true,
        "the host to report outbox pressure",
      );
      await applyHostPressureSample(await hosts.local().platformStatus());
      await waitFor(
        async () =>
          (await sup.logTail(4_000_000)).includes("checkpoint complete"),
        "the host to park the initial turn",
      );
    } finally {
      held.release();
    }

    // The manager catches up: the run PARKS — it is not Failed.
    await waitFor(
      async () => (await runRow(runId)).status === "NeedsInputIdle",
      "the one-shot run to park",
    );
    const parked = await runRow(runId);

    expect(parked.persistent).toBe(false);
    expect(parked.resumeRequestedAt).not.toBeNull();
    const [initial] = await turnsOf(runId);

    expect(initial).toMatchObject({ variant: "initial", state: "applied" });
    expect(
      (await turnsOf(runId)).filter((turn) => turn.state === "queued"),
    ).toHaveLength(0);
    const [released] = (await db
      .select()
      .from(schema.executionAssignments)
      .where(eq(schema.executionAssignments.runId, runId))) as Array<
      Record<string, any>
    >;

    expect(released).toMatchObject({
      state: "released",
      releasedReason: "parked",
    });

    // The host caught up; its sample clears the fence, and the continuation
    // worker's arm 3 resumes the parked run.
    await waitFor(
      async () => (await hostHealth()).stream?.pressured === false,
      "the host to clear its pressure",
    );
    await applyHostPressureSample(await hosts.local().platformStatus());
    continuationWorker = startAgentContinuationWorker({
      db,
      executionHosts: hosts,
    });
    const resumeTurn = await waitFor(
      async () => {
        const turns = await turnsOf(runId);

        return turns.find(
          (turn) => turn.variant === "resume" && turn.state === "applied",
        );
      },
      "the resumed generation to apply",
      90_000,
    );

    expect(resumeTurn.prompt).toContain("ALBATROSS-42");
    const incarnations = (await db
      .select()
      .from(schema.runSessionIncarnations)
      .where(eq(schema.runSessionIncarnations.runId, runId))) as Array<
      Record<string, any>
    >;

    expect(incarnations.length).toBeGreaterThanOrEqual(2);
    expect(new Set(incarnations.map((row) => row.acpSessionId)).size).toBe(1);
    const recalled = (await db
      .select()
      .from(schema.executionEvents)
      .where(
        and(
          eq(schema.executionEvents.runId, runId),
          eq(schema.executionEvents.eventType, "session.update"),
        ),
      )) as Array<Record<string, any>>;

    expect(
      recalled.some((event) =>
        JSON.stringify(event.payload).includes("recall: "),
      ),
    ).toBe(true);
    expect((await runRow(runId)).status).not.toBe("Failed");
  }, 240_000);

  it("message: a parked message is superseded by its successor, the run parks, and a same-key retry answers with the successor", async () => {
    const runId = await seedPersistentRun();
    const host = await localHost({ db });
    const message = await acceptAgentMessage(db, runId, "first input", {
      requestKey: "k-1",
    });
    const { command, assignment } = await dispatchMessage(runId, host, message);

    // The host parked the session: its incarnation ends `checkpointed` and the
    // prompt's rejection names the park. The manager has recorded the pressure
    // (its sample or a refusal), so the park's slot release promotes nothing.
    await db.insert(schema.executionHostPressure).values({
      executionHostId: host.id,
      pressuredSince: new Date(),
    });
    await db
      .update(schema.runSessionIncarnations)
      .set({ state: "checkpointed", endedAt: new Date() })
      .where(eq(schema.runSessionIncarnations.runId, runId));
    const prepared = await agentPromptOwner.prepare({
      db,
      owner: command.owner as never,
      command: command.row as never,
      outcome: { state: "failed", error: HOST_PARK_ERROR },
      signal: new AbortController().signal,
    });

    expect(await db.transaction((tx) => prepared.apply(tx as never))).toBe(
      "applied",
    );
    await prepared.afterCommit?.();

    const turns = await turnsOf(runId);
    const parent = turns.find((turn) => turn.id === message.id)!;
    const successor = turns.find(
      (turn) => turn.logicalKey === `message:requeue:${message.id}`,
    )!;

    expect(parent.state).toBe("superseded");
    expect(successor).toMatchObject({
      variant: "persistent_message",
      prompt: "first input",
      state: "queued",
    });
    expect(successor.ordinal).toBeGreaterThan(parent.ordinal);
    const run = await runRow(runId);

    expect(run.status).toBe("NeedsInputIdle");
    expect(run.resumeRequestedAt).not.toBeNull();
    const [releasedAssignment] = (await db
      .select()
      .from(schema.executionAssignments)
      .where(eq(schema.executionAssignments.id, assignment.id))) as Array<
      Record<string, any>
    >;

    expect(releasedAssignment.releasedReason).toBe("parked");

    // The retry answers with the successor. The fence keeps the claim
    // queued, so no session is started here.
    try {
      const answer = await sendAgentMessage(runId, "first input", {
        db,
        executionHosts: hosts,
        requestKey: "k-1",
      });

      expect(answer).toMatchObject({
        messageId: successor.id,
        messageState: "queued",
      });
    } finally {
      await db
        .delete(schema.executionHostPressure)
        .where(eq(schema.executionHostPressure.executionHostId, host.id));
    }
  });

  it("dispatch: a claimed message the host refused to dispatch goes back to queued and the run parks", async () => {
    const runId = await seedPersistentRun();
    const host = await localHost({ db });
    const assignment = await db.transaction((tx) =>
      mintAssignment(tx as never, { runId, hostId: host.id, reason: "resume" }),
    );

    await db
      .update(schema.runs)
      .set({ status: "Running" })
      .where(eq(schema.runs.id, runId));
    await db
      .update(schema.runSessions)
      .set({ executionAssignmentId: assignment.id })
      .where(eq(schema.runSessions.runId, runId));
    const message = await acceptAgentMessage(db, runId, "refused input");
    const claim = await claimAgentMessage(db, message.id, host);

    expect(claim.kind).toBe("claimed");
    const client = { assignment, host } as never;

    await db.insert(schema.executionHostPressure).values({
      executionHostId: host.id,
      pressuredSince: new Date(),
    });

    expect(
      await parkClaimedAgentTurnForHostPressure(
        db,
        client,
        (await turnsOf(runId)).find((turn) => turn.id === message.id) as never,
      ),
    ).toBe(true);
    const turns = await turnsOf(runId);

    expect(turns.find((row) => row.id === message.id)?.state).toBe(
      "superseded",
    );
    expect(
      turns.find((row) => row.logicalKey === `message:requeue:${message.id}`),
    ).toMatchObject({
      variant: message.variant,
      prompt: "refused input",
      state: "queued",
    });
    const run = await runRow(runId);

    expect(run.status).toBe("NeedsInputIdle");
    expect(run.resumeRequestedAt).not.toBeNull();
    await db
      .delete(schema.executionHostPressure)
      .where(eq(schema.executionHostPressure.executionHostId, host.id));
  });
});

async function seedPersistentRun(): Promise<string> {
  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    runKind: "agent",
    flowVersion: "agent",
    flowRevision: "manual",
    status: "NeedsInputIdle",
    persistent: true,
  });
  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    acpSessionId: `acp-${runId}`,
  });

  return runId;
}

// A message dispatched on a live incarnation — the state the host parks.
async function dispatchMessage(
  runId: string,
  host: ExecutionHost,
  message: Record<string, any>,
) {
  const assignment = await db.transaction((tx) =>
    mintAssignment(tx as never, { runId, hostId: host.id, reason: "resume" }),
  );
  const [session] = (await db
    .select()
    .from(schema.runSessions)
    .where(eq(schema.runSessions.runId, runId))) as Array<Record<string, any>>;
  const incarnationId = randomUUID();
  const targetSessionId = randomUUID();

  await db
    .update(schema.runSessions)
    .set({
      executionAssignmentId: assignment.id,
      hostSessionId: targetSessionId,
    })
    .where(eq(schema.runSessions.id, session.id));
  await db.insert(schema.runSessionIncarnations).values({
    id: incarnationId,
    runId,
    runSessionId: session.id,
    executionAssignmentId: assignment.id,
    assignmentEpoch: assignment.epoch,
    executionHostId: host.id,
    hostSessionId: targetSessionId,
    acpSessionId: `acp-${runId}`,
    state: "active",
    origin: "native",
  });
  await db
    .update(schema.runs)
    .set({ status: "Running" })
    .where(eq(schema.runs.id, runId));
  await db
    .update(schema.agentTurns)
    .set({
      state: "claimed",
      executionAssignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
      runSessionId: session.id,
    })
    .where(eq(schema.agentTurns.id, message.id));
  const operationKey = `agent_turn:persistent_message:${message.id}:${message.ordinal}`;
  const owner = {
    kind: "agent_turn" as const,
    ref: {
      version: 1 as const,
      variant: "persistent_message" as const,
      messageId: message.id,
      turnId: message.id,
      promptOrdinal: message.ordinal,
      runId,
      assignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
      runSessionId: session.id,
      incarnationId,
    },
  };
  const issued = await issueOwnedPrompt(db, {
    assignment,
    host,
    targetSessionId,
    payload: { stepId: "agent", prompt: message.prompt },
    maxAttempts: 3,
    admitOwner: async (tx) => {
      await tx.select().from(schema.runs).where(eq(schema.runs.id, runId));

      return {
        owner,
        logicalOperationKey: operationKey,
        assertCommit: async () => {
          const [admitted] = (await tx
            .select()
            .from(schema.executionCommands)
            .where(
              eq(schema.executionCommands.logicalOperationKey, operationKey),
            )) as Array<Record<string, any>>;

          await tx
            .update(schema.agentTurns)
            .set({
              state: "dispatched",
              commandId: admitted.id,
              incarnationId,
            })
            .where(eq(schema.agentTurns.id, message.id));
        },
      };
    },
  });
  const [row] = (await db
    .select()
    .from(schema.executionCommands)
    .where(eq(schema.executionCommands.id, issued.row.id))) as Array<
    Record<string, any>
  >;

  return { command: { owner, row }, assignment };
}
