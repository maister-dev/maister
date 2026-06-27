// T13 (Phase 2, ADR-102): the auto-promoter treats the settled-gate PRECONDITION
// as a BENIGN "wait for the last sibling", and a rework re-opens the gate.
//
// In an as-plan (launch_mode='auto') shared tree, EACH child reaching Review
// emits run.review, which the auto_launch_run_plan consumer turns into an
// auto-promote (autoPromoteAsPlanChild → real promoteChildRunForToken). With the
// Phase-2 settled-gate (T9), an EARLY child's auto-promote — fired while a
// SIBLING is still writing — must be REFUSED with PRECONDITION and SWALLOWED
// (the consumer's try/catch logs and leaves the child in Review): a tree promote
// is correct only once every shared sibling has settled. The LAST sibling's
// run.review is the one that drives the single tree-promote that settles the
// whole tree.
//
// Rework regression: re-opening a settled shared child (Review → Running, the
// markReworkFromReview CAS the rework route uses) puts the tree back into a
// writable state, so the settled-gate must again BLOCK a tree-promote until that
// child re-settles.
//
// RED today: with only the run-id flip + no settled-gate, the EARLY child's
// auto-promote MERGES immediately (promoting a half-built tree) and flips only
// itself — so the "no merge while a sibling is writable" + "single settle on the
// last sibling" + "rework re-blocks" assertions all fail.

import type { DomainEventRow } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";

// The merge primitives are stubbed (no real repo) so the DB tree-resolve +
// settled-gate + claim/finalize CAS is what's exercised.
const promoteLocalMergeSpy = vi.fn(async () => "mergedcommit00");

vi.mock("@/lib/worktree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worktree")>();

  return {
    ...actual,
    resolveBaseCommit: vi.fn(async () => "targettip000000"),
    branchExists: vi.fn(async () => true),
    pushBranch: vi.fn(async () => undefined),
    promoteLocalMerge: (...args: unknown[]) =>
      promoteLocalMergeSpy(...(args as [])),
  };
});

let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
// A launch path is never reached in these tests (the candidate discovery finds
// no released dependents), but stub tryStartRun off defensively so any launch
// stays a stable Pending rather than spawning.
vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();

  return {
    ...actual,
    tryStartRun: vi.fn(async () => ({ started: false, queuePosition: 1 })),
  };
});

let container: StartedPostgreSqlContainer;
let pool: Pool;

