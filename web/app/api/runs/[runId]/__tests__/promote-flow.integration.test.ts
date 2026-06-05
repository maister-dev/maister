import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";

// M18 Phase 2 — RED until `web/lib/runs/promote.ts` (`promoteRun`) lands with
// the durable promotion claim (§3.2, Codex F1/F5). This is the INTEGRATION
// surface: a REAL git repo (the parent repo + a run branch the merge targets)
// and a REAL Postgres (Testcontainers) so the claim CAS is exercised against
// the database, not a fake. The git side-effect is the actual `promoteLocalMerge`.
//
// Concurrency contract proven here (the Implementor must satisfy ALL):
//   * two-racer: two concurrent promoteRun on the same run → exactly ONE Done,
//     one 409 CONFLICT, the merge happens once.
//   * stale-claim reclaim: a `claiming` workspace whose promotion_claimed_at is
//     older than MAISTER_PROMOTION_CLAIM_TIMEOUT_SECONDS → a re-promote reclaims
//     and finalizes Done, no duplicate.
//   * same-user stale-reclaim double-finalize refusal (Codex F5): the original
//     slow attempt finalizes AFTER a reclaim re-minted promotion_attempt_id →
//     original refused 409 CONFLICT, no second Done.
//   * target-drift (Codex F6): target advances between review and promote →
//     PRECONDITION; same call with allowTargetDrift → Done.
//   * legacy row (Codex F4): pre-M18 Review run, null branch metadata → derive
//     fallback Done OR typed PRECONDITION (asserted explicitly).

const execFileAsync = promisify(execFile);
const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let originalDbUrl: string | undefined;
let originalClaimTimeout: string | undefined;

let gitRoot: string;
let repo: string;

async function git(
  cwd: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd });
}

// ---- promoteRun driver ----------------------------------------------------
//
// promoteRun(runId, input, ctx, db?) — ctx supplies the session user + the
// authorize() callback (route maps it to requireProjectAction). We pass the
// test db explicitly so the service binds to the Testcontainers pool.

const ctx = {
  sessionUser: { id: "u-promoter", name: "Promoter", email: "p@test.com" },
  authorize: async (_projectId: string) => undefined,
};

async function promote(
  runId: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const { promoteRun } = await import("@/lib/runs/promote");

  return promoteRun(runId, input as never, ctx as never, db as never);
}

// ---- fixtures -------------------------------------------------------------

async function setupGitRepo(): Promise<{
  baseCommit: string;
  targetTip: string;
}> {
  gitRoot = join(tmpdir(), `promote-flow-${randomUUID()}`);
  repo = join(gitRoot, "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "test@example.test"]);
  await git(repo, ["config", "user.name", "Test User"]);
  await writeFile(join(repo, "file.txt"), "base\n");
  await git(repo, ["add", "file.txt"]);
  await git(repo, ["commit", "-m", "initial"]);
  const { stdout: baseSha } = await git(repo, ["rev-parse", "HEAD"]);
  const baseCommit = baseSha.trim();

  // A `release` target branch (custom target ≠ base case).
  await git(repo, ["branch", "release"]);
  const { stdout: tip } = await git(repo, ["rev-parse", "main"]);

  return { baseCommit, targetTip: tip.trim() };
}

// Create a run branch off main with one new commit so the merge has content.
async function createRunBranch(
  branch: string,
  fileName: string,
): Promise<void> {
  await git(repo, ["branch", branch, "main"]);
  // Commit to the branch via a temp worktree to avoid touching the checkout.
  const wt = join(gitRoot, `wt-${randomUUID()}`);

  await git(repo, ["worktree", "add", wt, branch]);
  await writeFile(join(wt, fileName), "run change\n");
  await git(wt, ["add", fileName]);
  await git(wt, ["commit", "-m", `change on ${branch}`]);
  await git(repo, ["worktree", "remove", "--force", wt]);
}

let projectId: string;
let executorId: string;
let flowId: string;
let revisionId: string;

async function seedFlowReviewRun(args: {
  branch: string;
  targetBranch: string | null;
  promotionMode: string | null;
  promotionState?: string;
  promotionClaimedAt?: Date | null;
  promotionAttemptId?: string | null;
}): Promise<string> {
  const runId = randomUUID();
  const taskId = randomUUID();

  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    title: "promote task",
    prompt: "p",
    flowId,
    status: "InFlight",
  });
  await db.insert(schema.runs).values({
    id: runId,
    runKind: "flow",
    taskId,
    projectId,
    flowId,
    flowRevisionId: revisionId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId, "claude"),
    status: "Review",
    acpSessionId: "acp-x",
    currentStepId: "review-node",
    flowVersion: "v1",
    startedAt: new Date(),
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: args.branch,
    worktreePath: join(gitRoot, `seed-wt-${runId}`),
    parentRepoPath: repo,
    baseBranch: "main",
    baseCommit: "0".repeat(40),
    targetBranch: args.targetBranch,
    promotionMode: args.promotionMode,
    promotionState: args.promotionState ?? "none",
    promotionClaimedAt: args.promotionClaimedAt ?? null,
    promotionAttemptId: args.promotionAttemptId ?? null,
  });

  return runId;
}

