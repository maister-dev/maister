import type { SupervisorSessionRecord } from "@/lib/supervisor-client";

import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  type DelegationSeedCtx,
  resetDelegationFixture,
  seedFlow,
  seedTask,
} from "@/test-support/delegation-seed";
import {
  createFakeExecutionHost,
  fakeExecutionHosts,
} from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// Codex review F2 (ADR-163): `cascadeAbandonRunTree` flips DESCENDANT rows
// only — sessions live in the supervisor. Every caller that cancels a tree
// (the coordinator's run_cancel of a flow child that itself orchestrates, the
// operator stop of an orchestrator, the abandon route) must also stop the
// cascaded children's live ACP sessions, or a grandchild keeps spending and
// mutating its worktree under an `Abandoned` row that no Running-only sweep
// ever revisits.

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;
let agentsRoot: string;
let ctx: DelegationSeedCtx;
let flowId: string;

const listSessionsSpy = vi.fn(
  async (): Promise<SupervisorSessionRecord[]> => [],
);
const deleteSessionSpy = vi.fn(async (_sessionId: string): Promise<void> => {});

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/supervisor-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/supervisor-client")>();

  return {
    ...actual,
    listSessions: () => listSessionsSpy(),
    deleteSession: (sessionId: string) => deleteSessionSpy(sessionId),
  };
});
vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: "cancel-user",
    email: "cancel@test",
    role: "admin",
  })),
  requireProjectAction: vi.fn(async () => undefined),
}));

let stopWorkbenchRun: typeof import("@/lib/workbench-lifecycle/service").stopWorkbenchRun;
let stopWorkbenchRunForToken: typeof import("@/lib/workbench-lifecycle/service").stopWorkbenchRunForToken;
let abandonPOST: typeof import("@/app/api/runs/[runId]/abandon/route").POST;

