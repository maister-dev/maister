// ADR-166 Stage A (T4.4, Q1–Q3): a project scratch run's placement lifecycle
// against a real Postgres + a real git worktree, on a fake local execution
// host:
//   Q1 the launch mints the `launch` generation, adopts the worktree ONCE and
//      creates the session through the bound client (handle-form payload);
//      `scratch_runs.supervisor_session_id` equals the default run_session's
//      `host_session_id` written by the create ack;
//   Q2 an interrupt is a fenced `session.cancel` command against that session;
//   Q3 the recover route mints `scratch_recover` over the crash-released
//      launch generation, resumes on the stored ACP handle, and re-uses the
//      adopted workspace handle (no second adoption);
//   Q4 a create failure after the recover claim rolls the claim back (run back
//      to Crashed, the minted generation released `scratch_recover_rollback`);
//   Q5 two concurrent recovers serialize on the status CAS: one 202, one 409,
//      exactly one new generation.

import type { ExecutionHosts } from "@/lib/execution-host";
import type { ScratchLaunchInput } from "@/lib/scratch-runs/types";

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  createFakeExecutionHost,
  definitiveUnavailableError,
  fakeExecutionHosts,
  type FakeExecutionHost,
} from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const execFileAsync = promisify(execFile);
const USER_ID = "scratch-placement-user";

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

// The real prompt-admission fence, spied so the A4 cases can force its
// timeout window (no durable incarnation yet) without faking what follows.
const admission = vi.hoisted(() => ({
  wait: null as null | ReturnType<typeof vi.fn>,
}));

vi.mock("@/lib/execution-host/prompt-incarnation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/execution-host/prompt-incarnation")
    >();

  admission.wait = vi.fn(actual.waitForPromptIncarnation);

  return { ...actual, waitForPromptIncarnation: admission.wait };
});
vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: "scratch-placement-user",
    email: "scratch@test",
    role: "admin",
  })),
  requireProjectAction: vi.fn(async () => undefined),
}));

let launchScratchRunStaged: typeof import("@/lib/scratch-runs/service").launchScratchRunStaged;
let interruptScratchRun: typeof import("@/lib/scratch-runs/service").interruptScratchRun;
let markScratchCrashed: typeof import("@/lib/scratch-runs/service").markScratchCrashed;
let sendScratchUserMessage: typeof import("@/lib/scratch-runs/service").sendScratchUserMessage;
let finalizeLifecycleOperation: typeof import("@/lib/workbench-lifecycle/service").finalizeLifecycleOperation;
let recoverRoute: typeof import("@/app/api/scratch-runs/[runId]/recover/route").POST;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schema>;
let fake: FakeExecutionHost;
let hosts: ExecutionHosts;
let tmpRoot: string;
let projectId: string;
let projectSlug: string;
const savedEnv: Record<string, string | undefined> = {};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);

  return stdout;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "scratch_placement_test",
  });
  db = testDatabase.db;
  fake = createFakeExecutionHost();
  ({ hosts } = await fakeExecutionHosts(db, { fake }));
  ({
    launchScratchRunStaged,
    interruptScratchRun,
    markScratchCrashed,
    sendScratchUserMessage,
  } = await import("@/lib/scratch-runs/service"));
  ({ finalizeLifecycleOperation } = await import(
    "@/lib/workbench-lifecycle/service"
  ));
  ({ POST: recoverRoute } = await import(
    "@/app/api/scratch-runs/[runId]/recover/route"
  ));

  tmpRoot = await mkdtemp(join(tmpdir(), "scratch-placement-"));
  for (const key of [
    "DB_URL",
    "MAISTER_RUNTIME_ROOT",
    "MAISTER_WORKTREES_ROOT",
  ]) {
    savedEnv[key] = process.env[key];
  }
  process.env.DB_URL = testDatabase.container.getConnectionUri();
  process.env.MAISTER_RUNTIME_ROOT = join(tmpRoot, "runtime");
  process.env.MAISTER_WORKTREES_ROOT = join(tmpRoot, "worktrees");

  const repo = join(tmpRoot, "repo");
  const runnerId = randomUUID();

  await execFileAsync("git", ["init", "-q", "-b", "main", repo]);
  await git(repo, "config", "user.email", "t@t.local");
  await git(repo, "config", "user.name", "T");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "base.txt"), "base\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base");

  projectId = randomUUID();
  projectSlug = `scratch-${projectId.slice(0, 8)}`;
  await db.insert(schema.users).values({
    id: USER_ID,
    email: `${USER_ID}@maister.local`,
    role: "member",
    accountStatus: "active",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(
      testPlatformRunnerRow(
        runnerId,
        "claude",
      ) as typeof schema.platformAcpRunners.$inferInsert,
    );
  await db.insert(schema.platformRuntimeSettings).values({
    id: "singleton",
    defaultRunnerId: runnerId,
  });
  await db.insert(schema.projects).values({
    id: projectId,
    slug: projectSlug,
    name: "Scratch placement",
    repoPath: repo,
    taskKey: "SCR",
  });
}, 180_000);

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await testDatabase?.stop();
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});

