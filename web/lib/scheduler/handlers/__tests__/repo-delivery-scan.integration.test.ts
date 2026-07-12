import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

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
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as schema from "@/lib/db/schema";
import {
  REPO_DELIVERY_WINDOW_DAYS,
  runRepoDeliveryScanJob,
} from "@/lib/scheduler/handlers/repo-delivery-scan";
import { runSchedulerTick } from "@/lib/scheduler/tick-service";

const execFileAsync = promisify(execFile);

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let root: string | undefined;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("repo_delivery_scan_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema });

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterEach(async () => {
  await db.delete(schema.repoDeliveryRollups);
  await db.delete(schema.schedulerJobRuns);
  await db.delete(schema.schedulerJobs);
  await db.delete(schema.projects);

  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("runRepoDeliveryScanJob", () => {
  it("runs through the scheduler seed, claim, and dispatch path", async () => {
    const fixture = await createProjectFixture();

    const tick = await runSchedulerTick({ jobKind: "repo_delivery_scan" });
    const rollups = await db
      .select()
      .from(schema.repoDeliveryRollups)
      .where(eq(schema.repoDeliveryRollups.projectId, fixture.projectId));

    expect(tick).toMatchObject({
      claimedCount: 1,
      succeededCount: 1,
      failedCount: 0,
    });
    expect(tick.attempts).toEqual([
      expect.objectContaining({
        jobId: `repo_delivery_scan.${fixture.projectId}`,
        jobKind: "repo_delivery_scan",
        status: "Succeeded",
      }),
    ]);
    expect(rollups).toHaveLength(REPO_DELIVERY_WINDOW_DAYS);
  });

  it("fetches the newer origin target, cleans excluded paths, and atomically replaces all daily buckets", async () => {
    const fixture = await createProjectFixture();
    const now = new Date();

    const summary = await runRepoDeliveryScanJob({
      projectId: fixture.projectId,
      now,
      db,
    });
    const rows = await db
      .select()
      .from(schema.repoDeliveryRollups)
      .where(eq(schema.repoDeliveryRollups.projectId, fixture.projectId));

    expect(summary).toMatchObject({
      projectId: fixture.projectId,
      branch: "main",
      headSha: fixture.remoteHead,
      bucketCount: REPO_DELIVERY_WINDOW_DAYS,
    });
    expect(rows).toHaveLength(REPO_DELIVERY_WINDOW_DAYS);
    expect(rows.every((row) => row.headSha === fixture.remoteHead)).toBe(true);
    expect(sum(rows.map((row) => row.additions))).toBe(2);
    expect(sum(rows.map((row) => row.deletions))).toBe(0);
    expect(sum(rows.map((row) => row.commits))).toBe(2);
  });

  it("records a provider-backed PR target only after it is found in fetched target history", async () => {
    const fixture = await createProjectFixture();
    const now = new Date();
    const runId = await seedPullRequestRun({ fixture, now, prNumber: 77 });

    await runRepoDeliveryScanJob({
      projectId: fixture.projectId,
      now,
      db,
      prHistoryLookup: async (input) => {
        expect(input).toMatchObject({ provider: "github", prNumber: 77 });

        return { state: "resolved", targetSha: fixture.remoteHead };
      },
    });

    const run = (
      await db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    )[0];
    const rows = await db
      .select()
      .from(schema.repoDeliveryRollups)
      .where(eq(schema.repoDeliveryRollups.projectId, fixture.projectId));
    const ref = rows
      .flatMap((row) => row.deliveryRefs)
      .find((entry) => entry.sha === fixture.remoteHead);

    expect(run).toMatchObject({
      promotedHeadSha: fixture.remoteHead,
      mergeCommitSha: fixture.remoteHead,
      diffStat: { files: 1, additions: 1, deletions: 0 },
    });
    expect(ref).toMatchObject({
      sha: fixture.remoteHead,
      prNumber: 77,
      diffStat: { files: 1, additions: 1, deletions: 0 },
    });
    expect(rows.every((row) => row.providerComplete)).toBe(true);
    expect(sum(rows.map((row) => row.mergePrUnits))).toBe(1);
  });

  it("does not carry resolved PR evidence outside the fetched target-history horizon", async () => {
    const fixture = await createProjectFixture();
    const now = new Date();
    const runId = await seedPullRequestRun({ fixture, now, prNumber: 78 });

    await runRepoDeliveryScanJob({
      projectId: fixture.projectId,
      now,
      db,
      prHistoryLookup: async () => ({
        state: "resolved",
        targetSha: "deadbeef",
      }),
    });

    const run = (
      await db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    )[0];
    const rows = await db
      .select()
      .from(schema.repoDeliveryRollups)
      .where(eq(schema.repoDeliveryRollups.projectId, fixture.projectId));

    expect(run).toMatchObject({
      promotedHeadSha: "source-branch-sha",
      mergeCommitSha: null,
      diffStat: null,
    });
    expect(rows.every((row) => row.providerComplete)).toBe(true);
    expect(
      rows
        .flatMap((row) => row.deliveryRefs)
        .some((ref) => ref.prNumber === 78),
    ).toBe(false);
  });

  it("resolves a post-cutover PR opened before the rolling window when its target merge is in fetched history", async () => {
    const fixture = await createProjectFixture();
    const now = new Date();
    const runId = await seedPullRequestRun({
      fixture,
      now,
      prNumber: 79,
      promotedAt: new Date(now.getTime() - 366 * 24 * 60 * 60 * 1_000),
    });

    await runRepoDeliveryScanJob({
      projectId: fixture.projectId,
      now,
      db,
      prHistoryLookup: async () => ({
        state: "resolved",
        targetSha: fixture.remoteHead,
      }),
    });

    const run = (
      await db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    )[0];
    const refs = (
      await db
        .select()
        .from(schema.repoDeliveryRollups)
        .where(eq(schema.repoDeliveryRollups.projectId, fixture.projectId))
    ).flatMap((row) => row.deliveryRefs);

    expect(run).toMatchObject({
      promotedHeadSha: fixture.remoteHead,
      mergeCommitSha: fixture.remoteHead,
      diffStat: { files: 1, additions: 1, deletions: 0 },
    });
    expect(refs).toContainEqual(
      expect.objectContaining({ sha: fixture.remoteHead, prNumber: 79 }),
    );
  });

  it("does not look up a pre-cutover PR without provisional delivery evidence", async () => {
    const fixture = await createProjectFixture();
    const lookup = vi.fn(async () => ({
      state: "resolved" as const,
      targetSha: fixture.remoteHead,
    }));

    await seedPullRequestRun({
      fixture,
      now: new Date(),
      prNumber: 80,
      sourceHead: null,
    });
    await runRepoDeliveryScanJob({
      projectId: fixture.projectId,
      now: new Date(),
      db,
      prHistoryLookup: lookup,
    });

    expect(lookup).not.toHaveBeenCalled();
  });

  it("preserves the prior cache when origin fetch fails", async () => {
    const fixture = await createProjectFixture();
    const now = new Date();

    await runRepoDeliveryScanJob({ projectId: fixture.projectId, now, db });
    const before = await db
      .select()
      .from(schema.repoDeliveryRollups)
      .where(eq(schema.repoDeliveryRollups.projectId, fixture.projectId));

    await git(fixture.clone, [
      "remote",
      "set-url",
      "origin",
      join(fixture.root, "missing-origin.git"),
    ]);

    await expect(
      runRepoDeliveryScanJob({ projectId: fixture.projectId, now, db }),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });

    const after = await db
      .select()
      .from(schema.repoDeliveryRollups)
      .where(eq(schema.repoDeliveryRollups.projectId, fixture.projectId));

    expect(after).toEqual(before);
  });

  it("records a missing origin as this project's bounded scheduler failure", async () => {
    const fixture = await createProjectFixture();

    await git(fixture.clone, [
      "remote",
      "set-url",
      "origin",
      join(fixture.root, "missing-origin.git"),
    ]);

    const tick = await runSchedulerTick({ jobKind: "repo_delivery_scan" });
    const job = (
      await db
        .select()
        .from(schema.schedulerJobs)
        .where(
          eq(
            schema.schedulerJobs.id,
            `repo_delivery_scan.${fixture.projectId}`,
          ),
        )
    )[0];

    expect(tick).toMatchObject({ claimedCount: 1, failedCount: 1 });
    expect(tick.attempts[0]).toMatchObject({
      jobKind: "repo_delivery_scan",
      status: "Failed",
      errorCode: "EXECUTOR_UNAVAILABLE",
    });
    expect(job.consecutiveFailures).toBe(1);
  });
});

async function createProjectFixture(): Promise<{
  clone: string;
  projectId: string;
  remoteHead: string;
  root: string;
}> {
  root = await mkdtemp(join(tmpdir(), "repo-delivery-scan-"));
  const work = join(root, "work");
  const bare = join(root, "origin.git");
  const clone = join(root, "clone");
  const pusher = join(root, "pusher");

  await mkdir(work, { recursive: true });
  await git(work, ["init", "-b", "main"]);
  await git(work, ["config", "user.email", "test@example.test"]);
  await git(work, ["config", "user.name", "Test User"]);
  await writeFile(join(work, "README.md"), "initial\n");
  await git(work, ["add", "README.md"]);
  await git(work, ["commit", "-m", "initial"]);
  await git(root, ["clone", "--bare", work, bare]);
  await git(root, ["clone", bare, clone]);
  await git(root, ["clone", bare, pusher]);
  await git(pusher, ["config", "user.email", "test@example.test"]);
  await git(pusher, ["config", "user.name", "Test User"]);
  await mkdir(join(pusher, "src"), { recursive: true });
  await writeFile(
    join(pusher, "src", "delivered.ts"),
    "export const shipped = true;\n",
  );
  await writeFile(join(pusher, "pnpm-lock.yaml"), "ignored lock\n");
  await git(pusher, ["add", "src/delivered.ts", "pnpm-lock.yaml"]);
  await git(pusher, ["commit", "-m", "feat: remote delivery"]);
  await git(pusher, ["push", "origin", "main"]);
  const remoteHead = (await git(pusher, ["rev-parse", "HEAD"])).stdout.trim();
  const projectId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `scan-${projectId.slice(0, 8)}`,
    name: "Repository delivery scan",
    repoPath: clone,
    taskKey: `SCAN${projectId.replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    mainBranch: "main",
  });

  return { clone, projectId, remoteHead, root };
}

async function seedPullRequestRun(input: {
  fixture: Awaited<ReturnType<typeof createProjectFixture>>;
  now: Date;
  prNumber: number;
  promotedAt?: Date;
  sourceHead?: string | null;
}): Promise<string> {
  const runId = randomUUID();

  await db
    .update(schema.projects)
    .set({ provider: "github" })
    .where(eq(schema.projects.id, input.fixture.projectId));
  await db.insert(schema.runs).values({
    id: runId,
    projectId: input.fixture.projectId,
    runKind: "flow",
    status: "Done",
    flowVersion: "v1.0.0",
    startedAt: input.now,
    endedAt: input.now,
    promotedHeadSha:
      input.sourceHead === undefined ? "source-branch-sha" : input.sourceHead,
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId: input.fixture.projectId,
    branch: `maister/pr-evidence-${input.prNumber}`,
    worktreePath: join(input.fixture.root, `pr-worktree-${input.prNumber}`),
    parentRepoPath: input.fixture.clone,
    targetBranch: "main",
    promotionState: "done",
    promotedAt: input.promotedAt ?? input.now,
    prNumber: input.prNumber,
  });

  return runId;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

async function git(
  cwd: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd });
}
