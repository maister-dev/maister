// ADR-180 — the manager half of "one owner for the permission deadline",
// against a REAL supervisor child, real Postgres and a real ProjectionWorker.
//
//   PREFLIGHT (blocking) terminal `session.exited` rows carry eventStreamId
//                        and hostSequence — without them the terminal witness
//                        is not implementable as specified.
//   RED 2  the web owns the deadline: repeated real activity bumps keep the
//          run out of Pass 1, and the answer is delivered to a live agent.
//   RED 4a an answer landing after a checkpoint but inside the 30 s registry
//          grace gets 410 `session_checkpointed` → 202 resume, never Failed,
//          and the resumed session gets the answer delivered.
//   RED 4b the same answer after the grace gets a retryable 503, the next
//          sweep tick parks the run, and the operator's RETRY resumes it.
//   RED 7  a host-initiated checkpoint's ordering is proven by the TERMINAL
//          witness, and the interrupted prompt lands AFTER the checkpoint.
//   RED 8  the driver front-runs the sweeper, so no checkpoint command row is
//          ever minted — and the answer still resumes and is delivered.
//   RED 9  a checkpointed run whose `keepalive_until` is held in the FUTURE by
//          a live operator tab is parked anyway.
//   RED 12 the checkpointed arm leaves a resume IN FLIGHT alone — the window
//          between `markResumed` and the create ack is not a park.
//   RED 13 an AGENT run answered in the race window takes the agent resume,
//          never the flow one.
//   RED 14 an agent run the host parked itself resumes on the terminal
//          witness — no checkpoint command row exists to wait for.
//
// No control waits on the clock: the sweep is driven by calling
// `runSweepTick()` directly, and the keep-alive window is a DB column.
import type { Db } from "@/lib/execution-host/db";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { startAgentContinuationWorker } from "@/lib/agents/continuation-worker";
import { startAgentSession } from "@/lib/agents/launch";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { setDefaultTransportForTests } from "@/lib/execution-host/default-transport";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import {
  startProjectionWorker,
  type ProjectionWorker,
} from "@/lib/execution-host/events/projection-worker";
import { permissionCheckpointOrder } from "@/lib/execution-host/permission-handoff-evidence";
import { mintPlacement } from "@/lib/execution-host/placement";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import {
  localHost,
  resetResolverForTests,
} from "@/lib/execution-host/resolver";
import { runFlow } from "@/lib/flows/runner";
import { runSweepTick } from "@/lib/runs/keepalive-sweeper";
import { bumpKeepalive } from "@/lib/runs/state-transitions";
import { getHitlInbox } from "@/lib/queries/hitl";
import { respondToHitl, type HitlActor } from "@/lib/services/hitl";
import { resolveHitlErrorMessage } from "@/lib/ui-error-message";
import { seedAgentRun } from "@/test-support/agent-run-seed";
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

// FIXME(any): dual drizzle-orm peer-dep variants.
const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let projectionWorker: ProjectionWorker;
let db: Db;
let sup: RealSupervisor;
let restoreUrl: () => void = () => {};
let hosts: ExecutionHosts;
const previousWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
const previousRuntimeRoot = process.env.MAISTER_RUNTIME_ROOT;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", () => ({
  requireProjectAction: vi.fn(async () => {}),
  requireActiveSession: vi.fn(async () => ({ id: "u-1" })),
}));

const actor: HitlActor = { kind: "user", userId: "u-1", label: "Test User" };

const AGENT_FLOW = {
  schemaVersion: 1,
  name: "adr180",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "do thing" },
      transitions: { success: "done" },
    },
  ],
};

// A `worktree` agent: the only workspace axis whose permission requests reach
// the web — read-only sessions are arbitrated inline by the host.
const AGENT_DEFINITION =
  "---\nname: Researcher\ndescription: d\nworkspace: worktree\nmode: session\nplatform_mcp: false\ntriggers:\n  - manual\nrisk_tier: read_only\n---\ndo thing\n";

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
  const rows = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as Array<Record<string, any>>;

  return rows[0];
}

