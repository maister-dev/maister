// ADR-183 T4.1 — RED D3-flow: a flow node the execution host parks under
// outbox pressure is parked on a host-paused `node_interrupt` and resumed on
// the SAME attempt when the host catches up — with its ACP context when a
// session existed, fresh when the host refused the node at start. Against a
// REAL supervisor (the resumable mock adapter) behind the fault proxy, which
// holds every `GET /runtime-events` frame — the manager ingests nothing and so
// ACKs nothing: it is behind, exactly the state the host's pressure means.
//
//   D3-flow  run A floods mid-turn; the host's bounded pause parks it
//            (`cause: outbox_pressure`); the manager, catching up, parks the
//            node, idles it (Pass 1b) and the sweep resumes it through
//            `session/resume`: the resumed session recalls the pre-park prompt
//            (the ALBATROSS witness) and the node finishes on attempt 1.
//   create   run B is refused at node start while the host is pressured: it
//            parks with no resume handle and resumes on a fresh session.
//   W1       the park and its rejection are ingested only after the fact.
//   W2       the first park transaction throws: the driver yields and the
//            flow continuation worker replays the stored completion into it.
//   W4       A's answer is recorded without a claim (a crash between the two):
//            the sweep's re-drive claims it.
//   W6       an interrupt already answered is never auto-resumed.
//   C21      the OPERATOR's interrupt records the same handle, so its `resume`
//            continues the session too (it used to spawn a fresh one).
//   D3-authz a machine actor still cannot answer a host-paused interrupt.
import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { SupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";

import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { setDefaultTransportForTests } from "@/lib/execution-host/default-transport";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import {
  startProjectionWorker,
  type ProjectionWorker,
} from "@/lib/execution-host/events/projection-worker";
import { mintPlacement } from "@/lib/execution-host/placement";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import {
  localHost,
  resetResolverForTests,
} from "@/lib/execution-host/resolver";
import { startFlowContinuationWorker } from "@/lib/flows/graph/continuation-worker";
import { runFlow } from "@/lib/flows/runner";
import { createHitlRequest } from "@/lib/runs/hitl-create";
import { escalateNodeInterrupt } from "@/lib/runs/node-interrupt";
import { runSweepTick } from "@/lib/runs/keepalive-sweeper";
import {
  DEFAULT_SYSTEM_SWEEP_JOB_ID,
  ensureDefaultSchedulerJobs,
  requestSchedulerJobNow,
} from "@/lib/scheduler/jobs";
import { applyHostPressureSample } from "@/lib/scheduler/system-sweeps";
import { runSchedulerTick } from "@/lib/scheduler/tick-service";
import { resumeHostPausedInterrupts, respondToHitl } from "@/lib/services/hitl";
import { addWorktree, initRepo } from "@/test-support/git-fixture";
import { seedGraphRun } from "@/test-support/graph-run-seed";
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

// W2: the first park of the named run throws inside the driver.
const parkFault = vi.hoisted(() => ({ runId: null as string | null }));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", () => ({
  requireProjectAction: vi.fn(async () => {}),
  requireActiveSession: vi.fn(async () => ({ id: "u-1" })),
}));
vi.mock("@/lib/runs/node-interrupt", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/runs/node-interrupt")>();

  return {
    ...actual,
    parkNodeForHostPressure: async (
      args: Parameters<typeof actual.parkNodeForHostPressure>[0],
    ) => {
      if (parkFault.runId === args.runId) {
        parkFault.runId = null;
        throw new Error("injected: the park transaction failed");
      }

      return actual.parkNodeForHostPressure(args);
    },
  };
});

const PROMPT = "Remember ALBATROSS-42 and implement it";

const FLOW = {
  schemaVersion: 1,
  name: "adr183",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: PROMPT },
      transitions: { success: "done" },
    },
  ],
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

