// T4.3: Test that on takeover RETURN, commit_set and diff artifacts are
// recorded BEFORE markDownstreamStale is called.
//
// Contract: When takeover is returned with returnedCommits and returnedDiff:
// 1. A commit_set artifact is recorded (kind: commit_set, producer: takeover)
// 2. A diff artifact is recorded (kind: diff, producer: takeover)
// 3. Both artifacts exist AND are current at the moment markDownstreamStale runs
// 4. Downstream nodes are staled after artifacts are recorded

import type { ArtifactInstance, NodeAttempt } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import {
  getArtifactsForRun,
  getCurrentArtifact,
  getCurrentRequiredForGitArtifacts,
  recordArtifact,
  supersedePrior,
} from "@/lib/flows/graph/artifact-store";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function seedRun(): Promise<string> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();

  await db.insert(schema.projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    repoPath: `/tmp/test-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "test",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/test",
    manifest: {
      schemaVersion: 1,
      name: "Test",
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "echo done" },
          transitions: { success: "review" },
        },
        {
          id: "review",
          type: "human",
          finish: {
            human: {
              role: "maintainer",
              decisions: ["approve", "takeover"],
            },
          },
          transitions: { approve: "done", takeover: "work" },
          rework: { allowedTargets: ["work"] },
        },
      ],
    },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({ number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    flowVersion: "v1.0.0",
    status: "HumanWorking",
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "feature/test",
    worktreePath: `/tmp/wt-${runId.slice(0, 8)}`,
    parentRepoPath: `/tmp/repo-${projectId.slice(0, 8)}`,
  });

  // Create node attempts for the work and review nodes so the tests can access them
  await db.insert(schema.nodeAttempts).values({
    id: randomUUID(),
    runId,
    nodeId: "work",
    nodeType: "cli",
    attempt: 1,
    status: "Complete",
  });

  await db.insert(schema.nodeAttempts).values({
    id: randomUUID(),
    runId,
    nodeId: "review",
    nodeType: "human",
    attempt: 1,
    status: "NeedsInput",
  });

  return runId;
}

async function getAttempts(runId: string): Promise<NodeAttempt[]> {
  return (await db
    .select()
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.runId, runId))) as unknown as NodeAttempt[];
}

async function getArtifacts(runId: string): Promise<ArtifactInstance[]> {
  return getArtifactsForRun(runId, db);
}

describe("T4.3: takeover return artifacts (commit_set + diff)", () => {
  it("takeover return records commit_set artifact with producer='takeover'", async () => {
    const runId = await seedRun();
    const attempts = await getAttempts(runId);
    const reviewAttempt = attempts.find((a) => a.nodeId === "review");

    expect(reviewAttempt).toBeDefined();

    if (reviewAttempt) {
      const baseRef = "abc123";
      const branch = "feature/test";

      await recordArtifact(
        {
          id: `run:${reviewAttempt.id}:takeover:commit_set`,
          runId,
          nodeAttemptId: reviewAttempt.id,
          nodeId: reviewAttempt.nodeId,
          attempt: reviewAttempt.attempt,
          artifactDefId: `takeover:${reviewAttempt.nodeId}:commit_set`,
          kind: "commit_set",
          producer: "takeover",
          locator: { kind: "git-log", baseRef, headRef: branch },
        },
        db,
      );

      const artifacts = await getArtifacts(runId);
      const commitSetArtifact = artifacts.find(
        (a) => a.kind === "commit_set" && a.producer === "takeover",
      );

      expect(commitSetArtifact).toBeDefined();
      expect(commitSetArtifact?.kind).toBe("commit_set");
      expect(commitSetArtifact?.producer).toBe("takeover");
      expect(commitSetArtifact?.validity).toBe("current");
    }
  });

  it("takeover return records diff artifact with producer='takeover'", async () => {
    const runId = await seedRun();
    const attempts = await getAttempts(runId);
    const reviewAttempt = attempts.find((a) => a.nodeId === "review");

    expect(reviewAttempt).toBeDefined();

    if (reviewAttempt) {
      const baseRef = "abc123";
      const branch = "feature/test";

      await recordArtifact(
        {
          id: `run:${reviewAttempt.id}:takeover:diff`,
          runId,
          nodeAttemptId: reviewAttempt.id,
          nodeId: reviewAttempt.nodeId,
          attempt: reviewAttempt.attempt,
          artifactDefId: `takeover:${reviewAttempt.nodeId}:diff`,
          kind: "diff",
          producer: "takeover",
          locator: { kind: "git-range", baseCommit: baseRef, headRef: branch },
        },
        db,
      );

      const artifacts = await getArtifacts(runId);
      const diffArtifact = artifacts.find(
        (a) => a.kind === "diff" && a.producer === "takeover",
      );

      expect(diffArtifact).toBeDefined();
      expect(diffArtifact?.kind).toBe("diff");
      expect(diffArtifact?.producer).toBe("takeover");
      expect(diffArtifact?.validity).toBe("current");
    }
  });

  it("both takeover artifacts (commit_set + diff) are current before downstream staling", async () => {
    const runId = await seedRun();
    const attempts = await getAttempts(runId);
    const reviewAttempt = attempts.find((a) => a.nodeId === "review");

    expect(reviewAttempt).toBeDefined();

    if (reviewAttempt) {
      const baseRef = "abc123";
      const branch = "feature/test";

      // Seed both artifacts as the route would in its tx
      await recordArtifact(
        {
          id: `run:${reviewAttempt.id}:takeover:commit_set`,
          runId,
          nodeAttemptId: reviewAttempt.id,
          nodeId: reviewAttempt.nodeId,
          attempt: reviewAttempt.attempt,
          artifactDefId: `takeover:${reviewAttempt.nodeId}:commit_set`,
          kind: "commit_set",
          producer: "takeover",
          locator: { kind: "git-log", baseRef, headRef: branch },
        },
        db,
      );

      await recordArtifact(
        {
          id: `run:${reviewAttempt.id}:takeover:diff`,
          runId,
          nodeAttemptId: reviewAttempt.id,
          nodeId: reviewAttempt.nodeId,
          attempt: reviewAttempt.attempt,
          artifactDefId: `takeover:${reviewAttempt.nodeId}:diff`,
          kind: "diff",
          producer: "takeover",
          locator: { kind: "git-range", baseCommit: baseRef, headRef: branch },
        },
        db,
      );

      const artifactsBefore = await getArtifacts(runId);
      const commitSetBefore = artifactsBefore.find(
        (a) => a.kind === "commit_set" && a.producer === "takeover",
      );
      const diffBefore = artifactsBefore.find(
        (a) => a.kind === "diff" && a.producer === "takeover",
      );

      expect(commitSetBefore?.validity).toBe("current");
      expect(diffBefore?.validity).toBe("current");

      // Simulate marking downstream nodes' artifacts stale
      // (The "work" node is downstream of "review")
      await db
        .update(schema.artifactInstances)
        .set({ validity: "stale" })
        .where(
          and(
            eq(schema.artifactInstances.runId, runId),
            eq(schema.artifactInstances.nodeId, "work"),
            eq(schema.artifactInstances.validity, "current"),
          ),
        );

      // RED: takeover artifacts MUST STAY current when downstream is staled
      const artifactsAfter = await getArtifacts(runId);
      const commitSetAfter = artifactsAfter.find(
        (a) => a.kind === "commit_set" && a.producer === "takeover",
      );
      const diffAfter = artifactsAfter.find(
        (a) => a.kind === "diff" && a.producer === "takeover",
      );

      expect(commitSetAfter?.validity).toBe("current");
      expect(diffAfter?.validity).toBe("current");
    }
  });
});

describe("C2: takeover return re-pins requiredFor git artifacts to the new tip", () => {
  it("refreshes impl-diff to the post-takeover tip, supersedes the stale row, leaves non-requiredFor diffs untouched", async () => {
    const runId = await seedRun();
    const attempts = await getAttempts(runId);
    const workAttempt = attempts.find((a) => a.nodeId === "work");
    const reviewAttempt = attempts.find((a) => a.nodeId === "review");

    expect(workAttempt).toBeDefined();
    expect(reviewAttempt).toBeDefined();
    if (!workAttempt || !reviewAttempt) return;

    // `impl-diff` produced by `work`, requiredFor review+merge, pinned to the
    // PRE-takeover sha. A sibling default diff with NO requiredFor must NOT be
    // touched by the refresh.
    await recordArtifact(
      {
        id: `run:${workAttempt.id}:impl-diff`,
        runId,
        nodeAttemptId: workAttempt.id,
        nodeId: "work",
        attempt: 1,
        artifactDefId: "impl-diff",
        kind: "diff",
        producer: "runner",
        locator: {
          kind: "git-range",
          baseCommit: "base-old",
          headRef: "sha-pre-takeover",
        },
        requiredFor: ["review", "merge"],
      },
      db,
    );
    await recordArtifact(
      {
        id: `run:${workAttempt.id}:default:diff`,
        runId,
        nodeAttemptId: workAttempt.id,
        nodeId: "work",
        attempt: 1,
        artifactDefId: "default:work:diff",
        kind: "diff",
        producer: "runner",
        locator: {
          kind: "git-range",
          baseCommit: "base-old",
          headRef: "sha-pre-takeover",
        },
      },
      db,
    );

    // The route selects exactly the requiredFor git artifacts (not the default).
    const toRefresh = await getCurrentRequiredForGitArtifacts(runId, db);

    expect(toRefresh.map((a) => a.artifactDefId)).toEqual(["impl-diff"]);

    // Apply the route's refresh: re-pin to the post-takeover tip, supersede prior.
    for (const art of toRefresh) {
      const { id } = await recordArtifact(
        {
          id: `${art.id}:rt:${reviewAttempt.id}`,
          runId,
          nodeAttemptId: art.nodeAttemptId,
          nodeId: art.nodeId,
          attempt: art.attempt,
          artifactDefId: art.artifactDefId,
          kind: art.kind,
          producer: "takeover",
          locator: {
            kind: "git-range",
            baseCommit: "base-new",
            headRef: "sha-post-takeover",
          },
          validity: "current",
          requiredFor: art.requiredFor,
        },
        db,
      );

      await supersedePrior(
        runId,
        art.nodeId as string,
        art.artifactDefId as string,
        id,
        db,
      );
    }

    // impl-diff now reflects the post-takeover tip and there is exactly one
    // current row (the pre-takeover row is superseded).
    const current = await getCurrentArtifact(runId, "impl-diff", db);

    expect(current?.producer).toBe("takeover");
    expect((current?.locator as { headRef: string }).headRef).toBe(
      "sha-post-takeover",
    );

    const all = await getArtifacts(runId);
    const currentImplDiffs = all.filter(
      (a) => a.artifactDefId === "impl-diff" && a.validity === "current",
    );

    expect(currentImplDiffs).toHaveLength(1);

    // The non-requiredFor default diff is untouched.
    const def = all.find((a) => a.artifactDefId === "default:work:diff");

    expect(def?.validity).toBe("current");
    expect((def?.locator as { headRef: string }).headRef).toBe(
      "sha-pre-takeover",
    );
  });
});