async function hitlRows(runId: string) {
  return (await db
    .select()
    .from(schema.hitlRequests)
    .where(eq(schema.hitlRequests.runId, runId))) as Array<Record<string, any>>;
}

async function sessionRow(runId: string) {
  const rows = (await db
    .select()
    .from(schema.runSessions)
    .where(eq(schema.runSessions.runId, runId))) as Array<Record<string, any>>;

  return rows[0];
}

async function commandsOf(runId: string): Promise<ExecutionCommand[]> {
  return (await db
    .select()
    .from(schema.executionCommands)
    .where(eq(schema.executionCommands.runId, runId))
    .orderBy(
      asc(schema.executionCommands.createdAt),
    )) as unknown as ExecutionCommand[];
}

async function answered(runId: string): Promise<boolean> {
  const rows = await hitlRows(runId);

  return rows.length > 0 && rows.every((row) => row.respondedAt !== null);
}

async function failedEvents(
  runId: string,
): Promise<Array<Record<string, any>>> {
  return (await db
    .select()
    .from(schema.domainEvents)
    .where(
      and(
        eq(schema.domainEvents.runId, runId),
        eq(schema.domainEvents.kind, "run.failed"),
      ),
    )) as Array<Record<string, any>>;
}

async function publicStoredAnswer(
  runId: string,
  hitlId: string,
): Promise<unknown> {
  const run = await runRow(runId);
  const inbox = await getHitlInbox(run.projectId, { db: db as any });

  return inbox.items.find((item) => item.hitlRequestId === hitlId);
}

// The ORIGINAL permission row: the agent resume grant lives on it, while the
// resumed session's reissued request is a second row of the same run.
async function grantOn(hitlId: string) {
  const [row] = (await db
    .select()
    .from(schema.hitlRequests)
    .where(eq(schema.hitlRequests.id, hitlId))) as Array<Record<string, any>>;

  return row?.response?._agentResume ? row : null;
}

async function expectReissuedPermissionDelivered(
  runId: string,
  originalHitlId: string,
): Promise<void> {
  const original = await grantOn(originalHitlId);
  const grant = original?.response?._agentResume;
  const rows = await hitlRows(runId);
  const reissued = rows.find((row) => row.id === grant?.reissuedHitlRequestId);
  const inputs = (await commandsOf(runId)).filter(
    (command) =>
      command.kind === "session.input" && command.state === "succeeded",
  );

  expect(grant).toMatchObject({ kind: "continue", inputCommandId: null });
  expect(original?.respondedAt).not.toBeNull();
  expect(reissued?.respondedAt).not.toBeNull();
  expect(inputs).toHaveLength(1);
  expect(inputs[0]?.assignmentEpoch).toBeGreaterThan(1);
}

async function checkpointedIncarnationOf(runId: string) {
  const rows = (await db
    .select()
    .from(schema.runSessionIncarnations)
    .where(
      and(
        eq(schema.runSessionIncarnations.runId, runId),
        eq(schema.runSessionIncarnations.state, "checkpointed"),
      ),
    )) as Array<Record<string, any>>;

  return rows[0] ?? null;
}

async function assignmentsOf(runId: string) {
  return (await db
    .select()
    .from(schema.executionAssignments)
    .where(eq(schema.executionAssignments.runId, runId))
    .orderBy(asc(schema.executionAssignments.epoch))) as Array<
    Record<string, any>
  >;
}

async function terminalCheckpointEvents(runId: string) {
  return (await db
    .select()
    .from(schema.executionEvents)
    .where(
      and(
        eq(schema.executionEvents.runId, runId),
        eq(schema.executionEvents.eventType, "session.exited"),
      ),
    )) as Array<Record<string, any>>;
}

