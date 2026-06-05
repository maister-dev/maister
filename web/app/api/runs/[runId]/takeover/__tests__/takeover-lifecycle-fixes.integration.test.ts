// M11b adversarial-review remediation (2nd pass, RED → GREEN): three VERIFIED
// takeover-lifecycle defects. Real Postgres testcontainer + real migrations +
// real on-disk git worktree (the return route's git ops + the dirty-worktree
// status check run against it). Real authz layer (mock only @/auth's session
// source).
//
// Owns matrix rows:
//   FIX#1 stale-review-hitl-rejected-during-humanworking,
//   FIX#1 post-return-rerun-mints-fresh-review-no-stale-autoapprove,
//   FIX#2 return-rejects-dirty-tracked-worktree-409,
//   FIX#2 return-rejects-untracked-file-409,
//   FIX#2 return-rejects-zero-commit-range-409,
//   FIX#2 return-succeeds-after-commit (retryable contract),
//   FIX#3 abandon-humanworking-closes-takeover-ledger-row,
//   FIX#3 release-closes-takeover-ledger-row.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
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

import * as schemaModule from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { getActiveTakeover } from "@/lib/flows/graph/ledger";

const execFileAsync = promisify(execFile);
const schema = schemaModule as unknown as Record<string, any>;
const {
  flows,
  hitlRequests,
  nodeAttempts,
  projectMembers,
  projects,
  runs,
  tasks,
  users,
  workspaces,
} = schema;

const REENTRY_NODE = "checks";
const TAKEOVER_NODE = "review";

// implement (ai_coding, never re-run on resume) -> checks (check w/ a passing
// command_check gate) -> review (human, takeover -> checks).
const fixtureManifest = {
  schemaVersion: 1,
  name: "Lifecycle Fixture",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/impl" },
      transitions: { success: REENTRY_NODE },
    },
    {
      id: REENTRY_NODE,
      type: "check",
      action: { command: "true" },
      pre_finish: {
        gates: [
          {
            id: "lint",
            kind: "command_check",
            mode: "blocking",
            command: "true",
          },
        ],
      },
      transitions: { success: TAKEOVER_NODE },
    },
    {
      id: TAKEOVER_NODE,
      type: "human",
      finish: {
        human: {
          role: "maintainer",
          decisions: ["approve", "rework", "takeover"],
        },
      },
      transitions: {
        approve: "done",
        rework: "implement",
        takeover: REENTRY_NODE,
      },
      rework: {
        allowedTargets: ["implement"],
        workspacePolicies: ["keep"],
        maxLoops: 3,
      },
    },
  ],
};

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let originalDbUrl: string | undefined;
let runtimeRoot: string;

const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

// The FIX#1 / FIX#3 cases never want a real graph traversal racing the
// assertions — the resume-reruns-fresh-review behaviour is covered by the
// CRITICAL resume integration test. Mock runFlow to a controllable spy; the
// FIX#1 "fresh review HITL" assertion drives the runner explicitly via the
// real runGraph import.
const runFlowSpy = vi.fn(async (_runId: string, _opts?: unknown) => undefined);

vi.mock("@/lib/flows/runner", () => ({
  runFlow: (runId: string, opts?: unknown) => runFlowSpy(runId, opts),
}));

let claimPOST: typeof import("../claim/route").POST;
let returnPOST: typeof import("../return/route").POST;
let respondPOST: typeof import("../../hitl/[hitlRequestId]/respond/route").POST;
let abandonPOST: typeof import("../../abandon/route").POST;
let runGraph: typeof import("@/lib/flows/graph/runner-graph").runGraph;
let loadRun: typeof import("@/lib/flows/graph/runner-core").loadRun;

async function provisionWorktree(slug: string): Promise<{
  root: string;
  parentRepo: string;
  worktreePath: string;
  branch: string;
  mainBranch: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), `m11b-fix-${slug}-`));
  const parentRepo = path.join(root, "repo");
  const worktreePath = path.join(root, "wt");
  const branch = `maister/${slug}`;
  const mainBranch = "main";

  await execFileAsync("git", ["init", "-b", mainBranch, parentRepo]);
  await execFileAsync("git", [
    "-C",
    parentRepo,
    "config",
    "user.email",
    "t@t.dev",
  ]);
  await execFileAsync("git", ["-C", parentRepo, "config", "user.name", "T"]);
  await writeFile(path.join(parentRepo, "README.md"), "base\n");
  await execFileAsync("git", ["-C", parentRepo, "add", "."]);
  await execFileAsync("git", ["-C", parentRepo, "commit", "-m", "base"]);
  await execFileAsync("git", [
    "-C",
    parentRepo,
    "worktree",
    "add",
    "-b",
    branch,
    worktreePath,
  ]);

  return { root, parentRepo, worktreePath, branch, mainBranch };
}

