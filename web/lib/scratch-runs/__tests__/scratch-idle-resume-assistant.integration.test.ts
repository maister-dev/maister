// C5 (review 2026-09-27): a project-less local-package assistant run parked by
// the host's permission cap resumes into its locked working dir, so its idle
// resume passes the same ADR-097 gate Recover does — the launching user,
// holding the live edit lock. The freed-slot gate has no actor: it admits the
// run only while that lock is still held. Real Postgres, the fake host.

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { capForPool, promoteNextPending } from "@/lib/scheduler";
import { respondToHitl, type HitlActor } from "@/lib/services/hitl";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schema>;

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
  closeDb: async () => {},
}));

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "scratch_idle_resume_assistant",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

type Parked = {
  runId: string;
  hitlRequestId: string;
  ownerId: string;
  packageId: string;
  hosts: Awaited<ReturnType<typeof fakeExecutionHosts>>["hosts"];
  fake: Awaited<ReturnType<typeof fakeExecutionHosts>>["fake"];
};

async function seedUser(): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.users).values({
    id,
    email: `u-${id.slice(0, 8)}@test.local`,
    role: "member",
    accountStatus: "active",
  });

  return id;
}

// A parked assistant permission, as the host's cap leaves it: the run
// `NeedsInputIdle`, the dialog `NeedsInput`, the request open.
async function parkedAssistant(opts: {
  lockHeld: boolean;
  answered?: boolean;
  queuedAt?: Date;
  // Another run's host: a fresh fake retires every other host.
  fake?: Parked["fake"];
  // The host parked the session, but the projection has not caught up: the
  // run still reads `NeedsInput` over an `active` incarnation.
  live?: boolean;
}): Promise<Parked> {
  const ownerId = await seedUser();
  const packageId = randomUUID();
  const runId = randomUUID();
  const runnerId = randomUUID();

  await db.insert(schema.localPackages).values({
    id: packageId,
    name: "Assistant package",
    slug: `pkg-${packageId.slice(0, 8)}`,
    workingDir: `/tmp/pkg-${packageId.slice(0, 8)}`,
    lockedByUserId: ownerId,
    lockedBySession: `lock-${packageId.slice(0, 8)}`,
    lockExpiresAt: new Date(Date.now() + (opts.lockHeld ? 3_600_000 : -60_000)),
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(
      testPlatformRunnerRow(
        runnerId,
        "claude",
      ) as typeof schema.platformAcpRunners.$inferInsert,
    );
  await db.insert(schema.runs).values({
    id: runId,
    runKind: "scratch",
    projectId: null,
    localPackageId: packageId,
    flowVersion: "scratch",
    status: opts.live ? "NeedsInput" : "NeedsInputIdle",
    checkpointAt: opts.live ? null : new Date(),
    resumeRequestedAt: opts.answered ? (opts.queuedAt ?? new Date()) : null,
  });
  await db.insert(schema.scratchRuns).values({
    runId,
    projectId: null,
    localPackageId: packageId,
    createdByUserId: ownerId,
    initialPrompt: "edit the flow",
    baseBranch: "main",
    baseCommit: "deadbeef",
    dialogStatus: "NeedsInput",
  });
  // The parked session, as the host's cap left it: its incarnation ended
  // `checkpointed` on the run's current assignment.
  const { assignment, hostId, hosts, fake } = await fakeExecutionHosts(
    db as never,
    { runId, fake: opts.fake },
  );
  const runSessionId = randomUUID();
  const acpSessionId = `acp-${runId.slice(0, 8)}`;
  // Unique per host: runs may share one fake host.
  const hostSessionId = `sup-${runId.slice(0, 8)}`;

  await db.insert(schema.runSessions).values({
    id: runSessionId,
    runId,
    sessionName: "default",
    runnerId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(runnerId),
    acpSessionId,
    hostSessionId,
    executionAssignmentId: assignment!.id,
  });
  await db.insert(schema.runSessionIncarnations).values({
    id: randomUUID(),
    runSessionId,
    runId,
    executionAssignmentId: assignment!.id,
    assignmentEpoch: assignment!.epoch,
    executionHostId: hostId,
    hostSessionId,
    acpSessionId,
    state: opts.live ? "active" : "checkpointed",
    origin: "native",
    endedAt: opts.live ? null : new Date(),
  });
  if (opts.live)
    fake.sessions.set(hostSessionId, {
      sessionId: hostSessionId,
      runId,
      stepId: "scratch",
      acpSessionId,
      executionWorkspaceId: "ws_seeded",
      assignmentEpoch: assignment!.epoch,
      createdByCommandId: "seeded",
      status: "exited",
      intentionalReason: "checkpoint",
    });
  const hitlRequestId = randomUUID();

  await db.insert(schema.hitlRequests).values({
    id: hitlRequestId,
    runId,
    stepId: "scratch",
    kind: "permission",
    prompt: "Allow this action?",
    schema: {
      requestId: "req-1",
      supervisorSessionId: hostSessionId,
      options: [{ optionId: "allow" }, { optionId: "deny" }],
    },
    response: opts.answered ? { optionId: "allow" } : null,
  });

  return { runId, hitlRequestId, ownerId, packageId, hosts, fake };
}

async function answerAs(parked: Parked, userId: string) {
  const actor: HitlActor = { kind: "user", userId, label: "Operator" };

  return respondToHitl(
    {
      runId: parked.runId,
      hitlRequestId: parked.hitlRequestId,
      body: { optionId: "allow" },
    },
    actor,
    { db: db as never, executionHosts: parked.hosts },
  );
}

async function stateOf(parked: Parked) {
  const [run] = await db
    .select({
      status: schema.runs.status,
      resumeRequestedAt: schema.runs.resumeRequestedAt,
    })
    .from(schema.runs)
    .where(eq(schema.runs.id, parked.runId));
  const [row] = await db
    .select({ response: schema.hitlRequests.response })
    .from(schema.hitlRequests)
    .where(eq(schema.hitlRequests.id, parked.hitlRequestId));
  const placements = await db
    .select({ id: schema.executionAssignments.id })
    .from(schema.executionAssignments)
    .where(
      and(
        eq(schema.executionAssignments.runId, parked.runId),
        eq(schema.executionAssignments.placementReason, "resume"),
      ),
    );

  return {
    ...run,
    response: row.response,
    resumePlacements: placements.length,
  };
}

describe("a parked assistant run resumes only through the ADR-097 gate (C5)", () => {
  it("another user's answer is refused before anything is stored", async () => {
    const parked = await parkedAssistant({ lockHeld: true });

    await expect(answerAs(parked, await seedUser())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(await stateOf(parked)).toMatchObject({
      status: "NeedsInputIdle",
      response: null,
      resumePlacements: 0,
    });
  });

  it("the launching user without the live edit lock is refused before anything is stored", async () => {
    const parked = await parkedAssistant({ lockHeld: false });

    await expect(answerAs(parked, parked.ownerId)).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "edit_lock_not_held" },
    });
    expect(await stateOf(parked)).toMatchObject({
      status: "NeedsInputIdle",
      response: null,
      resumePlacements: 0,
    });
  });

  // Phase 1 sees `NeedsInput`, so the live path stores the answer; the host
  // answers `session_checkpointed` and the route parks and resumes. The gate
  // at the resume refuses another user and withdraws the answer, so nothing
  // can resume on it later.
  it("an answer racing the host's park is gated at the resume: another user's is refused and withdrawn", async () => {
    const parked = await parkedAssistant({ lockHeld: true, live: true });

    await expect(answerAs(parked, await seedUser())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(await stateOf(parked)).toMatchObject({
      status: "NeedsInputIdle",
      resumeRequestedAt: null,
      response: null,
      resumePlacements: 0,
    });
  });

  it("another user's identical answer racing the park is refused without withdrawing the one already stored", async () => {
    const parked = await parkedAssistant({
      lockHeld: true,
      live: true,
      answered: true,
    });

    await expect(answerAs(parked, await seedUser())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(await stateOf(parked)).toMatchObject({
      status: "NeedsInputIdle",
      response: { optionId: "allow" },
      resumePlacements: 0,
    });
  });

  it("a run another admission already moved is left to it: the gate stays out of the claim race", async () => {
    const parked = await parkedAssistant({
      lockHeld: true,
      live: true,
      answered: true,
    });

    // Before the host answers, another admission resumed the run.
    parked.fake.onCall("deliverInput", async () => {
      await db
        .update(schema.runs)
        .set({ status: "Running" })
        .where(eq(schema.runs.id, parked.runId));
    });
    const res = await answerAs(parked, await seedUser());

    expect(res.status).toBe(202);
    expect(await stateOf(parked)).toMatchObject({
      status: "Running",
      response: { optionId: "allow" },
    });
  });

  it("the launching user holding the lock is admitted: the claim mints the resume placement", async () => {
    const parked = await parkedAssistant({ lockHeld: true });
    const res = await answerAs(parked, parked.ownerId);

    expect(res.status).toBe(202);
    const state = await stateOf(parked);

    expect(state.response).toMatchObject({ optionId: "allow" });
    expect(state.resumePlacements).toBe(1);
    // The re-prompt is detached from the 202: let it settle before the
    // database closes under it.
    const deadline = Date.now() + 30_000;

    for (;;) {
      const [scratch] = await db
        .select({ dialogStatus: schema.scratchRuns.dialogStatus })
        .from(schema.scratchRuns)
        .where(eq(schema.scratchRuns.runId, parked.runId));

      if (scratch.dialogStatus !== "Running") break;
      if (Date.now() > deadline)
        throw new Error("the detached re-prompt never settled");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });

  it("the freed-slot gate leaves a queued assistant resume queued while its edit lock is not held", async () => {
    const parked = await parkedAssistant({ lockHeld: false, answered: true });

    await promoteNextPending({ db: db as never, pool: "flow" });

    expect(await stateOf(parked)).toMatchObject({
      status: "NeedsInputIdle",
      resumeRequestedAt: expect.any(Date),
      resumePlacements: 0,
    });
  });

  // The gate reads a `limit(cap)` window in FIFO order. Runs only their owner
  // can unblock must not hold it: each yields its place when passed over.
  it("runs whose lock lapsed never starve a resumable run out of the gate's window", async () => {
    const previousCap = process.env.MAISTER_MAX_CONCURRENT_ASSISTANTS;

    process.env.MAISTER_MAX_CONCURRENT_ASSISTANTS = "50";
    try {
      const waiting = await parkedAssistant({ lockHeld: true, answered: true });
      const older = new Date("2000-01-01T00:00:00Z");

      for (let i = 0; i < capForPool("flow"); i++)
        await parkedAssistant({
          lockHeld: false,
          answered: true,
          queuedAt: older,
          fake: waiting.fake,
        });
      const dispatched: string[] = [];
      const pass = () =>
        promoteNextPending({
          db: db as never,
          pool: "flow",
          resumeScratchRun: (id) => {
            dispatched.push(id);
          },
        });

      await pass();
      expect(dispatched).toEqual([]);
      await pass();
      expect(dispatched).toEqual([waiting.runId]);
    } finally {
      if (previousCap === undefined)
        delete process.env.MAISTER_MAX_CONCURRENT_ASSISTANTS;
      else process.env.MAISTER_MAX_CONCURRENT_ASSISTANTS = previousCap;
    }
  });
});
