// M37 follow-up (ADR-102): tree-promote on a REUSER shared child. A shared
// writable tree is ONE git worktree = ONE branch = ONE cumulative diff owned by
// the ALLOCATOR child's `workspaces` row; the REUSER children of the same
// orchestrator tree (root_run_id) carry NO workspaces row of their own. A
// run_promote on ANY shared child must resolve the tree workspace by
// (root_run_id, workspace_mode='shared') — NOT by the promoted child's own
// run_id — then merge once. This is the NARROW core assertion (full Review→Done
// settle of ALL shared siblings is Phase 2): calling promoteChildRunForToken on
// a REUSER child must NOT dead-end with PRECONDITION "workspace not found: ...".
//
// RED today: loadWorkspaceForUpdate(tx, reuserChildRunId) (promote.ts) selects
// `workspaces WHERE run_id = reuserChildRunId` → none → throws PRECONDITION
// "workspace not found: <reuserChildRunId>" before any merge.
//
// The git primitives are stubbed (no real repo) so the DB resolution + claim/
// finalize CAS is what's exercised; with the allocator's workspace resolved the
// stubbed local_merge runs and flips the reuser child Done.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
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
import { isMaisterError, MaisterError } from "@/lib/errors";

// Git side-effects: a local_merge promote resolves the target tip then merges.
// Both are stubbed (no real repo); the DB claim/finalize CAS stays real.
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

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

let promoteChildRunForToken: typeof import("@/lib/runs/promote").promoteChildRunForToken;
let promoteRun: typeof import("@/lib/runs/promote").promoteRun;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("promote_shared_tree_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ promoteChildRunForToken, promoteRun } = await import(
    "@/lib/runs/promote"
  ));
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
  await pool.query(`DELETE FROM "assignments"`);
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

  // Minimal agent rows to satisfy runs.agent_id FK (the promote path never
  // dereferences them; the merge resolves the tree workspace, not the agent).
  for (const stem of ["coordinator", "worker"]) {
    await pool.query(
      `INSERT INTO "agents" ("id", "flow_ref_id", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path", "enabled")
       VALUES ($1, 'test-pkg', 'v1.0.0', 'git', $2, 'd', 'worktree', 'session', '["manual"]'::jsonb, 'read_only', $3, true)
       ON CONFLICT (id) DO NOTHING`,
      [`test-pkg:${stem}`, stem, `/tmp/${stem}.md`],
    );
  }
});

afterEach(() => {
  vi.clearAllMocks();
});

