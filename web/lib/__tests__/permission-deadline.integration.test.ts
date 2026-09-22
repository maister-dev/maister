// ADR-180 — the manager half of "one owner for the permission deadline",
// against a REAL supervisor child, real Postgres and a real ProjectionWorker.
//
//   PREFLIGHT (blocking) terminal `session.exited` rows carry eventStreamId
//                        and hostSequence — without them the terminal witness
//                        is not implementable as specified.
//   RED 2  the web owns the deadline: repeated real activity bumps keep the
//          run out of Pass 1, and the answer is delivered to a live agent.
//   RED 4a an answer landing after a checkpoint but inside the 30 s registry
//          grace gets 410 `session_checkpointed` → 202 resume, never Failed.
//   RED 4b the same answer after the grace gets a retryable 503, and the next
//          sweep tick parks the run.
//   RED 7  a host-initiated checkpoint's ordering is proven by the TERMINAL
//          witness, and the resolved order says so (`boundary: "terminal"`).
//   RED 8  the driver front-runs the sweeper, so no checkpoint command row is
//          ever minted — and the answer still resumes.
//   RED 9  a checkpointed run whose `keepalive_until` is held in the FUTURE by
//          a live operator tab is parked anyway.
//
// No control waits on the clock: the sweep is driven by calling
// `runSweepTick()` directly, and the keep-alive window is a DB column.
import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { RealSupervisor } from "@/test-support/real-supervisor";

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
import { respondToHitl, type HitlActor } from "@/lib/services/hitl";
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

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let projectionWorker: ProjectionWorker;
let db: Db;
let sup: RealSupervisor;
let restoreUrl: () => void = () => {};
let hosts: ExecutionHosts;

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

async function commandsOf(runId: string) {
  return (await db
    .select()
    .from(schema.executionCommands)
    .where(eq(schema.executionCommands.runId, runId))
    .orderBy(asc(schema.executionCommands.createdAt))) as Array<
    Record<string, any>
  >;
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

async function seedAgentRun(name: string) {
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
  const { runId } = await seedAgentRun(name);
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

async function registryHolds(hostSessionId: string): Promise<boolean> {
  const res = await fetch(`${sup.url}/sessions`);
  const body = (await res.json()) as { sessions?: Array<{ sessionId: string }> };

  return (body.sessions ?? []).some((s) => s.sessionId === hostSessionId);
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
    const after = await runRow(runId);

    expect(after.status).not.toBe("Failed");
    expect(after.status).not.toBe("Crashed");
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
    );

    const res = await respondToHitl(
      { runId, hitlRequestId: hitl.id, body: { optionId: "allow" } },
      actor,
      { db, executionHosts: hosts },
    );

    expect(res.status).toBe(503);
    expect((await runRow(runId)).status).not.toBe("Failed");

    // The operator's tab is still alive, so only the checkpointed arm can
    // park this run.
    await bumpKeepalive(runId, { db });
    await runSweepTick({ db, executionHosts: hosts });
    expect((await runRow(runId)).status).toBe("NeedsInputIdle");
  }, 180_000);

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
    // resolved order that names WHICH witness proved it. Without the
    // discriminator the control cannot tell a working extension from a
    // coincidence, so it is asserted rather than inferred.
    const order = await (
      permissionCheckpointOrder as unknown as (
        database: Db,
        command: unknown,
        checkpoint: unknown,
      ) => Promise<
        | { order: "before_checkpoint" | "after_checkpoint"; boundary: string }
        | "unproven"
      >
    )(db, prompt, null);

    expect(order).toMatchObject({ boundary: "terminal" });
    expect(["before_checkpoint", "after_checkpoint"]).toContain(
      (order as { order: string }).order,
    );
  }, 180_000);

  // RED 8. The flow driver observes `session.exited{reason:checkpoint}` on its
  // OWN stream and parks the run before any sweep tick, so the manager never
  // mints a `session.checkpoint` command at all — and the answer must still
  // resume.
  it("RED 8: the driver front-runs the sweeper; no checkpoint command is minted and the answer still resumes", async () => {
    const { runId, hitl, flow } = await parkOnPermission("front-run");

    await awaitHostCheckpoint(runId, "front-run");
    await flow.catch(() => undefined);
    await waitFor(
      async () => (await runRow(runId)).status === "NeedsInputIdle",
      "front-run: the driver's own park",
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
});
