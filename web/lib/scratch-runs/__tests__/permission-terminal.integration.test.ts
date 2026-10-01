import type { SupervisorEvent } from "@/lib/execution-host";
import type { ScratchExecution } from "@/lib/scratch-runs/events";
import type { Db } from "@/lib/execution-host/db";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { sendScratchPromptAndProjectEvents } from "@/lib/scratch-runs/events";
import { applyScratchPromptCompletion } from "@/lib/scratch-runs/turn-completion";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { startMainPostgresTestDb } from "@/test-support/pg-container";

const userId = "scratch-permission-terminal-user";
let actorId = userId;
let database: StartedPostgresTestDb;
let db: StartedPostgresTestDb["db"];
let root: string;
let stop: typeof import("@/app/api/scratch-runs/[runId]/stop/route").POST;
let discard: typeof import("@/app/api/scratch-runs/[runId]/discard/route").POST;
let respond: typeof import("@/app/api/runs/[runId]/hitl/[hitlRequestId]/respond/route").POST;
let recordDrop: typeof import("@/lib/workbench-lifecycle/service").recordDrop;

// The consumer and DB effects are real; prompt admission/completion only bound this
// already-read event control without admitting another turn.
vi.mock("@/lib/execution-host/prompt-incarnation", () => ({
  waitForPromptIncarnation: async () => undefined,
}));
vi.mock("@/lib/scratch-runs/prompt-owner", async (original) => ({
  ...(await original<typeof import("@/lib/scratch-runs/prompt-owner")>()),
  waitForScratchPrompt: async () => undefined,
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({ id: actorId, role: "admin" })),
  requireProjectAction: vi.fn(async (projectId: string) => {
    if (!projectId) throw new Error("project authorization requires a project");
  }),
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "r9_s2_permissions",
  });
  db = database.db;
  root = await mkdtemp(path.join(tmpdir(), "r9-s2-package-"));
  await db.insert(schema.users).values({ id: userId, email: "r9-s2@test" });
  await fakeExecutionHosts(db);
  ({ POST: stop } = await import("@/app/api/scratch-runs/[runId]/stop/route"));
  ({ POST: discard } = await import(
    "@/app/api/scratch-runs/[runId]/discard/route"
  ));
  ({ POST: respond } = await import(
    "@/app/api/runs/[runId]/hitl/[hitlRequestId]/respond/route"
  ));
  ({ recordDrop } = await import("@/lib/workbench-lifecycle/service"));
}, 180_000);

afterAll(async () => {
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function seedTurn(
  input: {
    packageRun?: boolean;
    workspace?: boolean;
    status?: "NeedsInputIdle" | "Review" | "Crashed" | "Done" | "Abandoned";
  } = {},
): Promise<{ runId: string; workspaceId: string | null; answeredId: string }> {
  const runId = randomUUID();
  const projectId = input.packageRun ? null : randomUUID();
  const localPackageId = input.packageRun ? randomUUID() : null;
  const status = input.status ?? "NeedsInputIdle";

  if (projectId)
    await db.insert(schema.projects).values({
      id: projectId,
      slug: `s2-${runId}`,
      name: "S2",
      repoPath: path.join(root, runId),
      maisterYamlPath: path.join(root, "maister.yaml"),
      taskKey: `S${runId.slice(0, 7)}`.toUpperCase(),
    });
  if (localPackageId)
    await db.insert(schema.localPackages).values({
      id: localPackageId,
      slug: `s2-${runId}`,
      name: "S2",
      workingDir: root,
      status: "active",
      createdBy: userId,
    });
  await db.insert(schema.runs).values({
    id: runId,
    runKind: "scratch",
    projectId,
    localPackageId,
    createdByUserId: userId,
    flowVersion: "scratch",
    status,
  });
  await db.insert(schema.scratchRuns).values({
    runId,
    projectId,
    localPackageId,
    createdByUserId: userId,
    initialPrompt: "S2",
    baseBranch: "main",
    baseCommit: "abc",
    dialogStatus: status === "NeedsInputIdle" ? "NeedsInput" : status,
  });
  const workspaceId = input.workspace ? randomUUID() : null;

  if (workspaceId)
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      runId,
      projectId: projectId!,
      branch: `scratch/${runId}`,
      worktreePath: path.join(root, runId),
      parentRepoPath: root,
    });
  const answeredId = await seedPermissions(runId);

  return { runId, workspaceId, answeredId };
}