async function seedFlowRun(name: string) {
  const repoPath = await initRepo(`${sup.runtimeRoot}/repo-${name}`);
  const worktreePath = await addWorktree(
    repoPath,
    `${sup.runtimeRoot}/wt-${name}`,
    `maister/${name}`,
  );
  const seeded = await seedGraphRun(testDatabase.db, AGENT_FLOW, {
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

// Drives the run to its permission park and returns the live HITL row.
async function parkOnPermission(name: string): Promise<{
  runId: string;
  hitl: Record<string, any>;
  flow: Promise<unknown>;
}> {
  const { runId } = await seedFlowRun(name);
  const flow = runFlow(runId, {
    db,
    runtimeRoot: sup.runtimeRoot,
    executionHosts: hosts,
  });
  const hitl = await waitFor(async () => {
    const [row] = await hitlRows(runId);

    return row && (await runRow(runId)).status === "NeedsInput" ? row : null;
  }, `${name}: NeedsInput + permission HITL row`);

  return { runId, hitl, flow };
}

// The agent twin of `parkOnPermission`, through the production launcher. The
// driver is not awaited: a host park detaches it without a result.
async function parkAgentOnPermission(name: string): Promise<{
  runId: string;
  hitl: Record<string, any>;
}> {
  const runId = await seedAgentRun(db, {
    runtimeRoot: sup.runtimeRoot,
    definition: AGENT_DEFINITION,
    workspace: "worktree",
    resultContract: null,
  });

  void startAgentSession(runId, { db, executionHosts: hosts }).catch(
    () => undefined,
  );
  const hitl = await waitFor(async () => {
    const [row] = await hitlRows(runId);

    return row && (await runRow(runId)).status === "NeedsInput" ? row : null;
  }, `${name}: agent NeedsInput + permission HITL row`);

  return { runId, hitl };
}

// The host's OWN checkpoint — the absolute cap firing on the pending
// permission. There is NO route for this: `POST /sessions/:id/checkpoint`
// refuses a request with no command envelope, which is precisely why a
// host-initiated checkpoint mints no command and leaves no admission event.
// The control therefore waits for the real cap rather than simulating it.
async function awaitHostCheckpoint(
  runId: string,
  what: string,
): Promise<Record<string, any>> {
  return waitFor(async () => {
    const rows = await terminalCheckpointEvents(runId);

    return rows.find((row) => row.payload?.reason === "checkpoint") ?? null;
  }, `${what}: the host cap's terminal session.exited{reason:checkpoint}`);
}

// `GET /sessions` answers a bare ARRAY of the registry's entries — including
// terminal ones, until the heartbeat removes them after the 30 s grace.
async function registryHolds(hostSessionId: string): Promise<boolean> {
  const rows = (await (await fetch(`${sup.url}/sessions`)).json()) as Array<{
    sessionId: string;
  }>;

  return rows.some((row) => row.sessionId === hostSessionId);
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "adr180_deadline_test",
  });
  db = testDatabase.db as unknown as Db;
  const journalDir = await mkdtemp(join(tmpdir(), "adr180-journal-"));

  sup = await startRealSupervisor({
    fixture: "mock-acp-adapter-resumable.mjs",
    env: {
      MOCK_ACP_REQUEST_PERMISSION: "1",
      MOCK_ACP_STATE_DIR: journalDir,
      // ~8 s. Long enough for RED 2 to bump, sweep and answer against a LIVE
      // agent (it needs ~0.5 s), short enough that the five cap-driven
      // controls do not wait on the clock in any meaningful sense.
      MAISTER_PERMISSION_MAX_HOURS: "0.00222",
    },
  });
  restoreUrl = useRealSupervisorUrl(sup.url);
  // The agent launcher resolves its roots from the environment, and the host
  // adopts only workspaces under its own roots.
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
  await stopRuntimeEventConsumers();
  await projectionWorker?.stop();
  await sup?.kill();
  await testDatabase?.stop();
});