function launchBody(): ScratchLaunchInput {
  return {
    projectId,
    baseBranch: "main",
    prompt: "say hello",
    reasoningEffort: "high",
    attachments: [],
  };
}

async function assignmentRows(runId: string) {
  return await db
    .select({
      epoch: schema.executionAssignments.epoch,
      state: schema.executionAssignments.state,
      placementReason: schema.executionAssignments.placementReason,
      releasedReason: schema.executionAssignments.releasedReason,
      executionWorkspaceId: schema.executionAssignments.executionWorkspaceId,
    })
    .from(schema.executionAssignments)
    .where(eq(schema.executionAssignments.runId, runId))
    .orderBy(schema.executionAssignments.epoch);
}

async function scratchAndSession(runId: string) {
  const [scratch] = await db
    .select({
      dialogStatus: schema.scratchRuns.dialogStatus,
    })
    .from(schema.scratchRuns)
    .where(eq(schema.scratchRuns.runId, runId));
  const [session] = await db
    .select({
      hostSessionId: schema.runSessions.hostSessionId,
      acpSessionId: schema.runSessions.acpSessionId,
    })
    .from(schema.runSessions)
    .where(
      and(
        eq(schema.runSessions.runId, runId),
        eq(schema.runSessions.sessionName, "default"),
      ),
    );

  return { scratch, session };
}

function payloadOf(call: { envelope: { payload: unknown } | null }) {
  return call.envelope?.payload as Record<string, unknown>;
}