async function seedPermissions(runId: string): Promise<string> {
  const answeredId = randomUUID();

  await db.insert(schema.hitlRequests).values(
    [false, true].map((answered) => ({
      id: answered ? answeredId : randomUUID(),
      runId,
      stepId: "scratch",
      kind: "permission" as const,
      prompt: "Approve?",
      schema: {
        requestId: "parked-request",
        supervisorSessionId: `parked-${runId}`,
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        toolCall: { toolCallId: "parked-tool", title: "Read", kind: "read" },
      },
      response: answered ? { optionId: "allow" } : null,
    })),
  );

  return answeredId;
}

async function assertClosed(runId: string): Promise<void> {
  const rows = await db
    .select()
    .from(schema.hitlRequests)
    .where(eq(schema.hitlRequests.runId, runId));

  expect(rows.length).toBeGreaterThanOrEqual(2);
  for (const row of rows) {
    expect(row.respondedAt).toBeInstanceOf(Date);
    expect(row.supersededAt).toBeNull();
    if (row.response !== null)
      expect(row.response).toMatchObject({
        optionId: "allow",
        _closed: { reason: "session_ended" },
      });
  }
}

async function invoke(action: typeof stop, runId: string): Promise<Response> {
  return action(new Request("http://localhost/scratch", { method: "POST" }), {
    params: Promise.resolve({ runId }),
  });
}

async function retryAnswer(runId: string, answeredId: string): Promise<void> {
  const response = await respond(
    new NextRequest("http://localhost/hitl", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ optionId: "allow" }),
    }),
    { params: Promise.resolve({ runId, hitlRequestId: answeredId }) },
  );

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    details: { reason: "session_ended" },
  });
  const commands = await db
    .select()
    .from(schema.executionCommands)
    .where(eq(schema.executionCommands.runId, runId));

  expect(commands.filter((row) => row.kind === "session.input")).toHaveLength(
    0,
  );
}

async function permissionConsumer(runId: string) {
  const { hosts, assignment, hostId } = await fakeExecutionHosts(db, { runId });

  if (!assignment) throw new Error("permission consumer requires assignment");
  const execution = await hosts.executionFor(runId);
  const sessionId = randomUUID();
  const logicalSessionId = randomUUID();

  await db.insert(schema.runSessions).values({
    id: logicalSessionId,
    runId,
    sessionName: "default",
    executionAssignmentId: assignment.id,
    hostSessionId: sessionId,
    acpSessionId: "shared-resume-handle",
  });
  await db.insert(schema.runSessionIncarnations).values({
    id: randomUUID(),
    runSessionId: logicalSessionId,
    runId,
    executionAssignmentId: assignment.id,
    assignmentEpoch: assignment.epoch,
    executionHostId: hostId,
    hostSessionId: sessionId,
    acpSessionId: "shared-resume-handle",
    state: "active",
    origin: "native",
  });
  const event: Extract<
    SupervisorEvent,
    { type: "session.permission_request" }
  > = {
    type: "session.permission_request",
    sessionId,
    monotonicId: 7,
    requestId: `late-${runId}`,
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    toolCall: { toolCallId: "new-tool", title: "Read", kind: "read" },
  };
  const consume = async (databaseForConsumer = db): Promise<void> => {
    const processed = Promise.withResolvers<void>();
    const controlled: ScratchExecution = {
      client: {
        ...execution.client,
        prompt: async () => {
          await processed.promise;

          return { commandId: randomUUID() };
        },
      },
      admin: {
        ...execution.admin,
        streamSession: async function* () {
          try {
            yield event;
          } finally {
            processed.resolve();
          }
        },
      },
    };

    await sendScratchPromptAndProjectEvents({
      db: databaseForConsumer,
      runId,
      sessionId,
      stepId: "scratch",
      prompt: "already running",
      owner: { variant: "initial" },
      execution: controlled,
    });
  };

  return { consume, sessionId, logicalSessionId, assignment, hostId, event };
}

