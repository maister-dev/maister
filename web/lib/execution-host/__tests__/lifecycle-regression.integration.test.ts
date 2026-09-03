// ADR-166 T4.3 (E1–E2) — the ONLY end-to-end web test of Stage A: a flow run
// driven by the real graph runner against a REAL supervisor (mock ACP adapter
// that requests a permission on its first prompt and journals it for
// session/resume):
//   E1 permission round-trip via the ledger → keepalive checkpoint →
//      NeedsInputIdle (assignment released) → respond → resumeRun mints epoch 2,
//      the adopted handle is copied forward (no second adopt), the create
//      carries resumeSessionId → a stale epoch-1 command meets 409 FENCED →
//      CONFLICT {assignment_fenced} → the resumed driver auto-delivers the
//      stored intent and the run finishes → teardown + reconcile leave the run
//      consistent (no live session, every assignment released);
//   E2 rollbackResumedRun after a retryable spawn failure marks the fresh
//      assignment released{resume_rollback}.

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { releaseAssignmentForRun } from "@/lib/execution-host/assignments";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { setDefaultTransportForTests } from "@/lib/execution-host/default-transport";
import { buildEnvelope } from "@/lib/execution-host/ledger";
import { mintPlacement } from "@/lib/execution-host/placement";
import {
  recoverExecutionCommands,
  releaseStaleAssignments,
} from "@/lib/execution-host/recovery";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { createLocalDirectTransport } from "@/lib/execution-host/transports/local-direct";
import { runFlow } from "@/lib/flows/runner";
import { runSweepTick } from "@/lib/runs/keepalive-sweeper";
import { resumeRun } from "@/lib/runs/resume";
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
  name: "e1",
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

// A timeout names the run's durable state (run row, attempts, HITL rows,
// assignments, ledger rows, host sessions) and the supervisor child's log
// tail, so a flake is diagnosable from the failure alone.
async function diagnose(runId: string): Promise<string> {
  const rows = async (label: string, read: () => Promise<unknown>) => {
    try {
      return `${label}: ${JSON.stringify(await read())}`;
    } catch (err) {
      return `${label}: <unreadable: ${err instanceof Error ? err.message : String(err)}>`;
    }
  };
  const pick = (row: Record<string, any>, keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, row?.[k]]));

  return [
    await rows("run", async () =>
      pick(await runRow(runId), [
        "status",
        "currentStepId",
        "keepaliveUntil",
        "checkpointAt",
        "executionAssignmentId",
        "agentRunningSince",
        "endedAt",
      ]),
    ),
    await rows("node_attempts", async () =>
      (
        (await db
          .select()
          .from(schema.nodeAttempts)
          .where(eq(schema.nodeAttempts.runId, runId))) as Array<
          Record<string, any>
        >
      ).map((a) =>
        pick(a, ["nodeId", "attempt", "status", "executionAssignmentId"]),
      ),
    ),
    await rows("hitl_requests", async () =>
      (await hitlRows(runId)).map((h) =>
        pick(h, ["id", "kind", "stepId", "respondedAt", "createdAt"]),
      ),
    ),
    await rows("run_sessions", async () =>
      pick(await sessionRow(runId), [
        "sessionName",
        "hostSessionId",
        "acpSessionId",
        "executionAssignmentId",
      ]),
    ),
    await rows("execution_assignments", async () =>
      (await assignmentsOf(runId)).map((a) =>
        pick(a, ["epoch", "state", "placementReason", "releasedReason"]),
      ),
    ),
    await rows("execution_commands", async () =>
      (await commandsOf(runId)).map((c) =>
        pick(c, ["kind", "state", "assignmentEpoch", "attempts", "lastError"]),
      ),
    ),
    await rows("host sessions", async () =>
      (await hosts.local().listSessions())
        .filter((s) => s.runId === runId)
        .map((s) =>
          pick(s as Record<string, any>, [
            "sessionId",
            "status",
            "stepId",
            "assignmentEpoch",
          ]),
        ),
    ),
    `supervisor log tail:\n${await sup.logTail()}`,
  ].join("\n");
}

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  what: string,
  opts: { runId?: string; timeoutMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);

  for (;;) {
    const value = await probe();

    if (value) return value as T;
    if (Date.now() > deadline) {
      const context = opts.runId ? `\n${await diagnose(opts.runId)}` : "";

      throw new Error(`timed out waiting for ${what}${context}`);
    }
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

async function assignmentsOf(runId: string) {
  return (await db
    .select()
    .from(schema.executionAssignments)
    .where(eq(schema.executionAssignments.runId, runId))
    .orderBy(asc(schema.executionAssignments.epoch))) as Array<
    Record<string, any>
  >;
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

async function sessionRow(runId: string) {
  const rows = (await db
    .select()
    .from(schema.runSessions)
    .where(eq(schema.runSessions.runId, runId))) as Array<Record<string, any>>;

  return rows[0];
}

async function seedAgentRun(name: string, run: Record<string, unknown> = {}) {
  // One repo per run: `seedGraphRun` registers a project per call and
  // `projects.repo_path` is unique.
  const repoPath = await initRepo(`${sup.runtimeRoot}/repo-${name}`);
  const worktreePath = await addWorktree(
    repoPath,
    `${sup.runtimeRoot}/wt-${name}`,
    `maister/${name}`,
  );
  const seeded = await seedGraphRun(testDatabase.db, AGENT_FLOW, {
    repoPath,
    workspace: { worktreePath, parentRepoPath: repoPath },
    run,
  });

  await db.transaction((tx) =>
    mintPlacement(tx as unknown as Db, {
      runId: seeded.runId,
      reason: "launch",
    }),
  );

  return seeded;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "eh_lifecycle_test",
  });
  db = testDatabase.db as unknown as Db;
  const journalDir = await mkdtemp(join(tmpdir(), "eh-acp-journal-"));

  sup = await startRealSupervisor({
    fixture: "mock-acp-adapter-resumable.mjs",
    env: { MOCK_ACP_REQUEST_PERMISSION: "1", MOCK_ACP_STATE_DIR: journalDir },
  });
  restoreUrl = useRealSupervisorUrl(sup.url);
  setDefaultTransportForTests(null);
  resetRegistrarStateForTests();
  resetResolverForTests();
  // The responding actor's identity row references `users`.
  await db.insert(schema.users).values({ id: "u-1", email: "u-1@test.local" });
  hosts = createExecutionHosts({ db });
}, 180_000);