async function attemptsOf(runId: string) {
  return (await db
    .select()
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.runId, runId))
    .orderBy(asc(schema.nodeAttempts.attempt))) as Array<Record<string, any>>;
}

async function interruptOf(runId: string) {
  const [row] = (await db
    .select()
    .from(schema.hitlRequests)
    .where(
      and(
        eq(schema.hitlRequests.runId, runId),
        eq(schema.hitlRequests.kind, "node_interrupt"),
      ),
    )) as Array<Record<string, any>>;

  return row ?? null;
}

async function incarnationsOf(runId: string) {
  return (await db
    .select()
    .from(schema.runSessionIncarnations)
    .where(eq(schema.runSessionIncarnations.runId, runId))
    .orderBy(asc(schema.runSessionIncarnations.createdAt))) as Array<
    Record<string, any>
  >;
}

async function commandsOf(runId: string, kind: string) {
  return (await db
    .select()
    .from(schema.executionCommands)
    .where(
      and(
        eq(schema.executionCommands.runId, runId),
        eq(schema.executionCommands.kind, kind),
      ),
    )
    .orderBy(asc(schema.executionCommands.createdAt))) as Array<
    Record<string, any>
  >;
}

async function hostHealth(): Promise<{
  stream?: { pressured: boolean; unacknowledgedCount: number };
}> {
  return (await (
    await fetch(`${sup.url}/health?includeStream=true`)
  ).json()) as { stream?: { pressured: boolean; unacknowledgedCount: number } };
}