let buildAutoLaunchRunPlanConsumer: typeof import("@/lib/domain-events/auto-launch").buildAutoLaunchRunPlanConsumer;
let emitDomainEvent: typeof import("@/lib/domain-events/outbox").emitDomainEvent;
let promoteChildRunForToken: typeof import("@/lib/runs/promote").promoteChildRunForToken;
let promoteRun: typeof import("@/lib/runs/promote").promoteRun;
let markReworkFromReview: typeof import("@/lib/runs/state-transitions").markReworkFromReview;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("shared_tree_autolaunch_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ buildAutoLaunchRunPlanConsumer } = await import(
    "@/lib/domain-events/auto-launch"
  ));
  ({ emitDomainEvent } = await import("@/lib/domain-events/outbox"));
  ({ promoteChildRunForToken, promoteRun } = await import(
    "@/lib/runs/promote"
  ));
  ({ markReworkFromReview } = await import("@/lib/runs/state-transitions"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

let projectId: string;
let executorId: string;

beforeEach(async () => {
  promoteLocalMergeSpy.mockClear();

  await pool.query(`DELETE FROM "domain_events"`);
  await pool.query(`DELETE FROM "workspaces"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "platform_acp_runners"`);
  await pool.query(`DELETE FROM "projects"`);
  await pool.query(`DELETE FROM "users"`);

  projectId = randomUUID();
  executorId = randomUUID();

  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key", "next_task_number")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/maister.yaml', $4, 1)`,
    [
      projectId,
      `p-${projectId.slice(0, 8)}`,
      `/repos/${projectId}`,
      `K${projectId
        .replace(/[^0-9A-Za-z]/g, "")
        .slice(0, 7)
        .toUpperCase()}`,
    ],
  );

  await (db as any)
    .insert((await import("@/lib/db/schema")).platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  await pool.query(
    `INSERT INTO "agents" ("id", "package_name", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path", "enabled")
     VALUES ('test-pkg:worker', 'test-pkg', 'v1.0.0', 'git', 'worker', 'd', 'worktree', 'session', '["manual"]'::jsonb, 'read_only', '/tmp/worker.md', true)
     ON CONFLICT (id) DO NOTHING`,
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

async function seedRoot(): Promise<string> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "root_run_id")
     VALUES ($1, 'agent', 'test-pkg:worker', $2, 'Running', 'agent', 'manual', $1)`,
    [runId, projectId],
  );
  await pool.query(
    `INSERT INTO "run_sessions" ("id", "run_id", "session_name", "runner_id")
     VALUES ($1, $2, 'default', $3)`,
    [randomUUID(), runId, executorId],
  );

  return runId;
}

// A real users row (the human-promote finalize stamps promotion_owner_user_id,
// an FK to users). Returns the user id for the human ctx's sessionUser.
async function seedUser(): Promise<string> {
  const userId = randomUUID();

  await pool.query(
    `INSERT INTO "users" ("id", "email", "role") VALUES ($1, $2, 'admin')`,
    [userId, `u-${userId.slice(0, 8)}@test.com`],
  );

  return userId;
}

// A shared as-plan (launch_mode='auto') child. `withWorkspace` selects the
// allocator. `status` defaults to Review.
async function seedSharedAutoChild(args: {
  rootRunId: string;
  withWorkspace: boolean;
  status?: string;
}): Promise<string> {
  const childRunId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id",
       "launch_mode", "agent_workspace", "workspace_mode")
     VALUES ($1, 'agent', 'test-pkg:worker', $2, $3, 'agent', 'manual', $4, $4,
             'auto', 'worktree', 'shared')`,
    [childRunId, projectId, args.status ?? "Review", args.rootRunId],
  );
  await pool.query(
    `INSERT INTO "run_sessions" ("id", "run_id", "session_name", "runner_snapshot", "runner_id")
     VALUES ($1, $2, 'default', '{"capabilityAgent":"claude"}'::jsonb, $3)`,
    [randomUUID(), childRunId, executorId],
  );

  if (args.withWorkspace) {
    await pool.query(
      `INSERT INTO "workspaces" ("id", "run_id", "project_id", "branch", "worktree_path", "parent_repo_path",
         "base_commit", "base_branch", "target_branch", "promotion_mode", "promotion_state")
       VALUES ($1, $2, $3, $4, $5, $6, 'base000', 'main', 'main', 'local_merge', 'none')`,
      [
        randomUUID(),
        childRunId,
        projectId,
        `maister/agents/${args.rootRunId}`,
        `/tmp/shared-wt-${args.rootRunId}`,
        `/repos/${projectId}`,
      ],
    );
  }

  return childRunId;
}

async function emitReview(args: {
  parentRunId: string;
  childRunId: string;
}): Promise<DomainEventRow> {
  await emitDomainEvent({
    db,
    kind: "run.review",
    projectId,
    taskId: null,
    runId: args.childRunId,
    actor: { type: "agent", id: "test-pkg:worker" },
    parentRunId: args.parentRunId,
    payload: {
      runKind: "agent",
      agentId: "test-pkg:worker",
      status: "Review",
    },
  });

  const rows = (await db
    .select()
    .from((await import("@/lib/db/schema")).domainEvents)
    .where(
      eq((await import("@/lib/db/schema")).domainEvents.runId, args.childRunId),
    )) as DomainEventRow[];

  return rows[rows.length - 1];
}

async function runStatus(runId: string): Promise<string | null> {
  const r = await pool.query(`SELECT "status" FROM "runs" WHERE "id" = $1`, [
    runId,
  ]);

  return r.rows[0]?.status ?? null;
}

describe("ADR-102 T13 — auto-launch benign settled-gate wait + rework regression", () => {
  it("an EARLY run.review (a sibling still writable) makes the auto-promoter SKIP: no merge, child stays Review, no throw", async () => {
    const root = await seedRoot();

    // Allocator owns the tree workspace.
    await seedSharedAutoChild({ rootRunId: root, withWorkspace: true });
    // The child that reached Review early (a reuser of the tree).
    const earlyChild = await seedSharedAutoChild({
      rootRunId: root,
      withWorkspace: false,
    });

    // A sibling is still writing.
    await seedSharedAutoChild({
      rootRunId: root,
      withWorkspace: false,
      status: "Running",
    });

    const event = await emitReview({
      parentRunId: root,
      childRunId: earlyChild,
    });

    // Real promoteChildRunForToken (no promote override): the settled-gate
    // PRECONDITION is caught by autoPromoteAsPlanChild and logged, never thrown.
    const consumer = buildAutoLaunchRunPlanConsumer({ db });

    await expect(consumer.handle([event])).resolves.toBeUndefined();

    // The benign wait: NO merge, the early child stays Review.
    expect(promoteLocalMergeSpy).not.toHaveBeenCalled();
    expect(await runStatus(earlyChild)).toBe("Review");
  });

  it("the LAST sibling's run.review (all now settled) drives the single tree-promote that settles the tree", async () => {
    const root = await seedRoot();
    const allocator = await seedSharedAutoChild({
      rootRunId: root,
      withWorkspace: true,
    });
    const earlyChild = await seedSharedAutoChild({
      rootRunId: root,
      withWorkspace: false,
    });
    // The LAST sibling reaches Review — now every shared child is settled.
    const lastChild = await seedSharedAutoChild({
      rootRunId: root,
      withWorkspace: false,
    });

    const event = await emitReview({
      parentRunId: root,
      childRunId: lastChild,
    });
    const consumer = buildAutoLaunchRunPlanConsumer({ db });

    await consumer.handle([event]);

    // The tree merges exactly once and the WHOLE tree settles to Done.
    expect(promoteLocalMergeSpy).toHaveBeenCalledTimes(1);
    expect(await runStatus(allocator)).toBe("Done");
    expect(await runStatus(earlyChild)).toBe("Done");
    expect(await runStatus(lastChild)).toBe("Done");
  });

  it("rework regression: re-opening a shared child (Review → Running) re-blocks the tree-promote (PRECONDITION) until it re-settles", async () => {
    const root = await seedRoot();

    await seedSharedAutoChild({ rootRunId: root, withWorkspace: true });
    const promotingChild = await seedSharedAutoChild({
      rootRunId: root,
      withWorkspace: false,
    });
    const reworkedChild = await seedSharedAutoChild({
      rootRunId: root,
      withWorkspace: false,
    });

    // A reviewer reworks one shared child: Review → Running (the CAS the rework
    // route uses). The tree is writable again.
    const claim = await markReworkFromReview(reworkedChild, { db });

    expect(claim.ok).toBe(true);

    // A tree-promote on the still-Review sibling is now BLOCKED by the settled-
    // gate (a sibling is Running), and no merge runs.
    await expect(
      promoteChildRunForToken(promotingChild, {
        projectId,
        actor: { kind: "system" },
        db,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    expect(promoteLocalMergeSpy).not.toHaveBeenCalled();

    // Once the reworked child re-settles into Review, the tree promote merges.
    await pool.query(`UPDATE "runs" SET "status" = 'Review' WHERE "id" = $1`, [
      reworkedChild,
    ]);

    await promoteChildRunForToken(promotingChild, {
      projectId,
      actor: { kind: "system" },
      db,
    });
    expect(promoteLocalMergeSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// F2 (ADR-102, Option B) — the AUTO-promoter skips a tree with a FAILURE-terminal
// shared sibling.
//
// SETTLED_RUN_STATUSES includes Failed|Crashed|Abandoned, so the settled-gate
// (countUnsettledSharedSiblings) does NOT block a tree whose only non-Review
// sibling failed. The auto-promoter would then MERGE that tree UNATTENDED,
// absorbing the failed sibling's partial, unreviewed commits. Option B: the
// NON-human paths refuse when any shared sibling is failure-terminal — the
// auto-launcher's autoPromoteAsPlanChild pre-skip AND the promote finalize-tx
// re-check for any system/agent actor (FIX B); a human MANUAL promote (promoteRun
// with a user actor) stays allowed (the whole tree-diff is reviewed first).
//
// RED before the fix: with no failure-terminal check on the auto path, the
// Review sibling's run.review drives a merge (promoteLocalMerge called) even
// though a sibling Failed.
// ---------------------------------------------------------------------------
describe("F2 (ADR-102) — auto-promote skips a tree with a failure-terminal sibling; manual stays allowed", () => {
  it("a Failed shared sibling makes the auto-promoter SKIP: no merge, the Review child stays Review, no throw", async () => {
    const root = await seedRoot();

    // Allocator owns the tree workspace.
    await seedSharedAutoChild({ rootRunId: root, withWorkspace: true });
    // A shared sibling FAILED (terminal but non-success) — partial work on the
    // shared branch. It is SETTLED for the writer-safety gate, so it does NOT
    // block the settled-gate.
    await seedSharedAutoChild({
      rootRunId: root,
      withWorkspace: false,
      status: "Failed",
    });
    // The child that reached Review and drives the auto-promote.
    const reviewChild = await seedSharedAutoChild({
      rootRunId: root,
      withWorkspace: false,
    });

    const event = await emitReview({
      parentRunId: root,
      childRunId: reviewChild,
    });
    const consumer = buildAutoLaunchRunPlanConsumer({ db });

    await expect(consumer.handle([event])).resolves.toBeUndefined();

    // Option B: the auto path skips — NO unattended merge, the Review child
    // stays Review for a human to look at the tree.
    expect(promoteLocalMergeSpy).not.toHaveBeenCalled();
    expect(await runStatus(reviewChild)).toBe("Review");
  });

  it("a MANUAL (human) promote on the same tree (a Failed sibling present) STILL merges (Option B leaves manual allowed)", async () => {
    const userId = await seedUser();
    const root = await seedRoot();

    await seedSharedAutoChild({ rootRunId: root, withWorkspace: true });
    await seedSharedAutoChild({
      rootRunId: root,
      withWorkspace: false,
      status: "Failed",
    });
    const reviewChild = await seedSharedAutoChild({
      rootRunId: root,
      withWorkspace: false,
    });

    // A human reviews the whole tree-diff then promotes manually. The
    // failure-terminal re-check (FIX B) is scoped to NON-human promotes, so a
    // user actor (isHumanPromotion true) is NOT aborted by the Failed sibling —
    // it merges. (The system/auto path that promoteChildRunForToken drives IS
    // gated; that abort is covered in promote-shared-tree.integration.test.ts.)
    const result = await promoteRun(
      reviewChild,
      { mode: "local_merge", reviewedTargetCommit: "targettip000000" },
      {
        sessionUser: { id: userId, name: "U", email: "u@test.com" },
        authorize: async () => {},
        actor: { kind: "user" },
      },
      db,
    );

    expect(result.ok).toBe(true);
    expect(promoteLocalMergeSpy).toHaveBeenCalledTimes(1);
  });
});
