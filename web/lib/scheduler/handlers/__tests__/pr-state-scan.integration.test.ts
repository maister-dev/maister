import type { PrStateReadResult } from "@/lib/runs/pr-adapter";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as schema from "@/lib/db/schema";
import { getPrState } from "@/lib/runs/pr-adapter";
import { runPrStateScanJob } from "@/lib/scheduler/handlers/pr-state-scan";
import { prStateScanJobId } from "@/lib/scheduler/jobs";
import { runSchedulerTick } from "@/lib/scheduler/tick-service";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// FR-A5: the scanner is a pure provider-read + DB job — it must NEVER reach the
// supervisor client (no session launch, no checkpoint). Spy the launch surface
// so a regression that adds such a call is caught; assert every spy stays cold.
// `vi.hoisted` so the shared spies exist before the hoisted `vi.mock` factory.
const supervisorSpies = vi.hoisted(() => ({
  createSession: vi.fn(),
  sendPrompt: vi.fn(),
  deleteSession: vi.fn(),
  deleteSessionIfPresent: vi.fn(),
  checkpointSession: vi.fn(),
}));

vi.mock("@/lib/supervisor-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/supervisor-client")>();

  return { ...actual, ...supervisorSpies };
});

// The scheduler-tick path calls the REAL getPrState (there is no DI seam once a
// job is claimed), so mock the provider boundary to keep the wiring-seam test
// deterministic and free of live network / tokens. Direct-call tests inject
// their own scripted reader and never exercise this mock.
vi.mock("@/lib/runs/pr-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runs/pr-adapter")>();

  return { ...actual, getPrState: vi.fn() };
});

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schema>;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "pr_state_scan_test",
  });
  db = testDatabase.db;
}, 180_000);

afterEach(async () => {
  vi.clearAllMocks();
  await db.delete(schema.webhookEvents);
  await db.delete(schema.taskActivity);
  await db.delete(schema.workspaces);
  await db.delete(schema.runs);
  await db.delete(schema.tasks);
  await db.delete(schema.schedulerJobRuns);
  await db.delete(schema.schedulerJobs);
  await db.delete(schema.projects);
});

afterAll(async () => {
  await testDatabase?.stop();
});

const OPEN: PrStateReadResult = {
  kind: "state",
  state: "open",
  mergedAt: null,
  mergeCommitSha: null,
  hasConflicts: null,
};