describe("permission deadline — one owner (ADR-180)", () => {
  // BLOCKING PREFLIGHT. If a terminal `session.exited` row carries a null
  // stream id or host sequence, the terminal witness cannot order anything and
  // the whole evidence change has to be re-raised before it is written.
  it("PREFLIGHT: a terminal session.exited row carries eventStreamId and hostSequence", async () => {
    const { runId, flow } = await parkOnPermission("preflight");
    const checkpointEvent = await awaitHostCheckpoint(runId, "preflight");

    await flow.catch(() => undefined);

    expect(checkpointEvent.source).toBe("host");
    expect(checkpointEvent.ingestDisposition).toBe("accepted");
    expect(checkpointEvent.eventStreamId).not.toBeNull();
    expect(checkpointEvent.hostSequence).not.toBeNull();
  }, 180_000);

  // RED 2. Activity bumps go through the REAL activity path; the sweep is
  // driven directly between them. The discriminant is that the answer is
  // DELIVERED to a live agent — on master the host's own 30-minute copy of
  // the window owns the deadline and nothing the web does can extend it.
  it("RED 2: real activity bumps keep the run out of the sweep, and the answer is delivered", async () => {
    const { runId, hitl, flow } = await parkOnPermission("owns-deadline");

    for (let i = 0; i < 3; i += 1) {
      await bumpKeepalive(runId, { db });
      await runSweepTick({ db, executionHosts: hosts });
      expect((await runRow(runId)).status).toBe("NeedsInput");
    }

    const res = await respondToHitl(
      { runId, hitlRequestId: hitl.id, body: { optionId: "allow" } },
      actor,
      { db, executionHosts: hosts },
    );

    expect(res.status).toBe(200);
    await waitFor(async () => {
      const [row] = await hitlRows(runId);

      return row?.respondedAt ? row : null;
    }, "owns-deadline: the answer delivered to the live agent");
    await flow.catch(() => undefined);
    expect((await runRow(runId)).status).not.toBe("Failed");
  }, 180_000);

  // RED 4a. Inside the 30 s registry grace the host answers 410 with the
  // `session_checkpointed` discriminator. The run must resume, never fail.
  it("RED 4a: an answer inside the terminal grace resumes instead of failing the run", async () => {
    const { runId, hitl, flow } = await parkOnPermission("race-410");

    await awaitHostCheckpoint(runId, "race-410");
    await flow.catch(() => undefined);
    const res = await respondToHitl(
      { runId, hitlRequestId: hitl.id, body: { optionId: "allow" } },
      actor,
      { db, executionHosts: hosts },
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ state: "resume-in-progress" });
    expect(await publicStoredAnswer(runId, hitl.id)).toMatchObject({
      answerState: "answer_stored",
      storedResponse: { optionId: "allow" },
    });
    // The resumed session re-issues the permission and the driver delivers
    // the stored answer against it: the OUTCOME, not just the 202.
    await waitFor(
      async () => (await answered(runId)) || null,
      "race-410: the answer delivered to the resumed session",
    );
    const after = await runRow(runId);

    expect(after.status).not.toBe("Failed");
    expect(after.status).not.toBe("Crashed");
    expect(await failedEvents(runId)).toHaveLength(0);
    expect(await publicStoredAnswer(runId, hitl.id)).toBeUndefined();
  }, 180_000);

  // RED 4b. After the grace the registry entry is gone: the answer is a
  // RETRYABLE 503 and the run stays answerable, and the sweeper's
  // checkpointed arm parks it on the next tick.
  it("RED 4b: an answer after the terminal grace is retryable, and the next tick parks the run", async () => {
    const { runId, hitl, flow } = await parkOnPermission("race-503");

    await awaitHostCheckpoint(runId, "race-503");
    await flow.catch(() => undefined);
    const session = await sessionRow(runId);

    // The ONE wall-clock wait in this file, and it is the property under test:
    // the host keeps a terminal session in its registry for 30 s. It is not a
    // window this change compresses — the two windows that ARE (the host cap
    // and the web keep-alive) are driven by env and by a DB column.
    await waitFor(
      async () => ((await registryHolds(session.hostSessionId)) ? null : true),
      "race-503: the registry entry to age out of its 30 s terminal grace",
      90_000,
    );

    const res = await respondToHitl(
      { runId, hitlRequestId: hitl.id, body: { optionId: "allow" } },
      actor,
      { db, executionHosts: hosts },
    );

    expect(res.status).toBe(503);
    const body = await res.json();

    expect(body).toEqual({
      code: "EXECUTOR_UNAVAILABLE",
      message:
        "Your answer is saved; delivery is pending. Retry delivery to send it.",
      details: { reason: "delivery_unavailable" },
    });
    expect(resolveHitlErrorMessage(body)).toEqual({
      key: "errorReasons.delivery_unavailable",
    });
    expect(await publicStoredAnswer(runId, hitl.id)).toMatchObject({
      answerState: "answer_stored",
      storedResponse: { optionId: "allow" },
    });
    expect((await runRow(runId)).status).not.toBe("Failed");

    // The operator's tab is still alive, so only the checkpointed arm can
    // park this run.
    await bumpKeepalive(runId, { db });
    await runSweepTick({ db, executionHosts: hosts });
    expect((await runRow(runId)).status).toBe("NeedsInputIdle");

    // One step past the park: the operator retries. The 503 left a delivery
    // intent naming a command the host never admitted; the idle resume must
    // withdraw it and re-deliver, not wait forever for its receipt.
    const retry = await respondToHitl(
      { runId, hitlRequestId: hitl.id, body: { optionId: "allow" } },
      actor,
      { db, executionHosts: hosts },
    );

    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({
      ok: true,
      state: "resume-in-progress",
    });
    await waitFor(
      async () => (await answered(runId)) || null,
      "race-503: the retried answer delivered to the resumed session",
    );
    expect((await runRow(runId)).status).not.toBe("Failed");
    expect(await failedEvents(runId)).toHaveLength(0);
    expect(await publicStoredAnswer(runId, hitl.id)).toBeUndefined();
  }, 180_000);

  // NO run-kind controls here, deliberately. ADR-180 does not widen the agent
  // or scratch idle paths, and a flow-shaped run RELABELLED `scratch`/`agent`
  // is a chimera, not a stand-in: `prepareFlowPermissionResult` returns early
  // on a non-flow run kind, so the relabelled run fails a prompt-owner
  // invariant that a real scratch or agent run never reaches. It was written,
  // it failed for that reason, and it was removed rather than weakened — a
  // control that certifies a chimera proves nothing. What holds for every kind
  // without a control is structural: the `session_checkpointed` branch returns
  // BEFORE the terminal arm that writes `Crashed` (scratch) or `Failed`. A
  // faithful per-kind control needs each kind's own launcher harness.

  // RED 7. The witness discriminator itself: without it the control passes
  // vacuously whenever the command boundary happens to exist.
  it("RED 7: a host-initiated checkpoint's order is proven by the terminal witness", async () => {
    const { runId, flow } = await parkOnPermission("terminal-witness");

    await awaitHostCheckpoint(runId, "terminal-witness");
    await flow.catch(() => undefined);

    const prompt = (await commandsOf(runId)).find(
      (c) => c.kind === "session.prompt",
    );

    expect(prompt).toBeDefined();
    // The contract this control demands: a NULLABLE checkpoint command, and a
    // resolved order that names WHICH witness proved it. The ORDER is asserted
    // too: the park interrupts the prompt, and the host commits the prompt's
    // rejection AFTER the session's own terminal, so the interruption reads
    // `after_checkpoint` — a `before` would hand it forward as a completed
    // failed result instead of a continuation.
    const order = await permissionCheckpointOrder(db, prompt!, null);

    expect(order).toEqual({ order: "after_checkpoint", boundary: "terminal" });
  }, 180_000);

  // RED 8. A park the HOST performed itself mints no `session.checkpoint`
  // command at all — whether the flow driver observes the terminal on its own
  // stream first or the sweeper's checkpointed arm gets there, both orderings
  // are real and neither produces a command. So the resume cannot be authorized
  // by a command boundary, and it must still happen.
  //
  // The park is RED 9's subject and the 410 answer is RED 4a's; what this
  // control owns is the ABSENCE of the command row and a resume placement
  // minted without one.
  it("RED 8: a host-initiated park mints no checkpoint command, and the answer still resumes", async () => {
    const { runId, hitl, flow } = await parkOnPermission("front-run");

    await awaitHostCheckpoint(runId, "front-run");
    await flow.catch(() => undefined);
    await runSweepTick({ db, executionHosts: hosts });
    await waitFor(
      async () => (await runRow(runId)).status === "NeedsInputIdle",
      "front-run: the run parked",
    );

    expect(
      (await commandsOf(runId)).filter((c) => c.kind === "session.checkpoint"),
    ).toHaveLength(0);

    const res = await respondToHitl(
      { runId, hitlRequestId: hitl.id, body: { optionId: "allow" } },
      actor,
      { db, executionHosts: hosts },
    );

    expect(res.status).toBe(202);
    const assignments = await assignmentsOf(runId);

    expect(assignments.map((a) => a.placementReason)).toContain("resume");
    await waitFor(
      async () => (await answered(runId)) || null,
      "front-run: the answer delivered to the resumed session",
    );
    expect((await runRow(runId)).status).not.toBe("Failed");
  }, 180_000);

  // RED 9. The bound that does not depend on the operator's tab. On master and
  // on the unrefined plan this run is never parked, so Pass 2's 24 h
  // `Abandoned` rule can never reach it either.
  it("RED 9: a checkpointed session is parked even with keepalive_until in the future", async () => {
    const { runId, flow } = await parkOnPermission("bounded-park");

    await awaitHostCheckpoint(runId, "bounded-park");
    await waitFor(async () => {
      const rows = (await db
        .select()
        .from(schema.runSessionIncarnations)
        .where(
          eq(schema.runSessionIncarnations.state, "checkpointed"),
        )) as Array<Record<string, any>>;

      return rows.length > 0 ? rows : null;
    }, "bounded-park: the checkpointed incarnation");
    await flow.catch(() => undefined);

    // Undo whatever park the driver already performed: the control is about
    // the SWEEPER's arm, with the operator's tab holding the window open.
    await db
      .update(schema.runs)
      .set({
        status: "NeedsInput",
        checkpointAt: null,
        keepaliveUntil: new Date(Date.now() + 30 * 60_000),
      })
      .where(eq(schema.runs.id, runId));

    await runSweepTick({ db, executionHosts: hosts });

    expect((await runRow(runId)).status).toBe("NeedsInputIdle");
  }, 180_000);

  // RED 12. Between `markResumed` (which mints the next assignment and flips
  // the run back to `NeedsInput`) and the create ack (which retires the prior
  // incarnation) the run looks exactly like RED 9's subject. A park there
  // releases the resume's fresh assignment under its own feet and the run sits
  // "resuming" forever. The checkpointed incarnation must belong to the run's
  // CURRENT assignment.
  it("RED 12: the checkpointed arm leaves a resume in flight alone", async () => {
    const { runId, flow } = await parkOnPermission("resume-window");

    await awaitHostCheckpoint(runId, "resume-window");
    await waitFor(
      () => checkpointedIncarnationOf(runId),
      "resume-window: the checkpointed incarnation",
    );
    await flow.catch(() => undefined);
    const placementHost = await localHost({ db });

    await db
      .update(schema.runs)
      .set({
        status: "NeedsInput",
        checkpointAt: null,
        keepaliveUntil: new Date(Date.now() + 30 * 60_000),
      })
      .where(eq(schema.runs.id, runId));
    const minted = await db.transaction((tx) =>
      mintPlacement(tx as unknown as Db, {
        runId,
        reason: "resume",
        host: placementHost,
      }),
    );

    await runSweepTick({ db, executionHosts: hosts });

    expect((await runRow(runId)).status).toBe("NeedsInput");
    const active = (await assignmentsOf(runId)).filter(
      (a) => a.state === "active",
    );

    expect(active.map((a) => a.id)).toEqual([minted.id]);
  }, 180_000);

  // RED 13. The race-window arm forks on run KIND: an agent run has its own
  // idle claim (agent pool cap, its own resume evidence, `startAgentSession`)
  // and the flow resume would fail it — a `none`/`repo_read` agent has no
  // `workspaces` row at all. The discriminator is the agent grant: only the
  // agent claim writes `_agentResume`. The settled source may yield either a
  // continue or a result grant; agent prompt-owner tests pin the continue arm.
  it("RED 13: an agent run answered in the race window keeps its agent-owned grant", async () => {
    const { runId, hitl } = await parkAgentOnPermission("agent-race");

    await awaitHostCheckpoint(runId, "agent-race");
    const res = await respondToHitl(
      { runId, hitlRequestId: hitl.id, body: { optionId: "allow" } },
      actor,
      { db, executionHosts: hosts },
    );

    expect(res.status).toBe(202);
    expect((await runRow(runId)).status).not.toBe("Failed");
    const continuation = startAgentContinuationWorker({
      db,
      executionHosts: hosts,
    });

    try {
      const granted = await waitFor(
        () => grantOn(hitl.id),
        "agent-race: the agent resume grant",
      );

      expect(granted.response._agentResume).toMatchObject({
        checkpointCommandId: null,
        inputCommandId: null,
        sourceCommandId: expect.any(String),
        assignmentId: expect.any(String),
      });
      expect(["continue", "result"]).toContain(
        granted.response._agentResume.kind,
      );
      await waitFor(
        async () => (await answered(runId)) || null,
        "agent-race: the permission answered",
      );
      await expectReissuedPermissionDelivered(runId, hitl.id);
      expect((await runRow(runId)).status).not.toBe("Failed");
    } finally {
      await continuation.stop();
    }
  }, 180_000);

  // RED 14. A park the host performed itself mints no checkpoint command, and
  // the agent idle claim used to wait for one forever (`checkpoint_not_confirmed`
  // until the 24 h TTL). The session's own terminal is the witness now.
  it("RED 14: a host-parked agent run settles on the terminal witness", async () => {
    const { runId, hitl } = await parkAgentOnPermission("agent-host-park");

    await awaitHostCheckpoint(runId, "agent-host-park");
    await waitFor(
      () => checkpointedIncarnationOf(runId),
      "agent-host-park: the checkpointed incarnation",
    );
    await runSweepTick({ db, executionHosts: hosts });
    expect((await runRow(runId)).status).toBe("NeedsInputIdle");
    expect(
      (await commandsOf(runId)).filter((c) => c.kind === "session.checkpoint"),
    ).toHaveLength(0);

    const res = await respondToHitl(
      { runId, hitlRequestId: hitl.id, body: { optionId: "allow" } },
      actor,
      { db, executionHosts: hosts },
    );

    expect(res.status).toBe(202);
    const continuation = startAgentContinuationWorker({
      db,
      executionHosts: hosts,
    });

    try {
      const granted = await waitFor(
        () => grantOn(hitl.id),
        "agent-host-park: the agent resume grant",
      );

      expect(granted.response._agentResume).toMatchObject({
        checkpointCommandId: null,
        inputCommandId: null,
        sourceCommandId: expect.any(String),
        assignmentId: expect.any(String),
      });
      expect(["continue", "result"]).toContain(
        granted.response._agentResume.kind,
      );
      await waitFor(
        async () => (await answered(runId)) || null,
        "agent-host-park: the permission answered",
      );
      await expectReissuedPermissionDelivered(runId, hitl.id);
      const after = await runRow(runId);

      expect(after.status).not.toBe("Failed");
      expect(after.status).not.toBe("NeedsInputIdle");
    } finally {
      await continuation.stop();
    }
  }, 180_000);
});