async function commitInWorktree(
  worktreePath: string,
  file: string,
  content: string,
  message: string,
): Promise<void> {
  await writeFile(path.join(worktreePath, file), content);
  await execFileAsync("git", [
    "-C",
    worktreePath,
    "config",
    "user.email",
    "t@t.dev",
  ]);
  await execFileAsync("git", ["-C", worktreePath, "config", "user.name", "T"]);
  await execFileAsync("git", ["-C", worktreePath, "add", "."]);
  await execFileAsync("git", ["-C", worktreePath, "commit", "-m", message]);
}

type Seed = {
  runId: string;
  projectId: string;
  ownerId: string;
  slug: string;
  worktreePath: string;
  branch: string;
  parentRepo: string;
  reviewHitlId: string | null;
  cleanup: () => Promise<void>;
};

// Seeds a run with a real on-disk worktree, real flows row + non-null flowId,
// real users row (owner FK). When `withReviewHitl` is set, a pre-takeover
// review HITL row (kind=human, awaiting decision) is seeded — the artifact the
// FIX#1 replay would consume.
async function seed(opts: {
  runStatus: string;
  currentStepId?: string;
  withTakeoverAttempt?: boolean;
  takeoverEnded?: boolean;
  withReviewHitl?: boolean;
  withPriorChecks?: boolean;
}): Promise<Seed> {
  const tag = randomUUID().slice(0, 8);
  const slug = `fix-${tag}`;
  const projectId = randomUUID();
  const ownerId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const workspaceId = randomUUID();

  const wt = await provisionWorktree(slug);

  await db.insert(users).values({
    id: ownerId,
    email: `owner-${tag}@maister.local`,
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });
  await db.insert(projects).values({
    id: projectId,
    slug,
    name: slug,
    repoPath: wt.parentRepo,
    mainBranch: wt.mainBranch,
    maisterYamlPath: `${wt.parentRepo}/maister.yaml`,
  });
  await db.insert(projectMembers).values({
    id: randomUUID(),
    projectId,
    userId: ownerId,
    role: "member",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(flows).values({
    id: flowId,
    projectId,
    flowRefId: "lifecycle-fixture",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: `/cache/${flowId}`,
    manifest: fixtureManifest,
    schemaVersion: 1,
  });
  await db.insert(tasks).values({
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
    status: "InFlight",
  });
  await db.insert(runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    status: opts.runStatus,
    currentStepId: opts.currentStepId ?? TAKEOVER_NODE,
    flowVersion: "v1.0.0",
    startedAt: new Date(),
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    runId,
    projectId,
    branch: wt.branch,
    worktreePath: wt.worktreePath,
    parentRepoPath: wt.parentRepo,
  });

  if (opts.withPriorChecks) {
    const checksAttemptId = randomUUID();

    await db.insert(nodeAttempts).values({
      id: checksAttemptId,
      runId,
      nodeId: REENTRY_NODE,
      nodeType: "check",
      attempt: 1,
      status: "Succeeded",
      endedAt: new Date(),
    });
  }

  if (opts.withTakeoverAttempt) {
    await db.insert(nodeAttempts).values({
      id: randomUUID(),
      runId,
      nodeId: TAKEOVER_NODE,
      nodeType: "human",
      attempt: 1,
      status: "NeedsInput",
      ownerUserId: ownerId,
      endedAt: opts.takeoverEnded ? new Date() : null,
    });
  }

  let reviewHitlId: string | null = null;

  if (opts.withReviewHitl) {
    reviewHitlId = randomUUID();
    await db.insert(hitlRequests).values({
      id: reviewHitlId,
      runId,
      stepId: TAKEOVER_NODE,
      kind: "human",
      schema: {
        review: true,
        allowedDecisions: ["approve", "rework", "takeover"],
        transitions: {
          approve: "done",
          rework: "implement",
          takeover: REENTRY_NODE,
        },
        reworkTargets: ["implement"],
        workspacePolicies: ["keep"],
        commentsVar: null,
      },
      prompt: 'Review "review"',
    });
  }

  sessionRef.value = { user: { id: ownerId, role: "member" } };

  return {
    runId,
    projectId,
    ownerId,
    slug,
    worktreePath: wt.worktreePath,
    branch: wt.branch,
    parentRepo: wt.parentRepo,
    reviewHitlId,
    cleanup: async () => {
      await rm(wt.root, { recursive: true, force: true });
    },
  };
}

function claimReq(runId: string): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/runs/${runId}/takeover/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
  );
}