describe("runPrStateScanJob", () => {
  it("applies the merged, closed, and conflicts edges with one webhook each and a merged task_activity, without touching the supervisor or runs.merge_commit_sha", async () => {
    const projectId = await seedProject();
    const merged = await seedCandidate({
      projectId,
      prNumber: 101,
      withTask: true,
    });
    const closed = await seedCandidate({ projectId, prNumber: 102 });
    const conflicting = await seedCandidate({ projectId, prNumber: 103 });

    const summary = await runPrStateScanJob({
      projectId,
      db,
      getPrState: scripted({
        101: {
          kind: "state",
          state: "merged",
          mergedAt: "2026-07-14T00:00:00.000Z",
          mergeCommitSha: "merge-sha-101",
          hasConflicts: false,
        },
        102: {
          kind: "state",
          state: "closed",
          mergedAt: null,
          mergeCommitSha: null,
          hasConflicts: null,
        },
        103: {
          kind: "state",
          state: "open",
          mergedAt: null,
          mergeCommitSha: null,
          hasConflicts: true,
        },
      }),
    });

    expect(summary).toMatchObject({ scanned: 3, updated: 3, skipped: 0 });

    const mergedWs = await workspace(merged.workspaceId);
    const closedWs = await workspace(closed.workspaceId);
    const conflictWs = await workspace(conflicting.workspaceId);

    expect(mergedWs.prState).toBe("merged");
    expect(mergedWs.prMergedAt?.toISOString()).toBe("2026-07-14T00:00:00.000Z");
    expect(mergedWs.prMergeCommitSha).toBe("merge-sha-101");
    expect(mergedWs.prStateCheckedAt).not.toBeNull();

    expect(closedWs.prState).toBe("closed");
    expect(closedWs.prStateCheckedAt).not.toBeNull();

    // An open PR is only stamped — pr_state stays as-is (NULL here), keeping the
    // row a candidate; the conflicts edge is what flips pr_has_conflicts.
    expect(conflictWs.prState).toBeNull();
    expect(conflictWs.prHasConflicts).toBe(true);
    expect(conflictWs.prStateCheckedAt).not.toBeNull();

    const events = await webhooks(projectId);

    expect(byType(events, "run.pr_merged")).toHaveLength(1);
    expect(byType(events, "run.pr_closed")).toHaveLength(1);
    expect(byType(events, "run.pr_conflicts")).toHaveLength(1);
    expect(byType(events, "run.pr_merged")[0].data).toMatchObject({
      prNumber: 101,
      mergeCommitSha: "merge-sha-101",
    });

    const activity = await db
      .select()
      .from(schema.taskActivity)
      .where(eq(schema.taskActivity.taskId, merged.taskId as string));

    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      eventKind: "run_pr_merged",
      actorType: "system",
      actorId: null,
      payload: { prNumber: 101 },
    });

    // FR-A5: the provider merge commit lives on the workspace ONLY; the run's
    // repo_delivery_scan-owned merge_commit_sha is never written here.
    const mergedRun = (
      await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, merged.runId))
    )[0];

    expect(mergedRun.mergeCommitSha).toBeNull();

    // FR-A5: no session launch / checkpoint of any kind.
    expect(supervisorSpies.createSession).not.toHaveBeenCalled();
    expect(supervisorSpies.sendPrompt).not.toHaveBeenCalled();
    expect(supervisorSpies.deleteSession).not.toHaveBeenCalled();
    expect(supervisorSpies.deleteSessionIfPresent).not.toHaveBeenCalled();
    expect(supervisorSpies.checkpointSession).not.toHaveBeenCalled();
  });

  it("is idempotent: a re-scan with the same results emits no new webhooks or activity", async () => {
    const projectId = await seedProject();
    const merged = await seedCandidate({
      projectId,
      prNumber: 201,
      withTask: true,
    });

    await seedCandidate({ projectId, prNumber: 202 });
    await seedCandidate({ projectId, prNumber: 203 });

    const reader = scripted({
      201: {
        kind: "state",
        state: "merged",
        mergedAt: "2026-07-14T00:00:00.000Z",
        mergeCommitSha: "merge-sha-201",
        hasConflicts: false,
      },
      202: {
        kind: "state",
        state: "closed",
        mergedAt: null,
        mergeCommitSha: null,
        hasConflicts: null,
      },
      203: {
        kind: "state",
        state: "open",
        mergedAt: null,
        mergeCommitSha: null,
        hasConflicts: true,
      },
    });

    const first = await runPrStateScanJob({
      projectId,
      db,
      getPrState: reader,
    });
    const afterFirst = await webhooks(projectId);

    const second = await runPrStateScanJob({
      projectId,
      db,
      getPrState: reader,
    });
    const afterSecond = await webhooks(projectId);

    expect(first).toMatchObject({ updated: 3 });
    // Second sweep: merged/closed rows dropped out of the candidate set; the
    // still-open conflicting row is re-read but its edge-guard blocks a re-emit.
    expect(second).toMatchObject({ scanned: 1, updated: 0 });
    expect(afterFirst).toHaveLength(3);
    expect(afterSecond).toHaveLength(3);

    const activity = await db
      .select()
      .from(schema.taskActivity)
      .where(eq(schema.taskActivity.taskId, merged.taskId as string));

    expect(activity).toHaveLength(1);
  });

  it("stamps a transient skip in place and closes a terminal skip without a webhook", async () => {
    const projectId = await seedProject();
    const transient = await seedCandidate({ projectId, prNumber: 301 });
    const terminal = await seedCandidate({ projectId, prNumber: 302 });

    const summary = await runPrStateScanJob({
      projectId,
      db,
      getPrState: scripted({
        301: { kind: "skip", transient: true, reason: "provider 502" },
        302: {
          kind: "skip",
          transient: false,
          reason: "gh pull request not found",
        },
      }),
    });

    expect(summary).toMatchObject({ scanned: 2, updated: 0, skipped: 2 });

    const transientWs = await workspace(transient.workspaceId);
    const terminalWs = await workspace(terminal.workspaceId);

    // Transient: checked_at stamped, state untouched — stays a candidate.
    expect(transientWs.prState).toBeNull();
    expect(transientWs.prStateCheckedAt).not.toBeNull();

    // Terminal: closed so it leaves the candidate set, but NO webhook.
    expect(terminalWs.prState).toBe("closed");
    expect(terminalWs.prStateCheckedAt).not.toBeNull();

    expect(await webhooks(projectId)).toHaveLength(0);

    // The transient row is still eligible next tick; the terminal one is not.
    const stillCandidate = await eligibleWorkspaceIds(projectId);

    expect(stillCandidate).toContain(transient.workspaceId);
    expect(stillCandidate).not.toContain(terminal.workspaceId);
  });

  it("excludes ineligible rows and resets the cursor after a short batch", async () => {
    const projectId = await seedProject();

    await ensurePrStateScanSeed();

    const openA = await seedCandidate({ projectId, prNumber: 401 });
    const openB = await seedCandidate({ projectId, prNumber: 402 });

    // Ineligible: already merged, a scratch run, and a promotion with no PR URL.
    await seedCandidate({ projectId, prNumber: 403, prState: "merged" });
    await seedCandidate({ projectId, prNumber: 404, runKind: "scratch" });
    await seedCandidate({ projectId, prNumber: 405, prUrl: null });

    const reader = vi.fn(async (_args: { prNumber: number }) => OPEN);
    const summary = await runPrStateScanJob({
      projectId,
      db,
      getPrState: reader as unknown as typeof getPrState,
    });

    expect(summary.scanned).toBe(2);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(reader.mock.calls.map((call) => call[0].prNumber).sort()).toEqual([
      401, 402,
    ]);

    const scanned = await eligibleWorkspaceIds(projectId);

    expect(scanned).toEqual(
      expect.arrayContaining([openA.workspaceId, openB.workspaceId]),
    );

    // A short (< batch cap) sweep resets the cursor so the next tick wraps.
    expect(await storedCursor(projectId)).toBeNull();
  });

  it("advances the cursor across a full batch and resumes past it on the next sweep", async () => {
    const projectId = await seedProject();

    await ensurePrStateScanSeed();
    await seedFullBatch(projectId);

    const first = await runPrStateScanJob({
      projectId,
      db,
      getPrState: scriptedOpen(),
    });

    expect(first.scanned).toBe(50);
    expect(first.cursor).toBe("pr-batch-049");
    expect(await storedCursor(projectId)).toBe("pr-batch-049");

    // The full batch left the cursor at the tail; every seeded row sorts at or
    // below it, so the next sweep resumes strictly after it and scans nothing.
    const second = await runPrStateScanJob({
      projectId,
      db,
      getPrState: scriptedOpen(),
    });

    expect(second.scanned).toBe(0);
  });

  it("returns unsupported_provider for a generic remote without stamping any candidate", async () => {
    const projectId = await seedProject({
      repoUrl: "https://git.internal.example/acme/app.git",
      provider: "generic",
    });
    const candidate = await seedCandidate({ projectId, prNumber: 601 });
    const reader = vi.fn(async () => OPEN);

    const summary = await runPrStateScanJob({
      projectId,
      db,
      getPrState: reader as unknown as typeof getPrState,
    });

    expect(summary).toMatchObject({
      scanned: 0,
      updated: 0,
      skipped: 1,
      reason: "unsupported_provider",
    });
    expect(reader).not.toHaveBeenCalled();

    const ws = await workspace(candidate.workspaceId);

    // A generic project carries no PR tracking — do not stamp.
    expect(ws.prStateCheckedAt).toBeNull();
    expect(ws.prState).toBeNull();
    expect(await webhooks(projectId)).toHaveLength(0);
  });

  it("throws PRECONDITION when the project remote cannot be resolved", async () => {
    const projectId = await seedProject({ repoUrl: null });

    await expect(
      runPrStateScanJob({ projectId, db, getPrState: scriptedOpen() }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("runs through the scheduler seed, claim, and dispatch path", async () => {
    const projectId = await seedProject();
    const { workspaceId, runId } = await seedCandidate({
      projectId,
      prNumber: 701,
      withTask: true,
    });

    vi.mocked(getPrState).mockResolvedValue({
      kind: "state",
      state: "merged",
      mergedAt: "2026-07-14T00:00:00.000Z",
      mergeCommitSha: "merge-sha-701",
      hasConflicts: false,
    });

    const tick = await runSchedulerTick({ jobKind: "pr_state_scan" });

    expect(tick).toMatchObject({
      claimedCount: 1,
      succeededCount: 1,
      failedCount: 0,
    });
    expect(tick.attempts).toContainEqual(
      expect.objectContaining({
        jobId: prStateScanJobId(projectId),
        jobKind: "pr_state_scan",
        status: "Succeeded",
      }),
    );

    // The claimed job actually drove the handler end-to-end.
    const ws = await workspace(workspaceId);

    expect(ws.prState).toBe("merged");
    expect(byType(await webhooks(projectId), "run.pr_merged")).toHaveLength(1);

    const run = (
      await db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    )[0];

    expect(run.mergeCommitSha).toBeNull();
  });
});

function scripted(
  script: Record<number, PrStateReadResult>,
): typeof getPrState {
  return (async ({ prNumber }: { prNumber: number }) => {
    const result = script[prNumber];

    if (!result)
      throw new Error(`no scripted PR-state result for #${prNumber}`);

    return result;
  }) as unknown as typeof getPrState;
}

function scriptedOpen(): typeof getPrState {
  return (async () => OPEN) as unknown as typeof getPrState;
}

async function seedProject(opts?: {
  repoUrl?: string | null;
  provider?: string;
}): Promise<string> {
  const projectId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `pr-${projectId.slice(0, 8)}`,
    name: "PR state scan",
    repoPath: `/repos/${projectId}`,
    repoUrl:
      opts?.repoUrl === undefined
        ? "https://github.com/acme/app.git"
        : opts.repoUrl,
    provider: opts?.provider ?? "github",
    taskKey: `PRS${projectId.replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    mainBranch: "main",
  });

  return projectId;
}

async function seedCandidate(opts: {
  projectId: string;
  prNumber: number;
  workspaceId?: string;
  withTask?: boolean;
  runKind?: "flow" | "scratch" | "agent";
  prState?: "open" | "merged" | "closed" | null;
  prUrl?: string | null;
}): Promise<{ runId: string; workspaceId: string; taskId: string | null }> {
  const runId = randomUUID();
  const workspaceId = opts.workspaceId ?? randomUUID();
  let taskId: string | null = null;

  if (opts.withTask) {
    taskId = randomUUID();
    await db.insert(schema.tasks).values({
      id: taskId,
      projectId: opts.projectId,
      number: opts.prNumber,
      title: `Task ${opts.prNumber}`,
      prompt: "ship it",
    });
  }

  await db.insert(schema.runs).values({
    id: runId,
    projectId: opts.projectId,
    taskId,
    runKind: opts.runKind ?? "flow",
    status: "Review",
    flowVersion: "v1.0.0",
    startedAt: new Date(),
  });

  await db.insert(schema.workspaces).values({
    id: workspaceId,
    runId,
    projectId: opts.projectId,
    branch: `maister/pr-${opts.prNumber}-${workspaceId.slice(0, 6)}`,
    worktreePath: `/tmp/wt-${workspaceId}`,
    parentRepoPath: `/repos/${opts.projectId}`,
    targetBranch: "main",
    prUrl:
      opts.prUrl === undefined
        ? `https://github.com/acme/app/pull/${opts.prNumber}`
        : opts.prUrl,
    prNumber: opts.prNumber,
    prState: opts.prState ?? null,
  });

  return { runId, workspaceId, taskId };
}