afterAll(async () => {
  restoreUrl();
  await sup?.kill();
  await testDatabase?.stop();
});

describe("Stage A lifecycle regression (real supervisor)", () => {
  it("E1: permission → keepalive checkpoint → idle → respond resumes under a new epoch; the stale epoch is fenced; teardown + reconcile leave the run consistent", async () => {
    const { runId } = await seedAgentRun("e1");
    const launch = (await assignmentsOf(runId))[0];

    // 1. The first turn pauses on the adapter's permission request: the
    //    runner persists the HITL row (keyed by the HOST session id) and NeedsInput.
    const flow = runFlow(runId, {
      db,
      runtimeRoot: sup.runtimeRoot,
      executionHosts: hosts,
    });
    const hitl = await waitFor(
      async () => {
        const [row] = await hitlRows(runId);

        return row && (await runRow(runId)).status === "NeedsInput"
          ? row
          : null;
      },
      "NeedsInput + permission HITL row",
      { runId },
    );
    const session1 = await sessionRow(runId);

    expect(hitl.kind).toBe("permission");
    expect(hitl.schema.supervisorSessionId).toBe(session1.hostSessionId);
    expect(session1.executionAssignmentId).toBe(launch.id);
    expect(session1.acpSessionId).toBeTruthy();

    // 2. Keep-alive expiry → the sweeper checkpoints through the run's bound
    //    client; the adapter journals the pending permission and exits with
    //    reason "checkpoint" → NeedsInputIdle; the launch generation is released.
    await db
      .update(schema.runs)
      .set({ keepaliveUntil: new Date(Date.now() - 1_000) })
      .where(eq(schema.runs.id, runId));
    // The sweeper's CAS may lose to the runner's own checkpoint-exit flip
    // (both are status-guarded); either way the run lands NeedsInputIdle.
    await runSweepTick({ db, executionHosts: hosts });
    await flow;
    await waitFor(
      async () => (await runRow(runId)).status === "NeedsInputIdle",
      "NeedsInputIdle",
      { runId },
    );
    let assignments = await assignmentsOf(runId);

    expect(
      assignments.map((a) => [a.epoch, a.state, a.placementReason]),
    ).toEqual([[1, "released", "launch"]]);
    const kindsBeforeResume = (await commandsOf(runId)).map((c) => c.kind);

    expect(kindsBeforeResume).toEqual(
      expect.arrayContaining([
        "workspace.adopt",
        "session.create",
        "session.prompt",
        "session.checkpoint",
      ]),
    );
    expect(
      kindsBeforeResume.filter((k) => k === "workspace.adopt"),
    ).toHaveLength(1);

    // 3. The operator's answer on an idle run resumes it: epoch 2 (`resume`)
    //    is minted inside the claim, the workspace handle is copied forward (no
    //    second adopt), the create resumes the prior ACP session.
    const res = await respondToHitl(
      { runId, hitlRequestId: hitl.id, body: { optionId: "allow" } },
      actor,
      { db, executionHosts: hosts },
    );

    expect(res.status).toBe(202);
    assignments = await assignmentsOf(runId);
    expect(
      assignments.map((a) => [a.epoch, a.state, a.placementReason]),
    ).toEqual([
      [1, "released", "launch"],
      [2, "active", "resume"],
    ]);
    expect(assignments[1].executionWorkspaceId).toBe(
      assignments[0].executionWorkspaceId,
    );
    const commands = await commandsOf(runId);

    expect(commands.filter((c) => c.kind === "workspace.adopt")).toHaveLength(
      1,
    );
    const creates = commands.filter((c) => c.kind === "session.create");

    expect(creates).toHaveLength(2);
    expect(creates[1].assignmentEpoch).toBe(2);
    expect(creates[1].payload.resumeSessionId).toBe(session1.acpSessionId);
    const session2 = await waitFor(
      async () => {
        const row = await sessionRow(runId);

        return row.hostSessionId !== session1.hostSessionId ? row : null;
      },
      "the resumed host session id",
      { runId },
    );

    expect(session2.executionAssignmentId).toBe(assignments[1].id);

    // 4. A command still carrying the superseded epoch is refused by the HOST
    //    (409 FENCED → CONFLICT {assignment_fenced}), not just locally.
    await expect(
      createLocalDirectTransport().checkpointSession(
        session2.hostSessionId,
        buildEnvelope({
          commandId: randomUUID(),
          kind: "session.checkpoint",
          hostKey: assignments[0].executionHostId
            ? (
                (await db
                  .select()
                  .from(schema.executionHosts)
                  .where(
                    eq(
                      schema.executionHosts.id,
                      assignments[0].executionHostId,
                    ),
                  )) as Array<{ hostKey: string }>
              )[0].hostKey
            : "",
          assignmentId: assignments[0].id,
          assignmentEpoch: 1,
          runId,
          payload: {},
        }),
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "assignment_fenced" },
    });

    // 5. The resumed driver auto-delivers the stored intent against the
    //    re-issued permission and the graph finishes.
    const delivered = await waitFor(
      async () => {
        const [row] = await hitlRows(runId);

        return row.respondedAt ? row : null;
      },
      "the stored intent auto-delivered",
      { runId },
    );

    expect(delivered.response).toMatchObject({
      optionId: "allow",
      _audit: { deliveredViaResume: true },
    });
    await waitFor(
      async () => {
        const status = (await runRow(runId)).status;

        return status === "Review" || status === "Done" ? status : null;
      },
      "the run to finish after the resume",
      { runId },
    );

    // 6. Teardown + reconcile: no live session for the run on the host, every
    //    generation released, the recovery pass finds nothing to fold.
    await waitFor(
      async () => {
        const live = (await hosts.local().listSessions()).filter(
          (s) => s.runId === runId && s.status === "live",
        );

        return live.length === 0 ? true : null;
      },
      "no live session for the run",
      { runId },
    );
    const recovery = await recoverExecutionCommands({ db, graceMs: 0 });

    expect(recovery.folded).toBe(0);
    await releaseStaleAssignments({ db, graceMs: 0 });
    assignments = await assignmentsOf(runId);
    expect(assignments.map((a) => a.state)).toEqual(["released", "released"]);
    expect(
      (await commandsOf(runId)).filter((c) =>
        ["queued", "delivering"].includes(c.state),
      ),
    ).toHaveLength(0);
  }, 180_000);

  it("E2: a retryable spawn failure on resume rolls the claim back and releases the fresh generation as resume_rollback", async () => {
    const { runId } = await seedAgentRun("e2", {
      status: "NeedsInputIdle",
      checkpointAt: new Date(),
    });

    await db
      .update(schema.runSessions)
      .set({ acpSessionId: "acp-e2", hostSessionId: "sess-e2" })
      .where(eq(schema.runSessions.runId, runId));
    await db.transaction((tx) =>
      releaseAssignmentForRun(tx as unknown as Db, runId, "checkpointed"),
    );

    const wire = createLocalDirectTransport();
    const failing = createExecutionHosts({
      db,
      transport: {
        ...wire,
        createSession: async () => {
          throw new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor 503", {
            details: { httpStatus: 503 },
          });
        },
      },
    });

    const r = await resumeRun(runId, { db, executionHosts: failing });

    expect(r).toMatchObject({
      ok: false,
      code: "EXECUTOR_UNAVAILABLE",
      retryable: true,
    });
    expect((await runRow(runId)).status).toBe("NeedsInputIdle");
    expect(
      (await assignmentsOf(runId)).map((a) => [
        a.epoch,
        a.state,
        a.placementReason,
        a.releasedReason,
      ]),
    ).toEqual([
      [1, "released", "launch", "checkpointed"],
      [2, "released", "resume", "resume_rollback"],
    ]);
  }, 120_000);
});
