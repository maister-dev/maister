// Task 7 (ADR-137/138): integration coverage for the PR-lifecycle DTO fields.
// getRunDetail + getBoardData (FlightCard) surface workspaces.pr_state /
// pr_has_conflicts; the ext getRunDTO additionally projects the LATEST
// run_sync_attempts row (by attempt desc) into `syncAttempt`.

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches board.integration.test.ts).
const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let getRunDetail: typeof import("@/lib/queries/run").getRunDetail;
let getBoardData: typeof import("@/lib/queries/board").getBoardData;
let getRunDTO: typeof import("@/lib/services/runs").getRunDTO;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "pr_state_dto_test",
  });

  db = testDatabase.db;

  ({ getRunDetail } = await import("@/lib/queries/run"));
  ({ getBoardData } = await import("@/lib/queries/board"));
  ({ getRunDTO } = await import("@/lib/services/runs"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

type SyncSeed = {
  attempt: number;
  strategy: "rebase" | "merge";
  mode: "mechanical" | "agent";
  phase: string;
  pushed: boolean;
  errorCode?: string | null;
};

async function seedRun(opts: {
  runStatus: "Review" | "Done";
  prState: "open" | "merged" | "closed" | null;
  prHasConflicts: boolean | null;
  syncs?: SyncSeed[];
}): Promise<{ projectId: string; runId: string; workspaceId: string }> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const workspaceId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: "PR State DTO Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "aif",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/aif",
    manifest: { schemaVersion: 1, name: "aif", nodes: [] },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "pr state task",
    prompt: "p",
    flowId,
    status: "InFlight",
    stage: "Backlog",
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    status: opts.runStatus,
    flowVersion: "v1.0.0",
    currentStepId: "review",
    endedAt: opts.runStatus === "Done" ? new Date() : undefined,
  });
  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
  });
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    projectId,
    runId,
    branch: "maister/pr-state-1",
    worktreePath: `/tmp/${slug}/wt`,
    parentRepoPath: `/tmp/${slug}`,
    prState: opts.prState,
    prHasConflicts: opts.prHasConflicts,
  });
  await db.insert(schema.nodeAttempts).values({
    id: randomUUID(),
    runId,
    nodeId: "review",
    nodeType: "check",
    attempt: 1,
    status: "Succeeded",
    startedAt: new Date("2026-05-31T10:00:00.000Z"),
  });

  for (const s of opts.syncs ?? []) {
    await db.insert(schema.runSyncAttempts).values({
      id: randomUUID(),
      runId,
      workspaceId,
      attempt: s.attempt,
      strategy: s.strategy,
      mode: s.mode,
      phase: s.phase,
      pushed: s.pushed,
      errorCode: s.errorCode ?? null,
    });
  }

  return { projectId, runId, workspaceId };
}

async function anyFlightCard(projectId: string, runId: string) {
  const board = await getBoardData(projectId);

  for (const col of Object.values(board.columns)) {
    const hit = col.flight.find((c) => c.runId === runId);

    if (hit) return hit;
  }

  return undefined;
}

describe("PR-lifecycle DTO fields (ADR-137/138)", () => {
  it("getRunDetail surfaces pr_state + pr_has_conflicts from the workspace", async () => {
    const { projectId, runId } = await seedRun({
      runStatus: "Review",
      prState: "open",
      prHasConflicts: true,
    });

    const detail = await getRunDetail(runId);

    expect(detail).not.toBeNull();
    expect(detail?.prState).toBe("open");
    expect(detail?.prHasConflicts).toBe(true);
    // projectId is used to keep the seed scoped; no direct assertion needed.
    expect(projectId).toBeTruthy();
  });

  it("getBoardData FlightCard carries pr_state + pr_has_conflicts", async () => {
    const { projectId, runId } = await seedRun({
      runStatus: "Review",
      prState: "open",
      prHasConflicts: true,
    });

    const card = await anyFlightCard(projectId, runId);

    expect(card).toBeDefined();
    expect(card?.prState).toBe("open");
    expect(card?.prHasConflicts).toBe(true);
  });

  it("getBoardData FlightCard reads a merged Done PR with no conflict", async () => {
    const { projectId, runId } = await seedRun({
      runStatus: "Done",
      prState: "merged",
      prHasConflicts: false,
    });

    const card = await anyFlightCard(projectId, runId);

    expect(card?.prState).toBe("merged");
    expect(card?.prHasConflicts).toBe(false);
  });

  it("getRunDTO projects pr fields + the LATEST sync attempt (by attempt desc)", async () => {
    const { projectId, runId } = await seedRun({
      runStatus: "Review",
      prState: "open",
      prHasConflicts: true,
      syncs: [
        {
          attempt: 1,
          strategy: "rebase",
          mode: "mechanical",
          phase: "failed",
          pushed: false,
          errorCode: "REBASE_CONFLICT",
        },
        {
          attempt: 2,
          strategy: "rebase",
          mode: "agent",
          phase: "pushing",
          pushed: true,
          errorCode: null,
        },
      ],
    });

    const dto = await getRunDTO(runId, projectId);

    expect(dto).not.toBeNull();
    expect(dto?.prState).toBe("open");
    expect(dto?.prHasConflicts).toBe(true);
    expect(dto?.syncAttempt).toEqual({
      attempt: 2,
      strategy: "rebase",
      mode: "agent",
      phase: "pushing",
      pushed: true,
      errorCode: null,
    });
  });

  it("getRunDTO returns syncAttempt=null when the run never synced", async () => {
    const { projectId, runId } = await seedRun({
      runStatus: "Done",
      prState: "merged",
      prHasConflicts: false,
    });

    const dto = await getRunDTO(runId, projectId);

    expect(dto?.prState).toBe("merged");
    expect(dto?.prHasConflicts).toBe(false);
    expect(dto?.syncAttempt).toBeNull();
  });
});