beforeAll(async () => {
  agentsRoot = await mkdtemp(
    path.join(os.tmpdir(), "maister-cancel-teardown-"),
  );
  testDatabase = await startMainPostgresTestDb({
    databaseName: "delegated_cancel_teardown_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
  // ADR-165: the cascade teardown lists and deletes through the execution-host
  // client; the fake host routes both to this suite's spies.
  const fake = createFakeExecutionHost();

  Object.assign(fake.transport, {
    listSessions: () => listSessionsSpy(),
    deleteSession: async (sessionId: string) => {
      await deleteSessionSpy(sessionId);

      return { outcome: "terminated" as const };
    },
  });
  await fakeExecutionHosts(db, { fake });

  ({ stopWorkbenchRun, stopWorkbenchRunForToken } = await import(
    "@/lib/workbench-lifecycle/service"
  ));
  ({ POST: abandonPOST } = await import(
    "@/app/api/runs/[runId]/abandon/route"
  ));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  ctx = await resetDelegationFixture({ pool, db, agentsRoot });
  ({ flowId } = await seedFlow(ctx, { flowRefId: "orc" }));
  await pool.query(
    `INSERT INTO "users" ("id", "email", "role", "account_status")
     VALUES ('cancel-user', 'cancel@test', 'admin', 'active')
     ON CONFLICT ("id") DO NOTHING`,
  );
  listSessionsSpy.mockReset();
  listSessionsSpy.mockResolvedValue([]);
  deleteSessionSpy.mockReset();
  deleteSessionSpy.mockResolvedValue(undefined);
});

async function seedRun(args: {
  runKind: "flow" | "agent";
  status: string;
  parentRunId?: string | null;
  rootRunId?: string | null;
  currentStepId?: string | null;
}): Promise<string> {
  const runId = randomUUID();
  const task = await seedTask(ctx, { title: `t-${runId.slice(0, 8)}` });

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "project_id", "task_id", "flow_id",
       "status", "current_step_id", "flow_version", "flow_revision", "parent_run_id", "root_run_id")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'v1.0.0', 'unknown', $8, COALESCE($9, $8, $1))`,
    [
      runId,
      args.runKind,
      ctx.projectId,
      task.id,
      args.runKind === "flow" ? flowId : null,
      args.status,
      args.currentStepId ?? null,
      args.parentRunId ?? null,
      args.rootRunId ?? null,
    ],
  );

  return runId;
}

function liveRecord(runId: string, sessionId: string): SupervisorSessionRecord {
  return {
    sessionId,
    runId,
    projectSlug: "p",
    stepId: "implement",
    status: "live",
    pid: 4321,
    startedAt: new Date().toISOString(),
    monotonicId: 1,
    acpSessionId: `acp-${sessionId}`,
  };
}

async function statusOf(runId: string): Promise<string> {
  const rows = await pool.query(`SELECT "status" FROM "runs" WHERE "id" = $1`, [
    runId,
  ]);

  return rows.rows[0].status;
}

function killed(): string[] {
  return deleteSessionSpy.mock.calls.map((call) => call[0]);
}

describe("cancelling a run tree also stops the cascaded descendants' live sessions", () => {
  it("run_cancel of a flow child that orchestrates a grandchild tears down the grandchild's session too", async () => {
    const orchestrator = await seedRun({
      runKind: "flow",
      status: "WaitingOnChildren",
      currentStepId: "coordinate",
    });
    const child = await seedRun({
      runKind: "flow",
      status: "Running",
      parentRunId: orchestrator,
      rootRunId: orchestrator,
    });
    const grandchild = await seedRun({
      runKind: "agent",
      status: "Running",
      parentRunId: child,
      rootRunId: orchestrator,
    });

    listSessionsSpy.mockResolvedValue([
      liveRecord(child, "sup-child"),
      liveRecord(grandchild, "sup-grandchild"),
    ]);

    const result = await stopWorkbenchRunForToken(child, {
      projectId: ctx.projectId,
    });

    expect(result).toMatchObject({ ok: true, runStatus: "Abandoned" });
    expect(await statusOf(child)).toBe("Abandoned");
    expect(await statusOf(grandchild)).toBe("Abandoned");
    expect(await statusOf(orchestrator)).toBe("WaitingOnChildren");
    expect(killed()).toContain("sup-grandchild");
    expect(killed()).toContain("sup-child");
  }, 60_000);

  it("a grandchild whose deleteSession fails does not block the cancel — the rows still settle and the child's own session is still stopped", async () => {
    const orchestrator = await seedRun({
      runKind: "flow",
      status: "WaitingOnChildren",
      currentStepId: "coordinate",
    });
    const child = await seedRun({
      runKind: "flow",
      status: "Running",
      parentRunId: orchestrator,
      rootRunId: orchestrator,
    });
    const grandchild = await seedRun({
      runKind: "agent",
      status: "Running",
      parentRunId: child,
      rootRunId: orchestrator,
    });

    listSessionsSpy.mockResolvedValue([
      liveRecord(child, "sup-child"),
      liveRecord(grandchild, "sup-grandchild"),
    ]);
    deleteSessionSpy.mockImplementation(async (sessionId: string) => {
      if (sessionId === "sup-grandchild") {
        throw new Error("supervisor hiccup");
      }
    });

    const result = await stopWorkbenchRunForToken(child, {
      projectId: ctx.projectId,
    });

    expect(result).toMatchObject({ ok: true, runStatus: "Abandoned" });
    expect(await statusOf(grandchild)).toBe("Abandoned");
    expect(killed()).toContain("sup-grandchild");
    expect(killed()).toContain("sup-child");
  }, 60_000);

  it("the operator stop of a Running orchestrator tears down its cascaded child's session", async () => {
    const orchestrator = await seedRun({
      runKind: "flow",
      status: "Running",
      currentStepId: "coordinate",
    });
    const child = await seedRun({
      runKind: "flow",
      status: "Running",
      parentRunId: orchestrator,
      rootRunId: orchestrator,
    });

    listSessionsSpy.mockResolvedValue([liveRecord(child, "sup-child")]);

    const result = await stopWorkbenchRun(orchestrator);

    expect(result).toMatchObject({ ok: true, runStatus: "Review" });
    expect(await statusOf(child)).toBe("Abandoned");
    expect(killed()).toContain("sup-child");
  }, 60_000);

  it("the abandon route on a parked orchestrator tears down its cascaded child's session", async () => {
    const orchestrator = await seedRun({
      runKind: "flow",
      status: "WaitingOnChildren",
      currentStepId: "coordinate",
    });
    const child = await seedRun({
      runKind: "agent",
      status: "Running",
      parentRunId: orchestrator,
      rootRunId: orchestrator,
    });

    listSessionsSpy.mockResolvedValue([liveRecord(child, "sup-child")]);

    const res = await abandonPOST(
      new NextRequest(`http://localhost/api/runs/${orchestrator}/abandon`, {
        method: "POST",
      }),
      { params: Promise.resolve({ runId: orchestrator }) },
    );

    expect(res.status).toBe(200);
    expect(await statusOf(orchestrator)).toBe("Abandoned");
    expect(await statusOf(child)).toBe("Abandoned");
    expect(killed()).toContain("sup-child");
  }, 60_000);
});