async function seedFullBatch(projectId: string): Promise<void> {
  const runRows = [];
  const workspaceRows = [];

  for (let i = 0; i < 50; i += 1) {
    const suffix = String(i).padStart(3, "0");
    const runId = `run-batch-${suffix}`;
    const workspaceId = `pr-batch-${suffix}`;

    runRows.push({
      id: runId,
      projectId,
      runKind: "flow" as const,
      status: "Review" as const,
      flowVersion: "v1.0.0",
      startedAt: new Date(),
    });
    workspaceRows.push({
      id: workspaceId,
      runId,
      projectId,
      branch: `maister/batch-${suffix}`,
      worktreePath: `/tmp/wt-batch-${suffix}`,
      parentRepoPath: `/repos/${projectId}`,
      targetBranch: "main",
      prUrl: `https://github.com/acme/app/pull/${1000 + i}`,
      prNumber: 1000 + i,
    });
  }

  await db.insert(schema.runs).values(runRows);
  await db.insert(schema.workspaces).values(workspaceRows);
}

async function ensurePrStateScanSeed(): Promise<void> {
  const { ensurePrStateScanJobs } = await import("@/lib/scheduler/jobs");

  await ensurePrStateScanJobs();
}

async function workspace(
  workspaceId: string,
): Promise<typeof schema.workspaces.$inferSelect> {
  return (
    await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
  )[0];
}

async function eligibleWorkspaceIds(projectId: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.projectId, projectId));

  return rows
    .filter(
      (row) =>
        row.prUrl !== null && (row.prState === null || row.prState === "open"),
    )
    .map((row) => row.id);
}

async function webhooks(
  projectId: string,
): Promise<Array<typeof schema.webhookEvents.$inferSelect>> {
  return db
    .select()
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.projectId, projectId));
}

function byType(
  events: Array<typeof schema.webhookEvents.$inferSelect>,
  type: string,
): Array<typeof schema.webhookEvents.$inferSelect> {
  return events.filter((event) => event.type === type);
}

async function storedCursor(projectId: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(schema.schedulerJobs)
    .where(eq(schema.schedulerJobs.id, prStateScanJobId(projectId)));
  const target = rows[0]?.target as { cursor?: unknown } | null;
  const cursor = target?.cursor ?? null;

  return typeof cursor === "string" ? cursor : null;
}