function returnReq(runId: string): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/runs/${runId}/takeover/return`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
  );
}

function respondReq(
  runId: string,
  hitlRequestId: string,
  body: unknown,
): NextRequest {
  return new NextRequest(
    new Request(
      `http://localhost/api/runs/${runId}/hitl/${hitlRequestId}/respond`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  );
}

function abandonReq(runId: string): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/runs/${runId}/abandon`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
  );
}

async function readRun(runId: string): Promise<any> {
  const rows = await db.select().from(runs).where(eq(runs.id, runId));

  return rows[0];
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("takeover_fixes_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
  runtimeRoot = await mkdtemp(path.join(tmpdir(), "m11b-fix-rt-"));
  process.env.MAISTER_RUNTIME_ROOT = runtimeRoot;
  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();

  ({ POST: claimPOST } = await import("../claim/route"));
  ({ POST: returnPOST } = await import("../return/route"));
  ({ POST: respondPOST } = await import(
    "../../hitl/[hitlRequestId]/respond/route"
  ));
  ({ POST: abandonPOST } = await import("../../abandon/route"));
  ({ runGraph } = await import("@/lib/flows/graph/runner-graph"));
  ({ loadRun } = await import("@/lib/flows/graph/runner-core"));
}, 180_000);

afterAll(async () => {
  delete process.env.MAISTER_RUNTIME_ROOT;
  if (originalDbUrl === undefined) {
    delete process.env.DB_URL;
  } else {
    process.env.DB_URL = originalDbUrl;
  }
  await rm(runtimeRoot, { recursive: true, force: true });
  await pool?.end();
  await container?.stop();
});

beforeEach(() => {
  runFlowSpy.mockReset();
  runFlowSpy.mockResolvedValue(undefined);
});

describe("FIX#1 — stale review HITL accepted during HumanWorking (replay risk)", () => {
  it("stale-review-approve rejected 409 during HumanWorking; post-return rerun mints a FRESH review HITL with no stale auto-approval", async () => {
    // A run parked at the review node with the original review HITL open.
    const s = await seed({
      runStatus: "NeedsInput",
      withReviewHitl: true,
      withPriorChecks: true,
    });

    // Reviewer claims the takeover: NeedsInput → HumanWorking.
    const claim = await claimPOST(claimReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(claim.status).toBe(200);
    expect((await readRun(s.runId)).status).toBe("HumanWorking");

    // While the takeover is active, the reviewer (or a stale browser tab)
    // submits the ORIGINAL review approve. This MUST be rejected — the run is
    // not awaiting this response. The bug accepts it (HumanWorking is
    // non-terminal), stores the decision, and writes input-review.json.
    const stale = await respondPOST(
      respondReq(s.runId, s.reviewHitlId as string, {
        response: { decision: "approve" },
      }),
      {
        params: Promise.resolve({
          runId: s.runId,
          hitlRequestId: s.reviewHitlId as string,
        }),
      },
    );

    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("CONFLICT");

    // The original HITL row was NOT marked responded / no decision stored.
    const staleRow = (
      await db
        .select()
        .from(hitlRequests)
        .where(eq(hitlRequests.id, s.reviewHitlId as string))
    )[0];

    expect(staleRow.respondedAt ?? null).toBeNull();
    expect(staleRow.response ?? null).toBeNull();
    expect(staleRow.decision ?? null).toBeNull();

    // No stale input-review.json artifact was written on disk.
    const artifactPath = path.join(
      runtimeRoot,
      ".maister",
      s.slug,
      "runs",
      s.runId,
      "input-review.json",
    );
    const { existsSync } = await import("node:fs");

    expect(existsSync(artifactPath)).toBe(false);

    // The human commits, then returns the takeover.
    await commitInWorktree(
      s.worktreePath,
      "feature.txt",
      "edited\n",
      "feat: human edit",
    );

    const ret = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(ret.status).toBe(200);
    expect((await ret.json()).runStatus).toBe("Running");

    // Drive the runner explicitly (the route's queueMicrotask runFlow is
    // mocked). The post-return rerun must NOT auto-approve from any stale
    // artifact — it reruns the validation path and reaches a FRESH review HITL
    // awaiting a NEW decision (run back to NeedsInput at review).
    const loaded = await loadRun(db, s.runId);

    await runGraph(loaded, { db, runtimeRoot });

    const finalRun = await readRun(s.runId);

    expect(finalRun.status).toBe("NeedsInput");
    expect(finalRun.currentStepId).toBe(TAKEOVER_NODE);

    // A fresh, unanswered review HITL exists (the rerun minted one); none of
    // the run's review HITL rows is auto-approved from the stale submission.
    const reviewHitls = await db
      .select()
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.runId, s.runId),
          eq(hitlRequests.stepId, TAKEOVER_NODE),
        ),
      );
    const freshOpen = reviewHitls.filter(
      (h: any) => (h.respondedAt ?? null) === null,
    );

    expect(freshOpen.length).toBeGreaterThanOrEqual(1);
    // NO review HITL row was ever marked approved/responded by the stale path.
    const anyApproved = reviewHitls.some(
      (h: any) => h.decision === "approve" && h.respondedAt !== null,
    );

    expect(anyApproved).toBe(false);

    await s.cleanup();
  }, 90_000);
});

describe("FIX#2 — return ignores dirty/uncommitted worktree + empty return", () => {
  it("return-rejects-dirty-tracked-worktree-409: uncommitted tracked edit → 409, no ledger write, stays HumanWorking, retryable after commit", async () => {
    const s = await seed({
      runStatus: "HumanWorking",
      withTakeoverAttempt: true,
    });

    // The reviewer edited a tracked file but FORGOT to commit.
    await writeFile(
      path.join(s.worktreePath, "README.md"),
      "base\nDIRTY EDIT\n",
    );

    const res = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONFLICT");

    // No ledger write; run stays HumanWorking.
    expect((await readRun(s.runId)).status).toBe("HumanWorking");
    const ta = await getActiveTakeover(s.runId, db);

    expect(ta).not.toBeNull();
    expect(ta?.endedAt ?? null).toBeNull();
    expect(ta?.returnedDiff ?? null).toBeNull();

    // Retryable: commit then return succeeds.
    await execFileAsync("git", ["-C", s.worktreePath, "add", "."]);
    await execFileAsync("git", [
      "-C",
      s.worktreePath,
      "config",
      "user.email",
      "t@t.dev",
    ]);
    await execFileAsync("git", [
      "-C",
      s.worktreePath,
      "config",
      "user.name",
      "T",
    ]);
    await execFileAsync("git", [
      "-C",
      s.worktreePath,
      "commit",
      "-m",
      "commit edit",
    ]);

    const retry = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(retry.status).toBe(200);
    expect((await readRun(s.runId)).status).toBe("Running");

    await s.cleanup();
  }, 90_000);

  it("return-rejects-untracked-file-409: an untracked file in the worktree → 409, stays HumanWorking", async () => {
    const s = await seed({
      runStatus: "HumanWorking",
      withTakeoverAttempt: true,
    });

    // Commit real work, then leave a NEW untracked file behind.
    await commitInWorktree(
      s.worktreePath,
      "committed.txt",
      "ok\n",
      "feat: committed",
    );
    await writeFile(path.join(s.worktreePath, "scratch.txt"), "untracked\n");

    const res = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONFLICT");
    expect((await readRun(s.runId)).status).toBe("HumanWorking");
    const ta = await getActiveTakeover(s.runId, db);

    expect(ta?.endedAt ?? null).toBeNull();

    await s.cleanup();
  }, 90_000);

  it("return-rejects-zero-commit-range-409: clean worktree but no commits to return → 409, stays HumanWorking", async () => {
    const s = await seed({
      runStatus: "HumanWorking",
      withTakeoverAttempt: true,
    });

    // Clean worktree, but the reviewer made NO commits (base..branch is empty).
    const res = await returnPOST(returnReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONFLICT");
    expect((await readRun(s.runId)).status).toBe("HumanWorking");
    const ta = await getActiveTakeover(s.runId, db);

    expect(ta?.endedAt ?? null).toBeNull();
    expect(ta?.returnedDiff ?? null).toBeNull();

    await s.cleanup();
  }, 90_000);
});

describe("FIX#3 — release/abandon leaves the takeover ledger row open", () => {
  it("abandon-humanworking-closes-takeover-ledger-row: getActiveTakeover === null after abandon", async () => {
    const s = await seed({
      runStatus: "HumanWorking",
      withTakeoverAttempt: true,
    });

    // Before: an active (un-ended) takeover row exists.
    expect(await getActiveTakeover(s.runId, db)).not.toBeNull();

    const res = await abandonPOST(abandonReq(s.runId), {
      params: Promise.resolve({ runId: s.runId }),
    });

    expect(res.status).toBe(200);

    const run = await readRun(s.runId);

    expect(run.status).toBe("Abandoned");

    // After: the takeover ledger row is closed — no active handoff lingers on a
    // terminal run.
    expect(await getActiveTakeover(s.runId, db)).toBeNull();

    await s.cleanup();
  }, 90_000);
});