describe("scratch run placement (ADR-166 Q1–Q3)", () => {
  let runId: string;
  let adoptedWorkspaceId: string;
  let firstHostSessionId: string;
  let acpSessionId: string;

  it("Q1: the launch mints `launch`, adopts once, creates through the bound client", async () => {
    const gen = launchScratchRunStaged(
      { body: launchBody(), userId: USER_ID },
      { executionHosts: hosts },
    );
    const stages: string[] = [];
    let step = await gen.next();

    while (!step.done) {
      stages.push((step.value as { stage: string }).stage);
      step = await gen.next();
    }
    runId = step.value.runId;

    expect(stages).toEqual(
      expect.arrayContaining([
        "precondition",
        "worktree_created",
        "materializing",
        "spawning",
        "session_ready",
      ]),
    );

    const adopts = fake.callsOf("adoptWorkspace");
    const creates = fake.callsOf("createSession");

    expect(adopts).toHaveLength(1);
    expect(payloadOf(adopts[0])).toMatchObject({
      kind: "git_worktree",
      runId,
      projectSlug,
    });
    expect(
      String(payloadOf(adopts[0]).path).startsWith(
        process.env.MAISTER_WORKTREES_ROOT as string,
      ),
    ).toBe(true);
    adoptedWorkspaceId = fake.receipts.get(adopts[0].envelope!.command.id)?.body
      .executionWorkspaceId as string;
    expect(typeof adoptedWorkspaceId).toBe("string");

    expect(creates).toHaveLength(1);
    expect(payloadOf(creates[0])).toMatchObject({
      executionWorkspaceId: adoptedWorkspaceId,
      stepId: "dialog",
    });
    // Handle-form wire: no path-bearing fields on the session create.
    expect(payloadOf(creates[0])).not.toHaveProperty("worktreePath");
    expect(payloadOf(creates[0])).not.toHaveProperty("confineRoot");
    expect(creates[0].envelope?.fence).toMatchObject({
      runId,
      assignmentEpoch: 1,
    });

    const { scratch, session } = await scratchAndSession(runId);

    firstHostSessionId = session.hostSessionId as string;
    acpSessionId = session.acpSessionId as string;
    expect(typeof firstHostSessionId).toBe("string");
    expect(session.hostSessionId).toBe(firstHostSessionId);
    expect(fake.sessions.get(firstHostSessionId)?.acpSessionId).toBe(
      acpSessionId,
    );
    expect(scratch.dialogStatus).toBe("WaitingForUser");

    const prompts = fake.callsOf("sendPrompt");

    expect(prompts).toHaveLength(1);
    expect(prompts[0].args[0]).toBe(firstHostSessionId);
    expect(prompts[0].envelope?.fence).toMatchObject({ assignmentEpoch: 1 });

    expect(await assignmentRows(runId)).toEqual([
      {
        epoch: 1,
        state: "active",
        placementReason: "launch",
        releasedReason: null,
        executionWorkspaceId: adoptedWorkspaceId,
      },
    ]);
  }, 60_000);

  it("Q2: an interrupt is a fenced `session.cancel` against the live session", async () => {
    const result = await interruptScratchRun(runId, {
      db,
      executionHosts: hosts,
    });

    expect(result.runId).toBe(runId);
    expect(fake.callsOf("cancelPrompt").map((call) => call.args[0])).toEqual([
      firstHostSessionId,
    ]);

    const cancels = await db
      .select({
        kind: schema.executionCommands.kind,
        state: schema.executionCommands.state,
        assignmentEpoch: schema.executionCommands.assignmentEpoch,
        targetSessionId: schema.executionCommands.targetSessionId,
      })
      .from(schema.executionCommands)
      .where(
        and(
          eq(schema.executionCommands.runId, runId),
          eq(schema.executionCommands.kind, "session.cancel"),
        ),
      );

    expect(cancels).toEqual([
      {
        kind: "session.cancel",
        state: "succeeded",
        assignmentEpoch: 1,
        targetSessionId: firstHostSessionId,
      },
    ]);
  }, 60_000);

  it("Q3: the recover route mints `scratch_recover`, resumes on the ACP handle, re-uses the adopted workspace", async () => {
    // The host lost the session (restart); the sweeper crashes the run and
    // releases its launch generation.
    fake.sessions.delete(firstHostSessionId);
    await markScratchCrashed({
      db,
      runId,
      err: new Error("supervisor restart"),
    });

    expect(await assignmentRows(runId)).toEqual([
      expect.objectContaining({
        epoch: 1,
        state: "released",
        releasedReason: "crashed",
      }),
    ]);

    const response = await recoverRoute(
      new NextRequest(`http://localhost/api/scratch-runs/${runId}/recover`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "continue" }),
      }),
      { params: Promise.resolve({ runId }) },
    );

    await expect(response.clone().json()).resolves.toMatchObject({
      runId,
      action: "recover",
    });
    expect(response.status).toBe(202);

    const creates = fake.callsOf("createSession");

    expect(creates).toHaveLength(2);
    expect(payloadOf(creates[1])).toMatchObject({
      resumeSessionId: acpSessionId,
      executionWorkspaceId: adoptedWorkspaceId,
    });
    expect(creates[1].envelope?.fence).toMatchObject({
      runId,
      assignmentEpoch: 2,
    });
    // The handle is copied forward across generations: no second adoption.
    expect(fake.callsOf("adoptWorkspace")).toHaveLength(1);

    // S2.9: the recovery turn is owned by its own recover generation, so its
    // WaitingForUser transition is applied from that turn's durable command.
    const [recoverCommand] = await db
      .select({
        ownerKind: schema.executionCommands.ownerKind,
        ownerRef: schema.executionCommands.ownerRef,
        applicationState: schema.executionCommands.applicationState,
      })
      .from(schema.executionCommands)
      .where(
        and(
          eq(schema.executionCommands.runId, runId),
          eq(schema.executionCommands.kind, "session.prompt"),
          eq(schema.executionCommands.assignmentEpoch, 2),
        ),
      );

    expect(recoverCommand?.ownerKind).toBe("scratch_message");
    expect(recoverCommand?.ownerRef).toMatchObject({
      variant: "recovery",
      scratchRunId: runId,
      promptOrdinal: 0,
    });
    expect(recoverCommand?.applicationState).toBe("applied");

    expect(await assignmentRows(runId)).toEqual([
      expect.objectContaining({ epoch: 1, state: "released" }),
      {
        epoch: 2,
        state: "active",
        placementReason: "scratch_recover",
        releasedReason: null,
        executionWorkspaceId: adoptedWorkspaceId,
      },
    ]);

    const { scratch, session } = await scratchAndSession(runId);

    expect(session.hostSessionId).not.toBe(firstHostSessionId);
    expect(session.hostSessionId).toBeTruthy();
    expect(scratch.dialogStatus).toBe("WaitingForUser");
  }, 60_000);

  async function recover(): Promise<Response> {
    return recoverRoute(
      new NextRequest(`http://localhost/api/scratch-runs/${runId}/recover`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "continue" }),
      }),
      { params: Promise.resolve({ runId }) },
    );
  }

  it("Q4: a create failure after the claim rolls it back — run Crashed again, generation released", async () => {
    const { session: before } = await scratchAndSession(runId);

    fake.sessions.delete(before.hostSessionId as string);
    await markScratchCrashed({
      db,
      runId,
      err: new Error("supervisor restart"),
    });
    fake.failOnce("createSession", definitiveUnavailableError());

    const response = await recover();

    expect(response.status).toBe(503);

    const [run] = await db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));

    expect(run.status).toBe("Crashed");
    expect((await assignmentRows(runId)).at(-1)).toMatchObject({
      epoch: 3,
      state: "released",
      placementReason: "scratch_recover",
      releasedReason: "scratch_recover_rollback",
    });
    // The logical session pointer is exactly what the crash left.
    const { scratch, session } = await scratchAndSession(runId);

    expect(session.hostSessionId).toBe(before.hostSessionId);
    expect(scratch.dialogStatus).toBe("Crashed");
  }, 60_000);

  it("Q5: two concurrent recovers → one 202, one 409, exactly one new generation", async () => {
    const before = (await assignmentRows(runId)).length;
    const [a, b] = await Promise.all([recover(), recover()]);
    const statuses = [a.status, b.status].sort();

    expect(statuses).toEqual([202, 409]);
    const loser = a.status === 409 ? a : b;

    await expect(loser.json()).resolves.toMatchObject({ code: "CONFLICT" });

    const rows = await assignmentRows(runId);

    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({
      state: "active",
      placementReason: "scratch_recover",
    });
    expect(
      (
        await db
          .select({ status: schema.runs.status })
          .from(schema.runs)
          .where(eq(schema.runs.id, runId))
      )[0].status,
    ).not.toBe("Crashed");
  }, 60_000);

  // ADR-181 C26, the recover direction: a live workbench claim (here a publish
  // under its lease) owns the worktree, so resuming an agent into it is refused
  // before the run moves or a generation is minted.
  it("Q6: a live workbench claim owns the worktree — 409 busy, still Crashed, no new generation", async () => {
    const { session: before } = await scratchAndSession(runId);

    fake.sessions.delete(before.hostSessionId as string);
    await markScratchCrashed({
      db,
      runId,
      err: new Error("supervisor restart"),
    });

    const generations = (await assignmentRows(runId)).length;
    const creates = fake.callsOf("createSession").length;
    const claimedAt = new Date();

    await db
      .update(schema.workspaces)
      .set({
        lifecycleOperationState: "claiming",
        lifecycleOperationName: "exportBranch",
        lifecycleOperationAttemptId: randomUUID(),
        lifecycleOperationExpectedRunStatus: "Crashed",
        lifecycleOperationClaimedAt: claimedAt,
        lifecycleOperationLeaseExpiresAt: new Date(
          claimedAt.getTime() + 60_000,
        ),
      })
      .where(eq(schema.workspaces.runId, runId));

    const response = await recover();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "CONFLICT",
      details: { reason: "busy" },
    });
    expect(
      (
        await db
          .select({ status: schema.runs.status })
          .from(schema.runs)
          .where(eq(schema.runs.id, runId))
      )[0].status,
    ).toBe("Crashed");
    expect(await assignmentRows(runId)).toHaveLength(generations);
    expect(fake.callsOf("createSession")).toHaveLength(creates);
  }, 60_000);

  // ADR-182: a message queued behind a turn that crashed is still the older
  // message — Recover sends it first and queues its own text behind it.
  it("Q7: messages queued before a crash are sent before the message that recovers it", async () => {
    // Q6 left the run Crashed under a live workbench claim; that operation
    // finishes and the run is recovered into an open dialog first.
    const [claimed] = await db
      .select({
        id: schema.workspaces.id,
        attemptId: schema.workspaces.lifecycleOperationAttemptId,
      })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.runId, runId));

    await finalizeLifecycleOperation({
      database: db,
      workspaceId: claimed.id,
      attemptId: claimed.attemptId as string,
      state: "done",
    });
    expect((await recover()).status).toBe(202);
    await expect
      .poll(async () => (await scratchAndSession(runId)).scratch.dialogStatus, {
        timeout: 15_000,
        interval: 25,
      })
      .toBe("WaitingForUser");
    const { session: live } = await scratchAndSession(runId);
    let finishTurn: () => void = () => {};
    const turnHeld = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });

    fake.setPromptBehavior(async () => {
      await turnHeld;

      return { stopReason: "end_turn", meta: null };
    });
    const longTurn = sendScratchUserMessage({
      runId,
      body: { content: "long task", attachments: [] },
      executionHosts: hosts,
    }).catch(() => undefined);

    await expect
      .poll(async () => (await scratchAndSession(runId)).scratch.dialogStatus, {
        timeout: 15_000,
        interval: 25,
      })
      .toBe("Running");
    const queued = await sendScratchUserMessage({
      runId,
      body: { content: "queued before the crash", attachments: [] },
      executionHosts: hosts,
    });

    expect(queued.delivery).toBe("queued");
    fake.sessions.delete(live.hostSessionId as string);
    await markScratchCrashed({
      db,
      runId,
      err: new Error("supervisor restart"),
    });
    fake.setPromptBehavior(async () => ({
      stopReason: "end_turn",
      meta: null,
    }));
    finishTurn();
    await longTurn;
    const sentBefore = fake.callsOf("sendPrompt").length;
    const response = await recoverRoute(
      new NextRequest(`http://localhost/api/scratch-runs/${runId}/recover`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "continue after the crash" }),
      }),
      { params: Promise.resolve({ runId }) },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      action: "recover",
      dialogStatus: "WaitingForUser",
      delivery: "queued",
    });
    await expect
      .poll(
        () =>
          fake
            .callsOf("sendPrompt")
            .slice(sentBefore)
            .map((call) => payloadOf(call).prompt),
        { timeout: 30_000, interval: 25 },
      )
      .toEqual(["queued before the crash", "continue after the crash"]);
    await expect
      .poll(
        async () =>
          (
            await db
              .select({
                content: schema.runMessages.content,
                delivery: schema.runMessages.delivery,
              })
              .from(schema.runMessages)
              .where(
                and(
                  eq(schema.runMessages.runId, runId),
                  eq(schema.runMessages.role, "user"),
                ),
              )
          ).filter((row) =>
            [
              "long task",
              "queued before the crash",
              "continue after the crash",
            ].includes(row.content),
          ),
        { timeout: 30_000, interval: 25 },
      )
      .toEqual([
        { content: "long task", delivery: "prompted" },
        { content: "queued before the crash", delivery: "prompted" },
        { content: "continue after the crash", delivery: "prompted" },
      ]);
    // Both turns of the recover generation settle before the test ends (the
    // crashed generation's turn is never applied — its dialog had crashed).
    const recoverEpoch = (await assignmentRows(runId)).at(-1)?.epoch;

    await expect
      .poll(
        async () =>
          (
            await db
              .select({
                applicationState: schema.executionCommands.applicationState,
              })
              .from(schema.executionCommands)
              .where(
                and(
                  eq(schema.executionCommands.runId, runId),
                  eq(schema.executionCommands.kind, "session.prompt"),
                  eq(
                    schema.executionCommands.assignmentEpoch,
                    recoverEpoch as number,
                  ),
                ),
              )
          ).map((row) => row.applicationState),
        { timeout: 30_000, interval: 25 },
      )
      .toEqual(["applied", "applied"]);
    await expect
      .poll(async () => (await scratchAndSession(runId)).scratch.dialogStatus, {
        timeout: 15_000,
        interval: 25,
      })
      .toBe("WaitingForUser");
  }, 90_000);

  // ADR-175 2026-09-26 (T1.2 RED A2): Recover is a CAS on `Crashed` for the run
  // and the dialog. A run parked by the host cap (`NeedsInputIdle`, dialog
  // `NeedsInput`) resumes from the stored answer, and a budget stop (`Failed`,
  // dialog `Crashed`) is deliberate — both are refused before any claim,
  // generation or create. On master both moved to `Running`.
  it("Q8: a host-parked NeedsInputIdle run is refused with next: respond — nothing moves", async () => {
    const { session: live } = await scratchAndSession(runId);

    fake.sessions.delete(live.hostSessionId as string);
    await db
      .update(schema.runs)
      .set({ status: "NeedsInputIdle", checkpointAt: new Date() })
      .where(eq(schema.runs.id, runId));
    await db
      .update(schema.scratchRuns)
      .set({ dialogStatus: "NeedsInput" })
      .where(eq(schema.scratchRuns.runId, runId));
    const generations = (await assignmentRows(runId)).length;
    const creates = fake.callsOf("createSession").length;

    const response = await recover();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "CONFLICT",
      details: {
        reason: "scratch_not_recoverable",
        status: "NeedsInputIdle",
        next: "respond",
      },
    });
    expect(
      (
        await db
          .select({ status: schema.runs.status })
          .from(schema.runs)
          .where(eq(schema.runs.id, runId))
      )[0].status,
    ).toBe("NeedsInputIdle");
    expect(await assignmentRows(runId)).toHaveLength(generations);
    expect(fake.callsOf("createSession")).toHaveLength(creates);
  }, 60_000);

  it("Q9: a budget-Failed run (dialog Crashed) is refused — terminal, no generation", async () => {
    await markScratchCrashed({
      db,
      runId,
      err: new Error("budget breach"),
      terminal: "failed",
    });
    const generations = (await assignmentRows(runId)).length;
    const creates = fake.callsOf("createSession").length;

    const response = await recover();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "CONFLICT",
      details: { reason: "scratch_not_recoverable", status: "Failed" },
    });
    const { scratch } = await scratchAndSession(runId);

    expect(scratch.dialogStatus).toBe("Crashed");
    expect(
      (
        await db
          .select({ status: schema.runs.status })
          .from(schema.runs)
          .where(eq(schema.runs.id, runId))
      )[0].status,
    ).toBe("Failed");
    expect(await assignmentRows(runId)).toHaveLength(generations);
    expect(fake.callsOf("createSession")).toHaveLength(creates);
  }, 60_000);
});