// An orchestrator parent run (run_kind=agent, its own tree root).
async function seedRoot(): Promise<string> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "root_run_id", "runner_id")
     VALUES ($1, 'agent', 'test-pkg:coordinator', $2, 'Running', 'agent', 'manual', $1, $3)`,
    [runId, projectId, executorId],
  );

  return runId;
}

// A shared-mode delegated child (run_kind=agent, workspace_mode='shared'), in
// Review. `withWorkspace` selects the ALLOCATOR (owns the one shared workspaces
// row) vs a REUSER (no row of its own — the tree workspace is resolved by
// (root_run_id, workspace_mode='shared')). `launchMode` selects the unattended
// auto-DAG path ('auto') vs the orchestrator/manual path ('manual', default).
async function seedSharedChild(args: {
  rootRunId: string;
  withWorkspace: boolean;
  launchMode?: "auto" | "manual";
}): Promise<string> {
  const childRunId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id",
       "launch_mode", "agent_workspace", "workspace_mode", "runner_snapshot", "runner_id")
     VALUES ($1, 'agent', 'test-pkg:worker', $2, 'Review', 'agent', 'manual', $3, $3,
             $5, 'worktree', 'shared', '{"capabilityAgent":"claude"}'::jsonb, $4)`,
    [
      childRunId,
      projectId,
      args.rootRunId,
      executorId,
      args.launchMode ?? "manual",
    ],
  );

  if (args.withWorkspace) {
    // The single shared tree: ONE git worktree = ONE branch, owned by the
    // allocator. worktree_path is UNIQUE, keyed by the tree root.
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

async function runStatus(runId: string): Promise<string | null> {
  const r = await pool.query(`SELECT "status" FROM "runs" WHERE "id" = $1`, [
    runId,
  ]);

  return r.rows[0]?.status ?? null;
}

// Seed a minimal task row (satisfies runs.task_id FK). Returns the task id.
async function seedTask(): Promise<string> {
  const taskId = randomUUID();

  await pool.query(
    `INSERT INTO "tasks" ("id", "project_id", "number", "title", "prompt", "status", "stage", "attempt_number")
     VALUES ($1, $2, $3, 't', 'p', 'InFlight', 'InFlight', 1)`,
    [taskId, projectId, Math.trunc(Math.random() * 1e9) + 1],
  );

  return taskId;
}

// A shared-mode delegated child WITH a distinct task_id (so per-child run.done
// emission can be asserted to carry its OWN parent_run_id + task_id). Mirrors
// seedSharedChild but stamps task_id. `withWorkspace` selects the allocator.
async function seedSharedChildWithTask(args: {
  rootRunId: string;
  withWorkspace: boolean;
}): Promise<{ childRunId: string; taskId: string }> {
  const taskId = await seedTask();
  const childRunId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id", "task_id",
       "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id",
       "launch_mode", "agent_workspace", "workspace_mode", "runner_snapshot", "runner_id")
     VALUES ($1, 'agent', 'test-pkg:worker', $2, $3, 'Review', 'agent', 'manual', $4, $4,
             'manual', 'worktree', 'shared', '{"capabilityAgent":"claude"}'::jsonb, $5)`,
    [childRunId, projectId, taskId, args.rootRunId, executorId],
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

  return { childRunId, taskId };
}

// A shared-tree sibling parked in a NON-settled (writable) status. Owns NO
// workspaces row (the allocator owns the one tree workspace). Used to exercise
// the settled-gate: a tree-promote must refuse while ANY sibling is writable.
async function seedWritableSibling(args: {
  rootRunId: string;
  status: string;
}): Promise<string> {
  const childRunId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id",
       "launch_mode", "agent_workspace", "workspace_mode", "runner_snapshot", "runner_id")
     VALUES ($1, 'agent', 'test-pkg:worker', $2, $3, 'agent', 'manual', $4, $4,
             'manual', 'worktree', 'shared', '{"capabilityAgent":"claude"}'::jsonb, $5)`,
    [childRunId, projectId, args.status, args.rootRunId, executorId],
  );

  return childRunId;
}

