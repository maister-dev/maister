// Regression coverage for the dirty-resolution claim-first contract
// (ADR-079 X-2PC): the write-once CAS on hitl_requests.dirty_resolution
// lands BEFORE any git side-effect, so
//   - a raced loser gets CONFLICT without mutating the worktree (a raced
//     `discard` must never destroy work the winner's choice kept),
//   - a failed side-effect rolls the claim back and the gate stays open,
//   - a discard kills the gate-chat L3 baseline BEFORE re-materialization
//     (DD12 — no un-discard even when re-materialization fails).
// Git helpers are mocked (deterministic barriers); the DB is real Postgres.

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
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { resolveDirtyWorktree } from "@/lib/runs/dirty-resolution";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

const snapshotSpy = vi.fn();
const discardSpy = vi.fn();
const deleteChatCheckpointSpy = vi.fn();
const materializeSpy = vi.fn();

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/worktree", () => ({
  snapshotDirtyWorktree: (...a: unknown[]) => snapshotSpy(...a),
  discardWorktree: (...a: unknown[]) => discardSpy(...a),
}));
vi.mock("@/lib/flows/graph/workspace-checkpoint", () => ({
  deleteChatCheckpoint: (...a: unknown[]) => deleteChatCheckpointSpy(...a),
}));
vi.mock("@/lib/capabilities/materialize-bundle", () => ({
  materializeProjectBundlesIntoWorktree: (...a: unknown[]) =>
    materializeSpy(...a),
}));

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test_dirty_race")
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

beforeEach(() => {
  snapshotSpy.mockReset().mockResolvedValue(true);
  discardSpy.mockReset().mockResolvedValue(undefined);
  deleteChatCheckpointSpy.mockReset().mockResolvedValue(undefined);
  materializeSpy.mockReset().mockResolvedValue(undefined);
});

async function seedReviewPause(): Promise<{ runId: string; hitlId: string }> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const hitlId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    repoPath: `/tmp/fake-repo-${projectId}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    title: "Test task",
    prompt: "do",
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
    status: "NeedsInput",
    currentStepId: "review",
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: `maister/${runId.slice(0, 8)}`,
    worktreePath: `/tmp/fake-wt-${runId}`,
    parentRepoPath: `/tmp/fake-repo-${projectId}`,
    baseBranch: "main",
  });
  await db.insert(schema.hitlRequests).values({
    id: hitlId,
    runId,
    stepId: "review",
    kind: "human",
    schema: { review: true },
    prompt: "Review?",
  });

  return { runId, hitlId };
}

async function dirtyResolutionOf(hitlId: string): Promise<string | null> {
  const r = await pool.query(
    `SELECT dirty_resolution FROM hitl_requests WHERE id = $1`,
    [hitlId],
  );

  return r.rows[0].dirty_resolution as string | null;
}

describe("resolveDirtyWorktree — claim-first race protocol (X-2PC)", () => {
  it("two-racer commit vs discard: the loser conflicts BEFORE any git side-effect runs", async () => {
    const { runId, hitlId } = await seedReviewPause();

    let releaseGit!: () => void;
    const gitGate = new Promise<void>((resolve) => {
      releaseGit = resolve;
    });

    snapshotSpy.mockImplementation(async () => {
      await gitGate;

      return true;
    });
    discardSpy.mockImplementation(async () => {
      await gitGate;
    });

    const outcomes: Record<"commit" | "discard", string> = {
      commit: "pending",
      discard: "pending",
    };
    const pa = resolveDirtyWorktree({
      runId,
      hitlRequestId: hitlId,
      choice: "commit",
      db,
    }).then(
      () => {
        outcomes.commit = "won";
      },
      (e: unknown) => {
        outcomes.commit = (e as { code?: string }).code ?? "error";
      },
    );
    const pb = resolveDirtyWorktree({
      runId,
      hitlRequestId: hitlId,
      choice: "discard",
      db,
    }).then(
      () => {
        outcomes.discard = "won";
      },
      (e: unknown) => {
        outcomes.discard = (e as { code?: string }).code ?? "error";
      },
    );

    // The loser settles first — the winner is still parked inside its git
    // side-effect behind the gate. The loser must already hold CONFLICT and
    // must not have invoked ANY git helper.
    await Promise.race([pa, pb]);

    const settled = Object.values(outcomes).filter((o) => o !== "pending");

    expect(settled).toEqual(["CONFLICT"]);
    expect(snapshotSpy.mock.calls.length + discardSpy.mock.calls.length).toBe(
      1,
    );

    releaseGit();
    await Promise.all([pa, pb]);

    const winnerChoice = outcomes.commit === "won" ? "commit" : "discard";
    const loserOutcome =
      winnerChoice === "commit" ? outcomes.discard : outcomes.commit;

    expect(loserOutcome).toBe("CONFLICT");
    expect(await dirtyResolutionOf(hitlId)).toBe(winnerChoice);
    expect(snapshotSpy.mock.calls.length + discardSpy.mock.calls.length).toBe(
      1,
    );
  });

  it("rolls the claim back when the git side-effect fails — a retry can claim again", async () => {
    const { runId, hitlId } = await seedReviewPause();

    snapshotSpy.mockRejectedValueOnce(new Error("snapshot boom"));

    await expect(
      resolveDirtyWorktree({
        runId,
        hitlRequestId: hitlId,
        choice: "commit",
        db,
      }),
    ).rejects.toThrow("snapshot boom");

    expect(await dirtyResolutionOf(hitlId)).toBeNull();
    expect(deleteChatCheckpointSpy).not.toHaveBeenCalled();

    const out = await resolveDirtyWorktree({
      runId,
      hitlRequestId: hitlId,
      choice: "commit",
      db,
    });

    expect(out).toEqual({ choice: "commit", committed: true });
    expect(await dirtyResolutionOf(hitlId)).toBe("commit");
    expect(deleteChatCheckpointSpy).toHaveBeenCalledTimes(1);
  });

  it("discard kills the chat baseline BEFORE re-materialization, and a remat failure rolls the claim back (DD12)", async () => {
    const { runId, hitlId } = await seedReviewPause();

    const failingRematerialize = vi
      .fn()
      .mockRejectedValueOnce(new Error("remat boom"));

    await expect(
      resolveDirtyWorktree({
        runId,
        hitlRequestId: hitlId,
        choice: "discard",
        db,
        rematerialize: failingRematerialize,
      }),
    ).rejects.toThrow("remat boom");

    expect(discardSpy).toHaveBeenCalledTimes(1);
    expect(deleteChatCheckpointSpy).toHaveBeenCalledTimes(1);
    expect(deleteChatCheckpointSpy.mock.invocationCallOrder[0]).toBeLessThan(
      failingRematerialize.mock.invocationCallOrder[0],
    );
    expect(await dirtyResolutionOf(hitlId)).toBeNull();
  });

  it("refuses a resolved pause without touching git or recording a choice", async () => {
    const { runId, hitlId } = await seedReviewPause();

    snapshotSpy.mockImplementationOnce(async () => {
      throw new Error("unreachable — a resolved pause must refuse before git");
    });
    await pool.query(
      `UPDATE hitl_requests SET responded_at = now() WHERE id = $1`,
      [hitlId],
    );

    await expect(
      resolveDirtyWorktree({
        runId,
        hitlRequestId: hitlId,
        choice: "commit",
        db,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    expect(snapshotSpy).not.toHaveBeenCalled();
    expect(await dirtyResolutionOf(hitlId)).toBeNull();
  });
});