async function readRun(runId: string): Promise<any> {
  const rows = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return rows[0];
}

async function readWorkspace(runId: string): Promise<any> {
  const rows = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.runId, runId));

  return rows[0];
}

async function activeMergeConflictCount(runId: string): Promise<number> {
  const rows = await db
    .select()
    .from(schema.assignments)
    .where(eq(schema.assignments.runId, runId));

  return rows.filter(
    (a: any) =>
      a.actionKind === "merge_conflict" &&
      (a.status === "open" || a.status === "claimed"),
  ).length;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("promote_flow_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();
  originalClaimTimeout = process.env.MAISTER_PROMOTION_CLAIM_TIMEOUT_SECONDS;
  process.env.MAISTER_PROMOTION_CLAIM_TIMEOUT_SECONDS = "300";

  projectId = randomUUID();
  executorId = randomUUID();
  flowId = randomUUID();
  revisionId = randomUUID();

  await db.insert(schema.users).values({
    id: "u-promoter",
    email: "p@test.com",
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });
}, 240_000);

afterAll(async () => {
  if (originalDbUrl === undefined) delete process.env.DB_URL;
  else process.env.DB_URL = originalDbUrl;
  if (originalClaimTimeout === undefined)
    delete process.env.MAISTER_PROMOTION_CLAIM_TIMEOUT_SECONDS;
  else
    process.env.MAISTER_PROMOTION_CLAIM_TIMEOUT_SECONDS = originalClaimTimeout;

  await pool?.end();
  await container?.stop();
  if (gitRoot) await rm(gitRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.delete(schema.assignments);
  await db.delete(schema.workspaces);
  await db.delete(schema.runs);
  await db.delete(schema.tasks);
  await db.delete(schema.platformAcpRunners);
  await db.delete(schema.flows);
  await db.delete(schema.flowRevisions);
  await db.delete(schema.projects);

  const setup = await setupGitRepo();

  await db.insert(schema.projects).values({
    id: projectId,
    slug: "promote-app",
    name: "Promote App",
    repoPath: repo,
    mainBranch: "main",
    maisterYamlPath: join(repo, "maister.yaml"),
    promotionMode: "local_merge",
  });
  await db.insert(schema.flowRevisions).values({
    id: revisionId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    versionLabel: "v1.0.0",
    resolvedRevision: revisionId.padEnd(40, "x").slice(0, 40),
    manifestDigest: `digest-${revisionId}`,
    manifest: { schemaVersion: 1, name: "Bugfix", nodes: [] },
    schemaVersion: 1,
    installedPath: "/cache/rev",
    setupStatus: "not_required",
    packageStatus: "Installed",
  });
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/cache/rev",
    manifest: { schemaVersion: 1, name: "Bugfix", nodes: [] },
    schemaVersion: 1,
    enabledRevisionId: revisionId,
    enablementState: "Enabled",
    trustStatus: "trusted_by_policy",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  // Capture the void marker so the unused setup return is meaningful.
  void setup;
});

describe("promoteRun — flow local_merge happy path (integration)", () => {
  it("promotes a Review flow run to Done with a --no-ff merge commit on the target", async () => {
    await createRunBranch("maister/feature", "feature.txt");
    const runId = await seedFlowReviewRun({
      branch: "maister/feature",
      targetBranch: "main",
      promotionMode: "local_merge",
    });

    const { stdout: tip } = await git(repo, ["rev-parse", "main"]);

    const res = (await promote(runId, {
      mode: "local_merge",
      reviewedTargetCommit: tip.trim(),
    })) as { ok: boolean; commit?: string };

    expect(res.ok).toBe(true);
    expect((await readRun(runId)).status).toBe("Done");
    expect((await readWorkspace(runId)).promotionState).toBe("done");

    // The target advanced and the merge is a --no-ff merge commit (2 parents).
    const { stdout: head } = await git(repo, ["rev-parse", "main"]);

    expect(head.trim()).not.toBe(tip.trim());
    const { stdout: parents } = await git(repo, [
      "rev-list",
      "--parents",
      "-n",
      "1",
      "main",
    ]);

    expect(parents.trim().split(/\s+/).length).toBe(3); // commit + 2 parents
  });

  it("promotes into a custom target branch that differs from the base", async () => {
    await createRunBranch("maister/custom", "custom.txt");
    const runId = await seedFlowReviewRun({
      branch: "maister/custom",
      targetBranch: "release",
      promotionMode: "local_merge",
    });

    const { stdout: tip } = await git(repo, ["rev-parse", "release"]);

    const res = (await promote(runId, {
      mode: "local_merge",
      targetBranch: "release",
      reviewedTargetCommit: tip.trim(),
    })) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect((await readRun(runId)).status).toBe("Done");

    const { stdout: relHead } = await git(repo, ["rev-parse", "release"]);

    expect(relHead.trim()).not.toBe(tip.trim());
  });
});

describe("promoteRun — flow local_merge conflict (integration)", () => {
  it("creates a merge-conflict assignment, leaves the run Review, marks promotion_state=failed", async () => {
    // Diverge file.txt on both main and the run branch → textual conflict.
    await git(repo, ["branch", "maister/conflict", "main"]);
    const wt = join(gitRoot, `wt-conflict-${randomUUID()}`);

    await git(repo, ["worktree", "add", wt, "maister/conflict"]);
    await writeFile(join(wt, "file.txt"), "branch side\n");
    await git(wt, ["commit", "-am", "branch edit"]);
    await git(repo, ["worktree", "remove", "--force", wt]);
    await writeFile(join(repo, "file.txt"), "main side\n");
    await git(repo, ["commit", "-am", "main edit"]);

    const runId = await seedFlowReviewRun({
      branch: "maister/conflict",
      targetBranch: "main",
      promotionMode: "local_merge",
    });

    const { stdout: tip } = await git(repo, ["rev-parse", "main"]);

    await expect(
      promote(runId, {
        mode: "local_merge",
        reviewedTargetCommit: tip.trim(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect((await readRun(runId)).status).toBe("Review");
    expect((await readWorkspace(runId)).promotionState).toBe("failed");
    expect(await activeMergeConflictCount(runId)).toBe(1);
  });
});

describe("promoteRun — two-racer (integration, real CAS)", () => {
  it("two concurrent promotes yield exactly one Done and one 409 CONFLICT; merge happens once", async () => {
    await createRunBranch("maister/race", "race.txt");
    const runId = await seedFlowReviewRun({
      branch: "maister/race",
      targetBranch: "main",
      promotionMode: "local_merge",
    });

    const { stdout: tip } = await git(repo, ["rev-parse", "main"]);
    const body = { mode: "local_merge", reviewedTargetCommit: tip.trim() };

    const results = await Promise.allSettled([
      promote(runId, body),
      promote(runId, body),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "CONFLICT",
    });

    expect((await readRun(runId)).status).toBe("Done");
    expect((await readWorkspace(runId)).promotionState).toBe("done");

    // The merge produced exactly one merge commit on main (single side-effect).
    const { stdout: merges } = await git(repo, [
      "rev-list",
      "--merges",
      "--count",
      "main",
    ]);

    expect(Number(merges.trim())).toBe(1);
  });
});

describe("promoteRun — stale-claim reclaim (integration, §3.3)", () => {
  it("reclaims a claiming workspace past the timeout and finalizes Done with no duplicate", async () => {
    await createRunBranch("maister/stale", "stale.txt");
    // A prior attempt crashed AFTER the claim commit: promotion_state=claiming,
    // claimed_at older than the 300s timeout. The merge never ran (no commit on
    // main yet), so a clean re-promote should reclaim and finalize.
    const staleClaimedAt = new Date(Date.now() - 10 * 60_000);
    const runId = await seedFlowReviewRun({
      branch: "maister/stale",
      targetBranch: "main",
      promotionMode: "local_merge",
      promotionState: "claiming",
      promotionClaimedAt: staleClaimedAt,
      promotionAttemptId: "crashed-attempt-token",
    });

    const { stdout: tip } = await git(repo, ["rev-parse", "main"]);

    const res = (await promote(runId, {
      mode: "local_merge",
      reviewedTargetCommit: tip.trim(),
    })) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect((await readRun(runId)).status).toBe("Done");

    const ws = await readWorkspace(runId);

    expect(ws.promotionState).toBe("done");
    // The reclaim re-minted the attempt token (no longer the crashed one).
    expect(ws.promotionAttemptId).not.toBe("crashed-attempt-token");

    const { stdout: merges } = await git(repo, [
      "rev-list",
      "--merges",
      "--count",
      "main",
    ]);

    expect(Number(merges.trim())).toBe(1);
  });

  it("refuses to reclaim a FRESH claiming workspace (within the timeout) → 409 CONFLICT", async () => {
    await createRunBranch("maister/fresh", "fresh.txt");
    const runId = await seedFlowReviewRun({
      branch: "maister/fresh",
      targetBranch: "main",
      promotionMode: "local_merge",
      promotionState: "claiming",
      promotionClaimedAt: new Date(),
      promotionAttemptId: "in-flight-token",
    });

    const { stdout: tip } = await git(repo, ["rev-parse", "main"]);

    await expect(
      promote(runId, {
        mode: "local_merge",
        reviewedTargetCommit: tip.trim(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect((await readRun(runId)).status).toBe("Review");
  });
});

describe("promoteRun — stale-reclaim then terminal refusal (Codex F5, end-to-end)", () => {
  // HONEST SCOPE: the §3.2 mandatory-(b) finalize-token interleave (an ORIGINAL
  // slow attempt finalizing AFTER a reclaim re-minted promotion_attempt_id) needs
  // a reclaim to land DURING a single in-flight call's side-effect window. The
  // public promoteRun is monolithic (claim → merge → finalize in one call) and
  // this integration harness uses real, un-injectable git, so that window cannot
  // be opened here without mocking the merge (which would defeat the real-worktree
  // purpose). The finalize-token-mismatch guard is therefore AUTHORITATIVELY
  // covered by the unit test promote-service.test.ts (“finalize attempt-token
  // mismatch (Codex F5)”), which mutates promotion_attempt_id inside the mocked
  // side-effect to hit A’s finalize with a superseded token.
  //
  // What THIS case proves end-to-end with real git: a genuine stale-claim reclaim
  // (state=claiming, token A, claimed_at past the timeout) is taken over by a
  // fresh promote that re-mints the token, merges exactly ONCE, and finalizes
  // Done — and a subsequent promote of the now-terminal run is refused with no
  // second merge.
  it("reclaims a stale token-A claim, re-mints + finalizes once, then refuses a follow-up promote", async () => {
    await createRunBranch("maister/supersede", "supersede.txt");
    // Seed the ORIGINAL attempt's durable view: it claimed (token A) and then
    // crashed/stalled past the timeout BEFORE merging — a reclaimable stale claim.
    const staleClaimedAt = new Date(Date.now() - 10 * 60_000);
    const runId = await seedFlowReviewRun({
      branch: "maister/supersede",
      targetBranch: "main",
      promotionMode: "local_merge",
      promotionState: "claiming",
      promotionClaimedAt: staleClaimedAt,
      promotionAttemptId: "token-A",
    });

    const { stdout: tip } = await git(repo, ["rev-parse", "main"]);
    const body = { mode: "local_merge", reviewedTargetCommit: tip.trim() };

    // The reclaimer takes over the stale token-A claim, re-mints, merges once.
    const first = (await promote(runId, body)) as { ok: boolean };

    expect(first.ok).toBe(true);
    expect((await readRun(runId)).status).toBe("Done");

    const wsAfter = await readWorkspace(runId);

    expect(wsAfter.promotionState).toBe("done");
    // token-A is superseded: it could never finalize this run.
    expect(wsAfter.promotionAttemptId).not.toBe("token-A");

    // A follow-up promote of the now-terminal run is refused (terminal allow-list)
    // and never merges again.
    await expect(promote(runId, body)).rejects.toMatchObject({
      code: "PRECONDITION",
    });

    const { stdout: merges } = await git(repo, [
      "rev-list",
      "--merges",
      "--count",
      "main",
    ]);

    expect(Number(merges.trim())).toBe(1);
  });
});

describe("promoteRun — target-drift (Codex F6, integration)", () => {
  it("refuses PRECONDITION when the target advanced since review, then succeeds with allowTargetDrift", async () => {
    await createRunBranch("maister/drift", "drift.txt");
    const runId = await seedFlowReviewRun({
      branch: "maister/drift",
      targetBranch: "main",
      promotionMode: "local_merge",
    });

    // Capture the reviewed tip, THEN advance main (another run merged in).
    const { stdout: reviewedTip } = await git(repo, ["rev-parse", "main"]);

    await writeFile(join(repo, "other.txt"), "another change\n");
    await git(repo, ["add", "other.txt"]);
    await git(repo, ["commit", "-m", "target advanced"]);

    await expect(
      promote(runId, {
        mode: "local_merge",
        reviewedTargetCommit: reviewedTip.trim(),
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    expect((await readRun(runId)).status).toBe("Review");
    // No claim left behind by the drift refusal.
    expect((await readWorkspace(runId)).promotionState).not.toBe("claiming");

    // Override: Promote anyway against the moved target.
    const res = (await promote(runId, {
      mode: "local_merge",
      reviewedTargetCommit: reviewedTip.trim(),
      allowTargetDrift: true,
    })) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect((await readRun(runId)).status).toBe("Done");
  });
});

describe("promoteRun — legacy row (Codex F4, §3.6)", () => {
  it("a pre-M18 Review run with null branch metadata derives a fallback OR is refused with a typed PRECONDITION", async () => {
    await createRunBranch("maister/legacy", "legacy.txt");
    // Null target_branch + null promotion_mode (pre-migration-backfill row).
    const runId = await seedFlowReviewRun({
      branch: "maister/legacy",
      targetBranch: null,
      promotionMode: null,
    });

    const { stdout: tip } = await git(repo, ["rev-parse", "main"]);

    let derived: "fallback" | "precondition";

    try {
      const res = (await promote(runId, {
        mode: "local_merge",
        reviewedTargetCommit: tip.trim(),
      })) as { ok: boolean };

      expect(res.ok).toBe(true);
      derived = "fallback";
    } catch (err) {
      expect(err).toMatchObject({ code: "PRECONDITION" });
      derived = "precondition";
    }

    if (derived === "fallback") {
      // Fallback path: targetBranch derived from project.main_branch ("main").
      expect((await readRun(runId)).status).toBe("Done");
    } else {
      // Refusal path: never a null branch into git; run stays Review.
      expect((await readRun(runId)).status).toBe("Review");
    }
  });
});
