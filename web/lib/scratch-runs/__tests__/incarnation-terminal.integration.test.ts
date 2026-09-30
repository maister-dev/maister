import type { Db } from "@/lib/execution-host/db";
import type { SupervisorEvent } from "@/lib/execution-host";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { applyScratchSessionTerminal } from "@/lib/scratch-runs/events";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { startMainPostgresTestDb } from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let db: StartedPostgresTestDb["db"];
const userId = "s3-incarnation-user";

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "r9_s3_incarnation",
  });
  db = database.db;
  await db.insert(schema.users).values({ id: userId, email: "s3@test" });
}, 180_000);

afterAll(async () => database?.stop());

type Turn = {
  runId: string;
  sessionId: string;
  oldHostSessionId: string;
  currentHostSessionId: string;
  hostId: string;
};
type TerminalEvent = Extract<
  SupervisorEvent,
  { type: "session.exited" | "session.crashed" }
>;
type TerminalInput =
  | Omit<Extract<TerminalEvent, { type: "session.exited" }>, "sessionId">
  | Omit<Extract<TerminalEvent, { type: "session.crashed" }>, "sessionId">;

async function seedTurn(
  status: "Running" | "NeedsInput" | "Review" = "Running",
  currentState: "active" | "exited" | "crashed" = "active",
): Promise<Turn> {
  const runId = randomUUID();
  const projectId = randomUUID();
  const sessionId = randomUUID();
  const oldHostSessionId = randomUUID();
  const currentHostSessionId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `s3-${runId}`,
    name: "S3",
    repoPath: `/tmp/s3-${runId}`,
    maisterYamlPath: "/tmp/maister.yaml",
    taskKey: `S${runId.slice(0, 7)}`.toUpperCase(),
  });
  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    runKind: "scratch",
    createdByUserId: userId,
    flowVersion: "scratch",
    status,
  });
  await db.insert(schema.scratchRuns).values({
    runId,
    projectId,
    initialPrompt: "S3",
    createdByUserId: userId,
    baseBranch: "main",
    baseCommit: "abc",
    dialogStatus: status,
  });
  const { hostId, assignment } = await fakeExecutionHosts(db, { runId });

  if (!assignment) throw new Error("S3 requires an execution assignment");
  await db.insert(schema.runSessions).values({
    id: sessionId,
    runId,
    sessionName: "default",
    executionAssignmentId: assignment.id,
    hostSessionId: currentHostSessionId,
    acpSessionId: "same-resumed-acp-handle",
  });
  await db.insert(schema.runSessionIncarnations).values(
    [oldHostSessionId, currentHostSessionId].map((hostSessionId) => ({
      id: randomUUID(),
      runSessionId: sessionId,
      runId,
      executionAssignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
      executionHostId: hostId,
      hostSessionId,
      acpSessionId: "same-resumed-acp-handle",
      state: hostSessionId === oldHostSessionId ? "exited" : currentState,
      origin: "native" as const,
    })),
  );
  await db.insert(schema.hitlRequests).values({
    id: randomUUID(),
    runId,
    stepId: "scratch",
    kind: "permission",
    prompt: "Approve?",
    schema: {
      requestId: "permission",
      supervisorSessionId: currentHostSessionId,
    },
    response: { optionId: "allow" },
  });

  return { runId, sessionId, oldHostSessionId, currentHostSessionId, hostId };
}

async function state(runId: string) {
  const [run] = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));
  const [scratch] = await db
    .select()
    .from(schema.scratchRuns)
    .where(eq(schema.scratchRuns.runId, runId));
  const permissions = await db
    .select()
    .from(schema.hitlRequests)
    .where(eq(schema.hitlRequests.runId, runId));
  const events = await db
    .select()
    .from(schema.domainEvents)
    .where(eq(schema.domainEvents.runId, runId));
  const webhooks = await db
    .select()
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.runId, runId));

  return {
    run: run?.status,
    dialog: scratch?.dialogStatus,
    permissions,
    events,
    webhooks,
  };
}

async function apply(
  turn: Turn,
  hostSessionId: string,
  event: TerminalInput,
): Promise<void> {
  await applyScratchSessionTerminal({
    db: db as unknown as Db,
    runId: turn.runId,
    executionHostId: turn.hostId,
    hostSessionId,
    event: { ...event, sessionId: hostSessionId },
  });
}