async function setRunStatus(runId: string, status: string): Promise<void> {
  await pool.query(`UPDATE "runs" SET "status" = $1 WHERE "id" = $2`, [
    status,
    runId,
  ]);
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

async function workspacePromotionState(
  rootRunId: string,
): Promise<string | null> {
  const r = await pool.query(
    `SELECT w."promotion_state" AS s
       FROM "workspaces" w
       JOIN "runs" r ON r."id" = w."run_id"
      WHERE r."root_run_id" = $1 AND r."workspace_mode" = 'shared'`,
    [rootRunId],
  );

  return r.rows[0]?.s ?? null;
}

// run.done domain events keyed by the run they settled. parent_run_id is folded
// into the payload JSON (outbox.ts); task_id rides BOTH the top-level column and
// the payload — assert through whichever the contract pins.
async function runDoneEvents(): Promise<
  Array<{
    runId: string | null;
    taskIdCol: string | null;
    parentRunIdPayload: string | null;
    taskIdPayload: string | null;
  }>
> {
  const r = await pool.query(
    `SELECT "run_id"               AS "runId",
            "task_id"              AS "taskIdCol",
            "payload"->>'parentRunId' AS "parentRunIdPayload",
            "payload"->>'taskId'      AS "taskIdPayload"
       FROM "domain_events"
      WHERE "kind" = 'run.done'
      ORDER BY "id"`,
  );

  return r.rows;
}

describe("ADR-102 — promoteChildRunForToken resolves the tree workspace for a REUSER shared child", () => {
  it("a REUSER shared child (no workspaces row of its own) does NOT dead-end with PRECONDITION 'workspace not found' — the tree workspace is resolved and the merge runs", async () => {
    const root = await seedRoot();

    // The allocator owns the single shared workspaces row; the reuser has none.
    await seedSharedChild({ rootRunId: root, withWorkspace: true });
    const reuserChildRunId = await seedSharedChild({
      rootRunId: root,
      withWorkspace: false,
    });

    let thrown: unknown;

    try {
      await promoteChildRunForToken(reuserChildRunId, {
        projectId,
        actor: { kind: "system" },
        db,
      });
    } catch (err) {
      thrown = err;
    }

    // The narrow contract: the reuser's promote resolved a tree workspace — it
    // did NOT fail with the run_id-scoped "workspace not found" PRECONDITION.
    if (thrown !== undefined) {
      const isWorkspaceNotFound =
        isMaisterError(thrown) &&
        thrown.code === "PRECONDITION" &&
        /workspace not found/i.test(thrown.message);

      expect(isWorkspaceNotFound).toBe(false);
    }

    // With the allocator's workspace resolved, the stubbed local_merge runs and
    // the reuser child reaches Done.
    expect(promoteLocalMergeSpy).toHaveBeenCalledTimes(1);
    expect(await runStatus(reuserChildRunId)).toBe("Done");
  });
});

// ---------------------------------------------------------------------------
// T9 (Phase 2, ADR-102) — promote-time SETTLED-GATE.
//
// A shared tree = ONE branch = ONE diff. A run_promote on ANY shared child must
// be REFUSED (PRECONDITION) while ANY shared sibling of the tree (same
// root_run_id) is still in a WRITABLE status — the complement of
// SETTLED_RUN_STATUSES (terminal + Review), i.e. Running | NeedsInput |
// NeedsInputIdle | HumanWorking | Pending | WaitingOnChildren. Merging while a
// sibling is still writing would promote a half-built tree. Once EVERY shared
// sibling is settled (Review/terminal), the promote merges.
//
// RED today: promoteWorkspaceRun only checks the PROMOTING child's own status
// (run.status !== "Review"); it never inspects siblings, so a tree-promote runs
// the merge with a Running sibling. The settled-gate is Phase 2.
// ---------------------------------------------------------------------------
describe("ADR-102 T9 — promote-time settled-gate (refuse while any shared sibling is writable)", () => {
  for (const writableStatus of ["Running", "NeedsInput", "WaitingOnChildren"]) {
    it(`refuses PRECONDITION (no merge) while a shared sibling is ${writableStatus}`, async () => {
      const root = await seedRoot();

      // Allocator owns the tree workspace; the promoting child reuses it.
      await seedSharedChild({ rootRunId: root, withWorkspace: true });
      const promotingChild = await seedSharedChild({
        rootRunId: root,
        withWorkspace: false,
      });

      // A sibling of the SAME tree is still writing.
      await seedWritableSibling({ rootRunId: root, status: writableStatus });

      let thrown: unknown;

      try {
        await promoteChildRunForToken(promotingChild, {
          projectId,
          actor: { kind: "system" },
          db,
        });
      } catch (err) {
        thrown = err;
      }

      expect(isMaisterError(thrown)).toBe(true);
      expect((thrown as MaisterError).code).toBe("PRECONDITION");
      // NO merge while the tree is unsettled.
      expect(promoteLocalMergeSpy).not.toHaveBeenCalled();
      // The promoting child stays Review (not flipped).
      expect(await runStatus(promotingChild)).toBe("Review");
    });
  }

  it("merges once ALL shared siblings are settled (the writable sibling flips to Review)", async () => {
    const root = await seedRoot();

    await seedSharedChild({ rootRunId: root, withWorkspace: true });
    const promotingChild = await seedSharedChild({
      rootRunId: root,
      withWorkspace: false,
    });
    const sibling = await seedWritableSibling({
      rootRunId: root,
      status: "Running",
    });

    // First promote is gated by the still-Running sibling.
    await expect(
      promoteChildRunForToken(promotingChild, {
        projectId,
        actor: { kind: "system" },
        db,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    expect(promoteLocalMergeSpy).not.toHaveBeenCalled();

    // The last sibling settles into Review — now the whole tree is settled.
    await setRunStatus(sibling, "Review");

    await promoteChildRunForToken(promotingChild, {
      projectId,
      actor: { kind: "system" },
      db,
    });

    // The tree merges exactly once.
    expect(promoteLocalMergeSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// T10 (Phase 2, ADR-102) — idempotent tree-settle (exactly-once).
//
// One tree-promote on ANY shared child merges the ONE branch ONCE and flips ALL
// shared children of the tree (root_run_id) that were in Review → Done in ONE
// tx, emitting run.done PER settled child (each carrying its OWN parent_run_id +
// task_id). Exactly-once has two faces:
//   (c) a SEQUENTIAL re-promote on an already-Done child → PRECONDITION no-op.
//   (d) two CONCURRENT promotes serialize on the allocator workspaces row → one
//       wins, the other gets CONFLICT; the merge runs exactly once.
//
// RED today: the finalize tx flips ONLY the promoting child (runs WHERE id =
// runId) → Done and emits ONE run.done. The sibling stays Review; no per-child
// fan-out emission. The tree-settle is Phase 2.
// ---------------------------------------------------------------------------
describe("ADR-102 T10 — idempotent tree-settle (merge once, settle all shared children)", () => {
  it("(a) one tree-promote merges ONCE and flips ALL shared Review children to Done", async () => {
    const root = await seedRoot();
    const allocator = await seedSharedChild({
      rootRunId: root,
      withWorkspace: true,
    });
    const reuserA = await seedSharedChild({
      rootRunId: root,
      withWorkspace: false,
    });
    const reuserB = await seedSharedChild({
      rootRunId: root,
      withWorkspace: false,
    });

    await promoteChildRunForToken(reuserA, {
      projectId,
      actor: { kind: "system" },
      db,
    });

    expect(promoteLocalMergeSpy).toHaveBeenCalledTimes(1);
    // EVERY shared child of the tree settles to Done in the one tx — not just
    // the promoting reuserA.
    expect(await runStatus(allocator)).toBe("Done");
    expect(await runStatus(reuserA)).toBe("Done");
    expect(await runStatus(reuserB)).toBe("Done");
  });

  it("(b) emits run.done PER settled child, each carrying its own parent_run_id + task_id", async () => {
    const root = await seedRoot();
    const allocator = await seedSharedChildWithTask({
      rootRunId: root,
      withWorkspace: true,
    });
    const reuser = await seedSharedChildWithTask({
      rootRunId: root,
      withWorkspace: false,
    });

    await promoteChildRunForToken(reuser.childRunId, {
      projectId,
      actor: { kind: "system" },
      db,
    });

    const events = await runDoneEvents();
    const byRun = new Map(events.map((e) => [e.runId, e]));

    // One run.done per settled child.
    expect(byRun.has(allocator.childRunId)).toBe(true);
    expect(byRun.has(reuser.childRunId)).toBe(true);

    // Each event carries the OWN child's parent_run_id (the orchestrator root)
    // and its OWN task_id — NOT the promoting child's.
    expect(byRun.get(allocator.childRunId)?.parentRunIdPayload).toBe(root);
    expect(byRun.get(allocator.childRunId)?.taskIdCol).toBe(allocator.taskId);
    expect(byRun.get(reuser.childRunId)?.parentRunIdPayload).toBe(root);
    expect(byRun.get(reuser.childRunId)?.taskIdCol).toBe(reuser.taskId);
  });

  it("(c) a SECOND sequential promote on a now-Done sibling is a PRECONDITION no-op (merge not called again)", async () => {
    const root = await seedRoot();

    await seedSharedChild({ rootRunId: root, withWorkspace: true });
    const reuserA = await seedSharedChild({
      rootRunId: root,
      withWorkspace: false,
    });
    const reuserB = await seedSharedChild({
      rootRunId: root,
      withWorkspace: false,
    });

    // First tree-promote settles the whole tree.
    await promoteChildRunForToken(reuserA, {
      projectId,
      actor: { kind: "system" },
      db,
    });
    expect(promoteLocalMergeSpy).toHaveBeenCalledTimes(1);
    expect(await runStatus(reuserB)).toBe("Done");

    // A second promote on the (now-Done) sibling finds it no longer Review →
    // PRECONDITION, and the merge is NOT run a second time.
    await expect(
      promoteChildRunForToken(reuserB, {
        projectId,
        actor: { kind: "system" },
        db,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    expect(promoteLocalMergeSpy).toHaveBeenCalledTimes(1);
  });

  it("(d) two CONCURRENT promotes on different shared children: one wins, the other CONFLICTs, merge runs once", async () => {
    const root = await seedRoot();

    await seedSharedChild({ rootRunId: root, withWorkspace: true });
    const reuserA = await seedSharedChild({
      rootRunId: root,
      withWorkspace: false,
    });
    const reuserB = await seedSharedChild({
      rootRunId: root,
      withWorkspace: false,
    });

    const results = await Promise.allSettled([
      promoteChildRunForToken(reuserA, {
        projectId,
        actor: { kind: "system" },
        db,
      }),
      promoteChildRunForToken(reuserB, {
        projectId,
        actor: { kind: "system" },
        db,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );

    // Exactly one promote wins the allocator-row claim; the other loses.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(isMaisterError(rejected[0].reason)).toBe(true);
    expect((rejected[0].reason as MaisterError).code).toBe("CONFLICT");

    // The ONE branch merged exactly once across both racers.
    expect(promoteLocalMergeSpy).toHaveBeenCalledTimes(1);
    // The whole tree settled.
    expect(await runStatus(reuserA)).toBe("Done");
    expect(await runStatus(reuserB)).toBe("Done");
  });
});

// ---------------------------------------------------------------------------
// T11 (Phase 2, ADR-102) — tree merge CONFLICT.
//
// A local_merge tree conflict aborts the WHOLE settle: the promote rejects
// CONFLICT, ALL shared children STAY Review (none flipped to Done), and the
// allocator workspaces row is NOT promotion_state='done' (it must be 'failed'
// or a reclaimable state — never a partial settle). The conflict path runs
// BEFORE the settle flip.
//
// RED today: even with the run-id-only flip, a conflict must leave the child in
// Review (the existing conflict branch CAS's the workspace to 'failed' and
// rethrows). This test additionally pins that NO SIBLING is flipped — the
// Phase-2 tree-settle must run AFTER a successful merge, never before.
// ---------------------------------------------------------------------------
describe("ADR-102 T11 — tree merge conflict aborts the whole settle (no partial flip)", () => {
  it("a local_merge conflict → CONFLICT; all shared children stay Review; workspace not 'done'", async () => {
    const root = await seedRoot();
    const allocator = await seedSharedChild({
      rootRunId: root,
      withWorkspace: true,
    });
    const reuser = await seedSharedChild({
      rootRunId: root,
      withWorkspace: false,
    });

    // The merge hits a conflict on the shared branch.
    promoteLocalMergeSpy.mockRejectedValueOnce(
      new MaisterError("CONFLICT", "merge conflict in app/foo.ts"),
    );

    await expect(
      promoteChildRunForToken(reuser, {
        projectId,
        actor: { kind: "system" },
        db,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // NO partial settle: every shared child of the tree stays Review.
    expect(await runStatus(allocator)).toBe("Review");
    expect(await runStatus(reuser)).toBe("Review");

    // The allocator workspace did NOT reach 'done' — a conflict leaves it
    // reclaimable ('failed'), never settled.
    expect(await workspacePromotionState(root)).not.toBe("done");

    // No run.done was emitted for any child.
    expect(await runDoneEvents()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// C1 (Phase 2, ADR-102 defense-in-depth) — rework RACES the finalize flip.
//
// The claim-tx settled-gate holds the allocator-workspace lock, but that lock is
// RELEASED at claim-commit and the merge runs lockless; the cross-tree flip is a
// SEPARATE finalize tx. If a concurrent run_rework flips a shared sibling
// Review→Running in that merge window, settling the tree would strand the
// reworked sibling's new work. The finalize re-runs the settled-gate UNDER its
// lock: on a resettle it resets the claim to reclaimable and aborts CONFLICT — no
// partial settle. A re-promote after the sibling re-settles re-merges (idempotent).
//
// RED before the C1 fix: the finalize flips only on status='Review', so the
// promoting child + allocator settle Done while the reworked sibling is stranded
// Running on a merged + GC-scheduled branch.
// ---------------------------------------------------------------------------
describe("ADR-102 C1 — a sibling reworked during the merge window aborts the settle", () => {
  it("aborts CONFLICT, leaves all children unsettled (Review/Running), workspace reclaimable (not 'done')", async () => {
    const root = await seedRoot();
    const allocator = await seedSharedChild({
      rootRunId: root,
      withWorkspace: true,
    });
    const promoting = await seedSharedChild({
      rootRunId: root,
      withWorkspace: false,
    });
    const sibling = await seedSharedChild({
      rootRunId: root,
      withWorkspace: false,
    });

    // Block the merge until we signal, so a sibling can be reworked mid-merge —
    // AFTER the claim tx committed (lock released), BEFORE the finalize tx.
    let releaseMerge!: (commit: string) => void;
    const mergeGate = new Promise<string>((resolve) => {
      releaseMerge = resolve;
    });

    promoteLocalMergeSpy.mockImplementationOnce(() => mergeGate);

    const promoteP = promoteChildRunForToken(promoting, {
      projectId,
      actor: { kind: "system" },
      db,
    });

    // Wait until the claim committed + the merge is in-flight.
    await vi.waitFor(() =>
      expect(promoteLocalMergeSpy).toHaveBeenCalledTimes(1),
    );

    // A concurrent run_rework re-opens a sibling Review→Running during the window.
    await setRunStatus(sibling, "Running");

    // Let the merge complete; the finalize re-check sees the unsettled sibling.
    releaseMerge("mergedcommit00");

    await expect(promoteP).rejects.toMatchObject({ code: "CONFLICT" });

    // NO partial settle: the promoting child + allocator stay Review (not Done),
    // and the reworked sibling stays Running.
    expect(await runStatus(promoting)).toBe("Review");
    expect(await runStatus(allocator)).toBe("Review");
    expect(await runStatus(sibling)).toBe("Running");

    // The allocator workspace did NOT reach 'done' — it is reclaimable so a
    // re-promote (after the sibling re-settles) can re-merge + settle.
    expect(await workspacePromotionState(root)).not.toBe("done");

    // Nothing settled → no run.done.
    expect(await runDoneEvents()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FIX B (Codex re-review, ADR-102) — finalize-time FAILURE-terminal re-check for
// the UNATTENDED auto-DAG shared-tree promote (launch_mode='auto').
//
// The auto-promoter's F2 PRE-check (autoPromoteAsPlanChild) skips a tree with a
// failure-terminal shared sibling BEFORE promote. The C1 finalize re-check counts
// only NON-settled siblings — but Abandoned | Failed | Crashed ARE settled, so a
// Review sibling that abandons/fails DURING the lockless merge window slips past
// C1 and gets absorbed into the tree-settle. That re-opens the F2 gap on the
// unattended path (an autonomous merge must not absorb a failed sibling's partial,
// unreviewed work). The finalize re-runs countFailureTerminalSharedSiblings under
// its lock — scoped to the auto path (launch_mode='auto'), the under-lock twin of
// the F2 pre-check — and aborts CONFLICT. An orchestrator's explicit run_promote
// and a human manual promote are NOT subject to it (the whole tree-diff was
// reviewed — F2 Option B: manual stays allowed).
//
// RED before the fix: the finalize's only shared-tree gate is the C1 unsettled
// re-check; an Abandoned sibling counts as settled, so the auto promote settles
// the tree (promoting child + allocator → Done) despite the failed sibling.
// ---------------------------------------------------------------------------
describe("ADR-102 FIX B — finalize aborts an unattended auto-promote when a sibling failure-terminalizes in the merge window", () => {
  it("(auto path) a sibling Abandoned during the merge window → CONFLICT, no child Done, workspace not 'done', no run.done", async () => {
    const root = await seedRoot();
    const allocator = await seedSharedChild({
      rootRunId: root,
      withWorkspace: true,
    });
    // The promoting child came through the unattended auto-DAG path.
    const promoting = await seedSharedChild({
      rootRunId: root,
      withWorkspace: false,
      launchMode: "auto",
    });
    const sibling = await seedSharedChild({
      rootRunId: root,
      withWorkspace: false,
    });

    // Block the merge until signalled — AFTER the claim tx committed (lock
    // released), BEFORE the finalize tx.
    let releaseMerge!: (commit: string) => void;
    const mergeGate = new Promise<string>((resolve) => {
      releaseMerge = resolve;
    });

    promoteLocalMergeSpy.mockImplementationOnce(() => mergeGate);

    const promoteP = promoteChildRunForToken(promoting, {
      projectId,
      actor: { kind: "system" },
      db,
    });

    await vi.waitFor(() =>
      expect(promoteLocalMergeSpy).toHaveBeenCalledTimes(1),
    );

    // A sibling reaches a FAILURE-terminal status (Abandoned) during the window —
    // settled for the C1 gate, but it carries partial unreviewed work.
    await setRunStatus(sibling, "Abandoned");

    releaseMerge("mergedcommit00");

    await expect(promoteP).rejects.toMatchObject({ code: "CONFLICT" });

    // No partial settle: the promoting child + allocator stay Review (NOT Done).
    expect(await runStatus(promoting)).toBe("Review");
    expect(await runStatus(allocator)).toBe("Review");
    // The abandoned sibling is untouched.
    expect(await runStatus(sibling)).toBe("Abandoned");

    // The allocator workspace is reclaimable, not 'done'.
    expect(await workspacePromotionState(root)).not.toBe("done");

    // Nothing settled → no run.done.
    expect(await runDoneEvents()).toHaveLength(0);
  });

  it("(human) a pre-existing Abandoned sibling does NOT abort a manual promote — it proceeds to Done", async () => {
    const userId = await seedUser();
    const root = await seedRoot();
    const allocator = await seedSharedChild({
      rootRunId: root,
      withWorkspace: true,
    });

    // A sibling already failure-terminal BEFORE the human promote (the human
    // reviewed the whole tree-diff and chose to promote anyway).
    await seedWritableSibling({ rootRunId: root, status: "Abandoned" });

    // A human manual promote: user actor (isHumanPromotion true), local_merge with
    // the reviewed target SHA (the stubbed resolveBaseCommit tip).
    const result = await promoteRun(
      allocator,
      { mode: "local_merge", reviewedTargetCommit: "targettip000000" },
      {
        sessionUser: { id: userId, name: "U", email: "u@test.com" },
        authorize: async () => {},
        actor: { kind: "user" },
      },
      db,
    );

    // The human promote is NOT aborted by the failure-terminal re-check.
    expect(result.ok).toBe(true);
    expect(promoteLocalMergeSpy).toHaveBeenCalledTimes(1);
    expect(await runStatus(allocator)).toBe("Done");
    expect(await workspacePromotionState(root)).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// FIX C (Codex adversarial review, ADR-102) — claim-tx PRE-merge failure-terminal
// guard for a NON-human shared-tree promote.
//
// The settled-gate (countUnsettledSharedSiblings) treats Failed | Crashed |
// Abandoned as SETTLED, so it does NOT block a tree whose shared sibling is
// ALREADY failure-terminal. The only failure-terminal gate used to be the finalize
// FIX B re-check — which runs AFTER the lockless merge, so a non-human promote
// (orchestrator run_promote / as-plan auto-promoter) with an already-failed sibling
// would merge (MUTATING the target) and only THEN abort CONFLICT. The orchestrator
// run_promote route had no pre-check at all (only the auto-launcher did).
//
// The claim-tx guard refuses such a promote with PRECONDITION BEFORE any git
// side-effect. Proof of "target unchanged" in this stubbed harness: the merge fn
// (promoteLocalMergeSpy) is NEVER invoked, and the claim is never minted
// (promotion_state stays 'none'). A human manual promote is exempt (the pre-existing
// failure-terminal case is covered by FIX B's human test above).
//
// RED before the fix: the merge spy is called once and the promote aborts CONFLICT
// from the finalize FIX B re-check — i.e. the target was already mutated.
// ---------------------------------------------------------------------------
describe("ADR-102 FIX C — claim-tx guard refuses a non-human promote (no merge) when a shared sibling is ALREADY failure-terminal", () => {
  for (const failedStatus of ["Failed", "Crashed", "Abandoned"]) {
    it(`(non-human) refuses PRECONDITION and never merges while a shared sibling is already ${failedStatus}`, async () => {
      const root = await seedRoot();
      const allocator = await seedSharedChild({
        rootRunId: root,
        withWorkspace: true,
      });
      const promoting = await seedSharedChild({
        rootRunId: root,
        withWorkspace: false,
      });

      // A sibling of the SAME tree is ALREADY failure-terminal BEFORE the promote
      // (seedWritableSibling = a sibling run with the given status, no workspace).
      await seedWritableSibling({ rootRunId: root, status: failedStatus });

      let thrown: unknown;

      try {
        await promoteChildRunForToken(promoting, {
          projectId,
          actor: { kind: "system" },
          db,
        });
      } catch (err) {
        thrown = err;
      }

      // Refused at the claim tx with a failure-terminal PRECONDITION (NOT the
      // settled-gate "still writable" message, NOT a post-merge CONFLICT).
      expect(isMaisterError(thrown)).toBe(true);
      expect((thrown as MaisterError).code).toBe("PRECONDITION");
      expect((thrown as MaisterError).message).toMatch(
        /failure-terminal status; tree needs human attention/,
      );

      // The target was NEVER touched — the merge fn was not even reached.
      expect(promoteLocalMergeSpy).not.toHaveBeenCalled();

      // No partial settle: the promoting child + allocator stay Review.
      expect(await runStatus(promoting)).toBe("Review");
      expect(await runStatus(allocator)).toBe("Review");

      // The claim was never minted — the workspace stays 'none' (not 'claiming',
      // 'failed', or 'done').
      expect(await workspacePromotionState(root)).toBe("none");

      // Nothing settled → no run.done.
      expect(await runDoneEvents()).toHaveLength(0);
    });
  }
});