describe("S2 terminal scratch permission ownership", () => {
  it.each(["Stop", "Discard"] as const)(
    "a late permission after %s cannot reopen its committed terminal state",
    async (action) => {
      const { runId } = await seedTurn();
      const consumer = await permissionConsumer(runId);

      expect(
        (await invoke(action === "Stop" ? stop : discard, runId)).status,
      ).toBe(200);
      await consumer.consume();
      const state = await database.pool.query(
        "SELECT r.status,s.dialog_status,(SELECT count(*)::int FROM hitl_requests WHERE run_id=r.id AND responded_at IS NULL) AS open FROM runs r JOIN scratch_runs s ON s.run_id=r.id WHERE r.id=$1",
        [runId],
      );

      expect(state.rows[0]).toEqual({
        status: "Abandoned",
        dialog_status: "Abandoned",
        open: 0,
      });
    },
  );

  it("rechecks ownership when Stop commits between answer lookup and new permission persistence", async () => {
    const { runId } = await seedTurn({ workspace: true });
    const consumer = await permissionConsumer(runId);

    await db
      .delete(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, runId));
    await db
      .update(schema.runs)
      .set({ status: "Running" })
      .where(eq(schema.runs.id, runId));
    await db
      .update(schema.scratchRuns)
      .set({ dialogStatus: "Running" })
      .where(eq(schema.scratchRuns.runId, runId));
    let transactions = 0;
    const interleaved = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction")
          return Reflect.get(target, property, receiver);

        return async (...args: Parameters<typeof db.transaction>) => {
          const result = await target.transaction(...args);

          transactions += 1;
          if (transactions === 1)
            expect((await invoke(stop, runId)).status).toBe(200);

          return result;
        };
      },
    });

    await consumer.consume(interleaved);
    const state = await database.pool.query(
      "SELECT r.status,s.dialog_status,(SELECT count(*)::int FROM hitl_requests WHERE run_id=r.id AND responded_at IS NULL) AS open FROM runs r JOIN scratch_runs s ON s.run_id=r.id WHERE r.id=$1",
      [runId],
    );

    expect(transactions).toBe(2);
    expect(state.rows[0]).toEqual({
      status: "Review",
      dialog_status: "Review",
      open: 0,
    });
  });

  it("ignores an old incarnation's permission without consuming the successor's stored answer", async () => {
    const { runId } = await seedTurn();
    const consumer = await permissionConsumer(runId);
    const successorId = randomUUID();

    await db
      .update(schema.runSessionIncarnations)
      .set({ state: "exited" })
      .where(
        eq(schema.runSessionIncarnations.hostSessionId, consumer.sessionId),
      );
    await db.insert(schema.runSessionIncarnations).values({
      id: randomUUID(),
      runSessionId: consumer.logicalSessionId,
      runId,
      executionAssignmentId: consumer.assignment.id,
      assignmentEpoch: consumer.assignment.epoch,
      executionHostId: consumer.hostId,
      hostSessionId: successorId,
      acpSessionId: "shared-resume-handle",
      state: "active",
      origin: "native",
    });
    await db
      .update(schema.runSessions)
      .set({ hostSessionId: successorId })
      .where(eq(schema.runSessions.id, consumer.logicalSessionId));
    await db
      .update(schema.runs)
      .set({ status: "Running" })
      .where(eq(schema.runs.id, runId));
    await db
      .update(schema.scratchRuns)
      .set({ dialogStatus: "Running" })
      .where(eq(schema.scratchRuns.runId, runId));
    const before = await db
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, runId));

    await consumer.consume();
    expect(
      await db
        .select()
        .from(schema.hitlRequests)
        .where(eq(schema.hitlRequests.runId, runId)),
    ).toEqual(before);
    const [scratch] = await db
      .select()
      .from(schema.scratchRuns)
      .where(eq(schema.scratchRuns.runId, runId));

    expect(scratch.dialogStatus).toBe("Running");
  });

  it("accepts and deduplicates the current incarnation's live permission", async () => {
    const { runId } = await seedTurn();
    const consumer = await permissionConsumer(runId);

    await db
      .delete(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, runId));
    await db
      .update(schema.runs)
      .set({ status: "Running" })
      .where(eq(schema.runs.id, runId));
    await db
      .update(schema.scratchRuns)
      .set({ dialogStatus: "Running" })
      .where(eq(schema.scratchRuns.runId, runId));
    await consumer.consume();
    await consumer.consume();
    const rows = await db
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, runId));
    const [scratch] = await db
      .select()
      .from(schema.scratchRuns)
      .where(eq(schema.scratchRuns.runId, runId));

    expect(rows).toHaveLength(1);
    expect(rows[0].schema).toMatchObject({
      requestId: consumer.event.requestId,
      supervisorSessionId: consumer.sessionId,
    });
    expect(scratch.dialogStatus).toBe("NeedsInput");
  });

  it("terminal Stop replay does not close successor permissions when a competing status transaction wins its run lock", async () => {
    const { runId } = await seedTurn({ status: "Crashed" });
    const blocker = await database.pool.connect();
    let stopping: Promise<Response> | undefined;

    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM runs WHERE id=$1 FOR UPDATE", [
        runId,
      ]);
      const pid = (
        await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]!.pid;

      stopping = invoke(stop, runId);
      await expect
        .poll(async () => {
          const waiting = await database.pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
            [pid],
          );

          return waiting.rows[0]!.count;
        })
        .toBeGreaterThan(0);
      // Competing owner commits the successor status while replay waits on
      // runs. This is a DB interleaving control, not a claimed host respawn.
      await blocker.query("UPDATE runs SET status='Running' WHERE id=$1", [
        runId,
      ]);
      await blocker.query(
        "UPDATE scratch_runs SET dialog_status='Running' WHERE run_id=$1",
        [runId],
      );
      await blocker.query("COMMIT");
      expect((await stopping).status).toBe(200);
      const state = await database.pool.query(
        "SELECT r.status,s.dialog_status,(SELECT count(*)::int FROM hitl_requests WHERE run_id=r.id AND responded_at IS NULL) AS open FROM runs r JOIN scratch_runs s ON s.run_id=r.id WHERE r.id=$1",
        [runId],
      );

      expect(state.rows[0]).toEqual({
        status: "Running",
        dialog_status: "Running",
        open: 2,
      });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await stopping;
    }
  });
  it("package Stop uses creator authorization without an edit lock and refuses another user", async () => {
    const { runId } = await seedTurn({ packageRun: true });

    actorId = "another-user";
    try {
      expect((await invoke(stop, runId)).status).toBe(403);
      const open = await database.pool.query(
        "SELECT count(*)::int AS count FROM hitl_requests WHERE run_id=$1 AND responded_at IS NULL",
        [runId],
      );

      expect(open.rows[0].count).toBe(2);
    } finally {
      actorId = userId;
    }
    expect((await invoke(stop, runId)).status).toBe(200);
    await assertClosed(runId);
  });
  it.each([true, false])(
    "Stop closes both permission kinds with workspace=%s; repeats and late completions preserve closure",
    async (workspace) => {
      const { runId, answeredId } = await seedTurn({ workspace });
      const response = await invoke(stop, runId);

      expect(response.status).toBe(200);
      await assertClosed(runId);
      await retryAnswer(runId, answeredId);
      const terminal = workspace ? "Review" : "Abandoned";

      expect(
        await db.transaction((tx) =>
          applyScratchPromptCompletion(tx as unknown as Db, runId),
        ),
      ).toBe(terminal);
      const before = await database.pool.query(
        "SELECT count(*)::int AS count FROM domain_events WHERE run_id=$1",
        [runId],
      );

      await seedPermissions(runId);
      expect((await invoke(stop, runId)).status).toBe(200);
      await assertClosed(runId);
      const after = await database.pool.query(
        "SELECT count(*)::int AS count FROM domain_events WHERE run_id=$1",
        [runId],
      );

      expect(after.rows).toEqual(before.rows);
    },
  );

  it.each([false, true])(
    "Discard closes project/package permissions package=%s and repairs repeated terminal rows",
    async (packageRun) => {
      const { runId, answeredId } = await seedTurn({ packageRun });

      expect((await invoke(discard, runId)).status).toBe(200);
      await assertClosed(runId);
      await retryAnswer(runId, answeredId);
      await seedPermissions(runId);
      expect((await invoke(discard, runId)).status).toBe(200);
      await assertClosed(runId);
    },
  );

  it.each(["Done", "Abandoned"] as const)(
    "legacy %s rows close on Stop and Discard without new terminal events",
    async (status) => {
      for (const action of [stop, discard]) {
        const { runId } = await seedTurn({ status });

        expect((await invoke(action, runId)).status).toBe(200);
        await assertClosed(runId);
        const events = await database.pool.query(
          "SELECT count(*)::int AS count FROM domain_events WHERE run_id=$1",
          [runId],
        );

        expect(events.rows[0].count).toBe(0);
      }
    },
  );

  it("shared workbench Discard closes permissions in recordDrop's status transaction", async () => {
    const { runId, workspaceId } = await seedTurn({
      workspace: true,
      status: "Review",
    });
    const attemptId = randomUUID();

    await db
      .update(schema.workspaces)
      .set({
        lifecycleOperationState: "claiming",
        lifecycleOperationName: "drop",
        lifecycleOperationExpectedRunStatus: "Review",
        lifecycleOperationAttemptId: attemptId,
        lifecycleOperationLeaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(schema.workspaces.id, workspaceId!));
    await recordDrop({
      database: db as never,
      runId,
      runKind: "scratch",
      workspaceId: workspaceId!,
      attemptId,
      expectedRunStatus: "Review",
      nextRunStatus: "Abandoned",
      removedAt: new Date(),
      archivedAt: null,
      archivedBranch: null,
      archivedCommit: null,
      preservationOutcome: "not_needed",
      removalKind: "discard",
    });
    await assertClosed(runId);
  });

  it.each(["Stop", "Discard"] as const)(
    "a permission-close failure rolls back %s's status write",
    async (action) => {
      const { runId } = await seedTurn();
      const trigger = `s2_rollback_${runId.replaceAll("-", "")}`;

      await database.pool.query(
        `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id='${runId}' AND NEW.responded_at IS NOT NULL THEN RAISE EXCEPTION 'S2 closure rollback'; END IF; RETURN NEW; END $$`,
      );
      await database.pool.query(
        `CREATE TRIGGER ${trigger} BEFORE UPDATE ON hitl_requests FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
      );
      try {
        expect(
          (await invoke(action === "Stop" ? stop : discard, runId)).status,
        ).toBe(500);
        const state = await database.pool.query(
          "SELECT r.status,s.dialog_status,(SELECT count(*)::int FROM hitl_requests WHERE run_id=r.id AND responded_at IS NULL) AS open FROM runs r JOIN scratch_runs s ON s.run_id=r.id WHERE r.id=$1",
          [runId],
        );

        expect(state.rows[0]).toEqual({
          status: "NeedsInputIdle",
          dialog_status: "NeedsInput",
          open: 2,
        });
      } finally {
        await database.pool.query(`DROP TRIGGER ${trigger} ON hitl_requests`);
        await database.pool.query(`DROP FUNCTION ${trigger}()`);
      }
    },
  );
});