async function seedFlowRun(name: string) {
  const repoPath = await initRepo(`${sup.runtimeRoot}/repo-${name}`);
  const worktreePath = await addWorktree(
    repoPath,
    `${sup.runtimeRoot}/wt-${name}`,
    `maister/${name}`,
  );
  const seeded = await seedGraphRun(testDatabase.db, FLOW, {
    repoPath,
    workspace: { worktreePath, parentRepoPath: repoPath },
  });
  const placementHost = await localHost({ db });

  await db.transaction((tx) =>
    mintPlacement(tx as unknown as Db, {
      runId: seeded.runId,
      reason: "launch",
      host: placementHost,
    }),
  );

  return seeded;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "adr183_host_pressure_park",
  });
  db = testDatabase.db as unknown as Db;
  const journalDir = await mkdtemp(join(tmpdir(), "adr183-park-journal-"));

  sup = await startRealSupervisor({
    fixture: "mock-acp-adapter-resumable.mjs",
    env: {
      // The pause bound's test seam is read only by a NODE_ENV=test host.
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      // Long enough that a manager KEEPING UP relieves a flood's brief pause
      // (the operator case), short enough that a held stream parks at once.
      MAISTER_TEST_PRODUCER_PAUSE_MAX_MS: "4000",
      MAISTER_KILL_GRACE_MS: "3000",
      // A few dozen unACKed rows are pressure; retained rows never are.
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
  await db.insert(schema.users).values({ id: "u-1", email: "u-1@test.local" });
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

describe("ADR-183 D3-flow — host-pressure park and auto-resume", () => {
  it("parks a flooding node and a node refused at start; the sweep resumes the first WITH its context and the second fresh, both on attempt 1", async () => {
    const runtimeRoot = process.env.MAISTER_RUNTIME_ROOT as string;
    const a = await seedFlowRun("flood");
    const b = await seedFlowRun("refused");
    const held = proxy.arm(
      {
        caseId: "adr183-behind",
        method: "GET",
        path: /^\/runtime-events$/,
      },
      "hold-events",
    );
    let flowA: Promise<unknown> = Promise.resolve();
    let flowB: Promise<unknown> = Promise.resolve();

    // W2: A's first park transaction throws, whenever the manager learns of
    // the park (the stream after release, or an earlier host-span read).
    parkFault.runId = a.runId;
    try {
      // A floods mid-turn while the manager cannot ACK: the host pauses it.
      flowA = runFlow(a.runId, { db, runtimeRoot, executionHosts: hosts });
      await waitFor(
        async () => (await hostHealth()).stream?.pressured === true,
        "the host to report outbox pressure",
      );
      // The manager learns it from its health sample (the refusal below would
      // set it too).
      expect(
        await applyHostPressureSample(await hosts.local().platformStatus()),
      ).toMatchObject({ transition: "entered" });

      // B starts while the host is pressured: its node is refused at start.
      flowB = runFlow(b.runId, { db, runtimeRoot, executionHosts: hosts });
      await waitFor(
        async () => (await interruptOf(b.runId)) !== null,
        "B's host-paused interrupt",
      );
      await flowB;

      // A's pause is bounded: the host parks it gracefully while the manager
      // still receives nothing on its stream (W1: the park is learned after
      // the fact).
      await waitFor(
        async () =>
          (await sup.logTail(4_000_000)).includes("checkpoint complete"),
        "the host to park A",
      );
    } finally {
      held.release();
    }

    // The live driver yields (W2); the continuation worker replays the stored
    // completion into the park.
    await flowA;
    continuationWorker = startFlowContinuationWorker({
      db,
      runtimeRoot,
      executionHosts: hosts,
    });
    const parkedA = await waitFor(
      async () => interruptOf(a.runId),
      "A's host-paused interrupt (after the W2 replay)",
    );

    expect(parkFault.runId).toBeNull();
    for (const [runId, parked] of [
      [a.runId, parkedA],
      [b.runId, await interruptOf(b.runId)],
    ] as const) {
      expect(parked).toMatchObject({
        kind: "node_interrupt",
        stepId: "implement",
        respondedAt: null,
        schema: {
          cause: "host_pressure",
          actor: { type: "system" },
          decisions: ["resume", "restart_node", "restart_from", "stop"],
        },
      });
      expect((await runRow(runId)).status).toBe("NeedsInput");
      const [attempt] = await attemptsOf(runId);

      expect(attempt).toMatchObject({ attempt: 1, status: "NeedsInput" });
      expect(attempt.actionCompletion).toBeNull();
      const [escalated] = (await db
        .select()
        .from(schema.domainEvents)
        .where(
          and(
            eq(schema.domainEvents.runId, runId),
            eq(schema.domainEvents.kind, "run.escalated"),
          ),
        )) as Array<Record<string, any>>;

      expect(escalated).toMatchObject({
        actorType: "system",
        payload: { reason: "node_interrupt", cause: "host_pressure" },
      });
    }
    // A had a session: its handle is recorded on the attempt. B never had one.
    const [attemptA] = await attemptsOf(a.runId);
    const [firstIncarnationA] = await incarnationsOf(a.runId);

    expect(attemptA.actionResume).toMatchObject({
      kind: "interrupt",
      cause: "host_pressure",
      resumeSessionId: firstIncarnationA.acpSessionId,
      promptOrdinal: attemptA.actionPromptOrdinal,
    });
    expect((await attemptsOf(b.runId))[0].actionResume).toBeNull();
    const [promptA] = await commandsOf(a.runId, "session.prompt");

    expect(promptA).toMatchObject({
      state: "failed",
      lastError: {
        code: "ACP_PROTOCOL",
        details: { reason: "session_checkpointed", cause: "outbox_pressure" },
      },
    });

    // The keep-alive sweeper idles A when its incarnation projected
    // `checkpointed` (Pass 1b). When the prompt's completion was applied
    // BEFORE the projector saw `session.created` — the manager was behind, so
    // either order happens — the create is stale and the incarnation `lost`:
    // A then keeps its slot until the resume, which needs no idle.
    const settled = await waitFor(async () => {
      const [incarnation] = await incarnationsOf(a.runId);

      return ["checkpointed", "lost"].includes(incarnation?.state)
        ? incarnation.state
        : null;
    }, "A's incarnation projected terminal");

    await runSweepTick({ db: db as never, executionHosts: hosts });
    expect((await runRow(a.runId)).status).toBe(
      settled === "checkpointed" ? "NeedsInputIdle" : "NeedsInput",
    );
    expect((await runRow(b.runId)).status).toBe("NeedsInput");

    // W4: A's answer committed but its claim never ran.
    await db
      .update(schema.hitlRequests)
      .set({
        respondedAt: new Date(),
        response: {
          optionId: "resume",
          actor: { type: "system" },
          cause: "host_pressure",
        },
      })
      .where(eq(schema.hitlRequests.id, parkedA.id));

    // The host caught up. The scheduler's system_sweep samples it, clears the
    // record, resumes B's open interrupt and re-drives A's answered one.
    await waitFor(
      async () => (await hostHealth()).stream?.pressured === false,
      "the host to clear its pressure",
    );
    await ensureDefaultSchedulerJobs({ db: db as never });
    await requestSchedulerJobNow({
      jobId: DEFAULT_SYSTEM_SWEEP_JOB_ID,
      db: db as never,
    });
    await runSchedulerTick({ jobKind: "system_sweep" });
    expect(await db.select().from(schema.executionHostPressure)).toHaveLength(
      0,
    );

    // A resumes on attempt 1 through session/resume: the resumed session
    // recalls the prompt it was given before the park.
    await waitFor(
      async () => (await runRow(a.runId)).status === "Review",
      "A to finish after the resume",
      90_000,
    );
    const finishedA = await attemptsOf(a.runId);

    expect(finishedA).toHaveLength(1);
    expect(finishedA[0]).toMatchObject({ attempt: 1, status: "Succeeded" });
    expect(finishedA[0].decision).toBeNull();
    expect(finishedA[0].stdout).toContain("recall: ");
    expect(finishedA[0].stdout).toContain("ALBATROSS-42");
    const incarnationsA = await incarnationsOf(a.runId);

    expect(incarnationsA.length).toBeGreaterThanOrEqual(2);
    expect(
      new Set(incarnationsA.map((incarnation) => incarnation.acpSessionId)),
    ).toEqual(new Set([firstIncarnationA.acpSessionId]));

    // B resumes on attempt 1 with a FRESH session (no handle was recorded).
    await waitFor(
      async () =>
        (await commandsOf(b.runId, "session.create")).some(
          (command) => command.state === "succeeded",
        ),
      "B's fresh session after the resume",
      90_000,
    );
    const answeredB = await interruptOf(b.runId);

    expect(answeredB).toMatchObject({
      response: {
        optionId: "resume",
        actor: { type: "system" },
        cause: "host_pressure",
      },
    });
    expect(answeredB.respondedAt).not.toBeNull();
    const attemptsB = await attemptsOf(b.runId);

    expect(attemptsB).toHaveLength(1);
    expect(attemptsB[0].status).toBe("Running");
    const createdB = (await commandsOf(b.runId, "session.create")).find(
      (command) => command.state === "succeeded",
    );

    expect(
      JSON.stringify(createdB?.payload ?? {}).includes("resumeSessionId"),
    ).toBe(false);
  }, 300_000);

  it("C21: the operator's interrupt records the ACP handle, and its resume continues the session", async () => {
    const runtimeRoot = process.env.MAISTER_RUNTIME_ROOT as string;
    const c = await seedFlowRun("operator");
    const flowC = runFlow(c.runId, { db, runtimeRoot, executionHosts: hosts });
    const [incarnation] = await waitFor(async () => {
      const [prompt] = await commandsOf(c.runId, "session.prompt");
      const incarnations = await incarnationsOf(c.runId);

      return prompt?.state === "accepted" && incarnations[0]?.acpSessionId
        ? incarnations
        : null;
    }, "C's turn in flight");
    const client = await hosts.forRun(c.runId);
    const interrupted = await escalateNodeInterrupt({
      db,
      runId: c.runId,
      actor: { type: "user", id: "u-1" },
      cause: "operator",
      supervisorSessionId: incarnation.hostSessionId,
      checkpointSession: (id) => client.checkpoint(id),
    });

    expect(interrupted.resumeHandle).toBe(true);
    const [parked] = await attemptsOf(c.runId);

    expect(parked.actionResume).toMatchObject({
      kind: "interrupt",
      cause: "operator",
      resumeSessionId: incarnation.acpSessionId,
      promptOrdinal: parked.actionPromptOrdinal,
    });
    expect(await interruptOf(c.runId)).toMatchObject({
      schema: { cause: "operator", actor: { type: "user", id: "u-1" } },
    });
    await flowC;

    await respondToHitl(
      {
        runId: c.runId,
        hitlRequestId: interrupted.hitlRequestId,
        body: { optionId: "resume" },
      },
      { kind: "user", userId: "u-1", label: "Test User" },
      { db, executionHosts: hosts },
    );
    await waitFor(
      async () => (await runRow(c.runId)).status === "Review",
      "C to finish after the operator's resume",
      90_000,
    );
    const finished = await attemptsOf(c.runId);

    expect(finished).toHaveLength(1);
    expect(finished[0].stdout).toContain("recall: ");
    expect(finished[0].stdout).toContain("ALBATROSS-42");
    expect(
      new Set((await incarnationsOf(c.runId)).map((row) => row.acpSessionId)),
    ).toEqual(new Set([incarnation.acpSessionId]));
    expect((await interruptOf(c.runId))?.response).toMatchObject({
      optionId: "resume",
      actor: { type: "user", id: "u-1" },
      cause: "operator",
    });
  }, 180_000);

  it("W6: an interrupt already answered is never auto-resumed", async () => {
    const seeded = await seedGraphRun(testDatabase.db, FLOW);
    const hitlRequestId = randomUUID();

    await db.transaction((tx) =>
      createHitlRequest(tx as never, {
        id: hitlRequestId,
        runId: seeded.runId,
        stepId: "implement",
        kind: "node_interrupt",
        schema: { kind: "node_interrupt", cause: "host_pressure" },
        prompt: "paused",
      }),
    );
    await db
      .update(schema.hitlRequests)
      .set({ respondedAt: new Date(), response: { optionId: "stop" } })
      .where(eq(schema.hitlRequests.id, hitlRequestId));

    const summary = await resumeHostPausedInterrupts(db, {
      autoResume: true,
      executionHosts: hosts,
    });

    expect(summary.resumeFailures).not.toContain(hitlRequestId);
    const [row] = (await db
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, hitlRequestId))) as Array<
      Record<string, any>
    >;

    expect(row.response).toEqual({ optionId: "stop" });
  });

  it("D3-authz: a machine actor still cannot answer a host-paused interrupt", async () => {
    const seeded = await seedGraphRun(testDatabase.db, FLOW);
    const hitlRequestId = randomUUID();

    await db
      .update(schema.runs)
      .set({ status: "NeedsInput", currentStepId: "implement" })
      .where(eq(schema.runs.id, seeded.runId));
    await db.transaction((tx) =>
      createHitlRequest(tx as never, {
        id: hitlRequestId,
        runId: seeded.runId,
        stepId: "implement",
        kind: "node_interrupt",
        schema: {
          kind: "node_interrupt",
          cause: "host_pressure",
          actor: { type: "system" },
        },
        prompt: "paused",
      }),
    );
    const run = await runRow(seeded.runId);

    await expect(
      respondToHitl(
        {
          runId: seeded.runId,
          hitlRequestId,
          body: { optionId: "resume" },
        },
        {
          kind: "api_token",
          tokenId: "token-1",
          projectId: run.projectId,
          label: "machine",
        },
        { db, executionHosts: hosts },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