// ADR-182 A4 (T1.4 RED A4): the admission yield returns the failed turn's row
// to the queue, and the agent continuation worker's scratch arm sends it again
// once the settle window passes. On master a direct send's row stayed
// `prompted` (the operator had to resend it) and the launch prompt's row
// stayed NULL.
describe("scratch retryable failure keeps the row in the queue (ADR-182 A4)", () => {
  async function yieldOnce(): Promise<void> {
    const { PromptIncarnationPending } = await import(
      "@/lib/execution-host/prompt-incarnation"
    );

    admission.wait!.mockRejectedValueOnce(
      new PromptIncarnationPending({
        runId: "pending",
        assignmentId: "pending",
        hostSessionId: "pending",
      }),
    );
  }

  async function launch(): Promise<string> {
    const gen = launchScratchRunStaged(
      { body: launchBody(), userId: USER_ID },
      { executionHosts: hosts },
    );
    let step = await gen.next();

    while (!step.done) step = await gen.next();

    return step.value.runId;
  }

  async function userRows(runId: string) {
    return db
      .select({
        id: schema.runMessages.id,
        content: schema.runMessages.content,
        delivery: schema.runMessages.delivery,
        sequence: schema.runMessages.sequence,
      })
      .from(schema.runMessages)
      .where(
        and(
          eq(schema.runMessages.runId, runId),
          eq(schema.runMessages.role, "user"),
        ),
      )
      .orderBy(schema.runMessages.sequence);
  }

  async function withWorker<T>(fn: () => Promise<T>): Promise<T> {
    const { startAgentContinuationWorker } = await import(
      "@/lib/agents/continuation-worker"
    );
    const worker = startAgentContinuationWorker({
      db: db as never,
      executionHosts: hosts,
    });

    try {
      return await fn();
    } finally {
      await worker.stop();
    }
  }

  it("a direct send whose admission yields answers queued, keeps its row, and the worker re-sends it", async () => {
    const runId = await launch();

    expect((await scratchAndSession(runId)).scratch.dialogStatus).toBe(
      "WaitingForUser",
    );
    const sentBefore = fake.callsOf("sendPrompt").length;

    await yieldOnce();
    const response = await sendScratchUserMessage({
      runId,
      body: { content: "retry me", attachments: [] },
      executionHosts: hosts,
    });

    // The message is durable and queued; a transport error here would have
    // invited the operator to send it twice.
    expect(response).toMatchObject({
      delivery: "queued",
      dialogStatus: "WaitingForUser",
    });
    const [, row] = await userRows(runId);

    expect(row).toMatchObject({ content: "retry me", delivery: "queued" });
    const [scratch] = await db
      .select({ errorCode: schema.scratchRuns.errorCode })
      .from(schema.scratchRuns)
      .where(eq(schema.scratchRuns.runId, runId));

    expect(scratch.errorCode).toBe("EXECUTOR_UNAVAILABLE");
    await withWorker(async () => {
      await expect
        .poll(async () => (await userRows(runId))[1].delivery, {
          timeout: 30_000,
          interval: 100,
        })
        .toBe("prompted");
      await expect
        .poll(
          async () => (await scratchAndSession(runId)).scratch.dialogStatus,
          { timeout: 30_000, interval: 100 },
        )
        .toBe("WaitingForUser");
    });
    const resent = fake
      .callsOf("sendPrompt")
      .slice(sentBefore)
      .map((call) => payloadOf(call).prompt);

    expect(resent.at(-1)).toBe("retry me");
    // Same row, same place in the queue: no second copy of the message.
    expect((await userRows(runId)).map((message) => message.content)).toEqual([
      "say hello",
      "retry me",
    ]);
  }, 90_000);

  it("a launch prompt whose admission yields re-queues the launch row (NULL → queued) for the worker", async () => {
    await yieldOnce();
    const gen = launchScratchRunStaged(
      { body: launchBody(), userId: USER_ID },
      { executionHosts: hosts },
    );
    let runId: string | null = null;

    await expect(
      (async () => {
        let step = await gen.next();

        while (!step.done) {
          const value = step.value as { stage: string; runId?: string };

          if (value.runId) runId = value.runId;
          step = await gen.next();
        }
      })(),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
    expect(runId).not.toBeNull();
    const [launchRow] = await userRows(runId as unknown as string);

    expect(launchRow).toMatchObject({
      content: "say hello",
      delivery: "queued",
    });
    await withWorker(async () => {
      await expect
        .poll(
          async () => (await userRows(runId as unknown as string))[0].delivery,
          { timeout: 30_000, interval: 100 },
        )
        .toBe("prompted");
    });
  }, 90_000);
});