describe("S3 already-read terminal consumer incarnation ownership", () => {
  it.each(["session.exited", "session.crashed"] as const)(
    "ignores stale %s with the same ACP handle and assignment as the Running successor",
    async (type) => {
      const turn = await seedTurn();
      const before = await state(turn.runId);

      await apply(
        turn,
        turn.oldHostSessionId,
        type === "session.exited"
          ? { type, monotonicId: 12, exitCode: 0, reason: "checkpoint" }
          : { type, monotonicId: 12, exitCode: null, signal: "SIGKILL" },
      );
      expect(await state(turn.runId)).toEqual(before);
    },
  );

  it("does not park a successor's permission when the old checkpoint exit was already read", async () => {
    const turn = await seedTurn("NeedsInput");
    const before = await state(turn.runId);

    await apply(turn, turn.oldHostSessionId, {
      type: "session.exited",
      monotonicId: 12,
      exitCode: 0,
      reason: "checkpoint",
    });
    expect(await state(turn.runId)).toEqual(before);
  });

  it("reads the successor binding after waiting for its run lock", async () => {
    const turn = await seedTurn();

    await db
      .update(schema.runSessions)
      .set({ hostSessionId: turn.oldHostSessionId })
      .where(eq(schema.runSessions.id, turn.sessionId));
    const blocker = await database.pool.connect();
    let applying: Promise<void> | undefined;

    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM runs WHERE id=$1 FOR UPDATE", [
        turn.runId,
      ]);
      const pid = (
        await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]!.pid;

      applying = apply(turn, turn.oldHostSessionId, {
        type: "session.exited",
        monotonicId: 12,
        exitCode: 0,
      });
      await expect
        .poll(
          async () =>
            (
              await database.pool.query<{ count: number }>(
                "SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
                [pid],
              )
            ).rows[0]!.count,
        )
        .toBeGreaterThan(0);
      await blocker.query(
        "UPDATE run_sessions SET host_session_id=$1 WHERE id=$2",
        [turn.currentHostSessionId, turn.sessionId],
      );
      await blocker.query("COMMIT");
      await applying;
      expect(await state(turn.runId)).toMatchObject({
        run: "Running",
        dialog: "Running",
        events: [],
        webhooks: [],
      });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await applying;
    }
  });

  it("applies the current exit even after canonical ingest has ended its incarnation", async () => {
    const turn = await seedTurn("Running", "exited");

    await apply(turn, turn.currentHostSessionId, {
      type: "session.exited",
      monotonicId: 12,
      exitCode: 0,
    });
    expect(await state(turn.runId)).toMatchObject({
      run: "Running",
      dialog: "WaitingForUser",
      events: [],
      webhooks: [],
    });
  });

  it("applies a current ended crash once and closes its stored permission answer", async () => {
    const turn = await seedTurn("Running", "crashed");
    const event: Omit<
      Extract<SupervisorEvent, { type: "session.crashed" }>,
      "sessionId"
    > = {
      type: "session.crashed",
      monotonicId: 12,
      exitCode: null,
      signal: "SIGKILL",
    };

    await apply(turn, turn.currentHostSessionId, event);
    const first = await state(turn.runId);

    expect(first).toMatchObject({ run: "Crashed", dialog: "Crashed" });
    expect(first.permissions[0]?.respondedAt).toBeInstanceOf(Date);
    expect(first.permissions[0]?.response).toMatchObject({
      optionId: "allow",
      _closed: { reason: "session_ended" },
    });
    expect(first.events).toHaveLength(1);
    expect(first.webhooks).toHaveLength(1);
    await apply(turn, turn.currentHostSessionId, event);
    expect(await state(turn.runId)).toEqual(first);
  });

  it("keeps a current checkpoint's live permission park contract", async () => {
    const turn = await seedTurn("NeedsInput", "exited");

    await apply(turn, turn.currentHostSessionId, {
      type: "session.exited",
      monotonicId: 12,
      exitCode: 0,
      reason: "checkpoint",
    });
    const after = await state(turn.runId);

    expect(after).toMatchObject({
      run: "NeedsInputIdle",
      dialog: "NeedsInput",
      events: [],
      webhooks: [],
    });
    expect(after.permissions[0]?.respondedAt).toBeNull();
  });

  it("does not resurrect a stopped dialog on its current session's own exit", async () => {
    const turn = await seedTurn("Review", "exited");
    const before = await state(turn.runId);

    await apply(turn, turn.currentHostSessionId, {
      type: "session.exited",
      monotonicId: 12,
      exitCode: 0,
    });
    expect(await state(turn.runId)).toEqual(before);
  });
});
