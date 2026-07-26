import type { TokenActor } from "@/lib/tokens/verify";

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, inArray } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof fullSchema>;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();

  return {
    ...actual,
    tryStartRun: vi.fn(async () => ({ started: false, queuePosition: 1 })),
    promoteNextPending: vi.fn(async () => null),
  };
});

let provisionJudgeAttempts: typeof import("@/lib/evaluations/judges/launch").provisionJudgeAttempts;
let evaluateAndAdvancePanel: typeof import("@/lib/evaluations/aggregation/worker").evaluateAndAdvancePanel;
let submitBoundJudgeResult: typeof import("@/lib/evaluations/judges/seal").submitBoundJudgeResult;
let issueJudgeAttemptToken: typeof import("@/lib/agents/tokens").issueJudgeAttemptToken;
let sealEvidenceSnapshot: typeof import("@/lib/evaluations/evidence/snapshots").sealEvidenceSnapshot;
let frozenExecutionParticipants: typeof import("@/lib/evaluations/frozen-participants").frozenExecutionParticipants;

const AGENT_ID = "core:pairwise-judge";

// A pairwise method: 1 criterion (methods always carry ≥1), 1 judge role at
// count 2 (two picks per match), per-match quorum 2.
const PAIRWISE_DEFINITION = {
  definition: {
    id: "head-to-head",
    modes: ["pairwise"],
    criteria: [
      { id: "overall", weight: 1, scale: { min: 0, max: 5 }, optional: false },
    ],
    judges: { roles: [{ id: "reviewer", count: 2 }] },
    aggregation: { algorithm: "pairwise_tournament@1" },
    panelPolicy: { quorum: 2 },
    caps: {},
    objectiveChecks: [],
  },
  criteria: [{ id: "overall", normalizedWeight: 1 }],
};

let projectId: string;
let taskId: string;
let methodRevisionId: string;

// Each test gets its OWN study so its participant set (study-scoped) never bleeds
// into another test's execution — the pairwise fan-out reads every non-removed
// participant of the study.
async function freshStudy(): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.evaluationStudies).values({
    id,
    projectId,
    taskId,
    title: "Study",
    status: "open",
  });

  return id;
}

function aggregationSnapshot(): Record<string, unknown> {
  return {
    algorithm: "pairwise_tournament@1",
    quorum: 2,
    totalMax: null,
    gateCheckIds: [],
    definitionDigest: "dd",
    schemaDigest: "sd",
  };
}

function judgeSnapshot(): Record<string, unknown> {
  return {
    roleBindings: [{ role: "reviewer", agentId: AGENT_ID }],
    policy: { quorum: 2 },
    criteria: [
      {
        id: "overall",
        weight: 1,
        normalizedWeight: 1,
        scaleMin: 0,
        scaleMax: 5,
        optional: false,
        itemCap: null,
      },
    ],
  };
}

async function seedExecution(
  studyId: string,
  opts: { snapshotId?: string } = {},
): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.evaluationExecutions).values({
    id,
    studyId,
    status: "judging",
    methodRevisionId,
    evidenceSnapshotId: opts.snapshotId ?? null,
    randomizationSeed: `seed-${id.slice(0, 8)}`,
    judgePolicySnapshot: judgeSnapshot(),
    aggregationPolicySnapshot: aggregationSnapshot(),
  });

  return id;
}

// Seal a minimal snapshot whose participantWatermarks keys ARE the frozen
// participant set (Codex-4). No items — the frozen derivation reads keys only.
async function sealSnapshotFor(
  studyId: string,
  participantIds: string[],
): Promise<string> {
  const sealed = await sealEvidenceSnapshot(
    {
      studyId,
      participantWatermarks: Object.fromEntries(
        participantIds.map((id) => [id, { runId: null }]),
      ),
      evidenceProtocolDigest: `epd-${randomUUID()}`,
      items: [],
    },
    db,
  );

  return sealed.snapshotId;
}

async function seedParticipants(
  studyId: string,
  labels: string[],
): Promise<string[]> {
  const ids: string[] = [];

  for (const [index, label] of labels.entries()) {
    const id = randomUUID();

    await db.insert(schema.evaluationParticipants).values({
      id,
      studyId,
      sourceType: "observed",
      label,
      displayOrder: index + 1,
    });
    ids.push(id);
  }

  return ids;
}

async function sealPick(
  attemptId: string,
  winner: "a" | "b" | "tie",
): Promise<void> {
  await db
    .update(schema.evaluationJudgeAttempts)
    .set({
      status: "completed",
      sealedResult: { winner },
      terminalAt: new Date(),
    })
    .where(eq(schema.evaluationJudgeAttempts.id, attemptId));
}

async function sealTimeout(attemptId: string): Promise<void> {
  await db
    .update(schema.evaluationJudgeAttempts)
    .set({ status: "timed_out", terminalAt: new Date() })
    .where(eq(schema.evaluationJudgeAttempts.id, attemptId));
}

async function executionStatus(executionId: string): Promise<string> {
  const [row] = await db
    .select({ status: schema.evaluationExecutions.status })
    .from(schema.evaluationExecutions)
    .where(eq(schema.evaluationExecutions.id, executionId));

  return row.status as string;
}

async function latestAggregate(
  executionId: string,
): Promise<Record<string, any> | undefined> {
  const rows = await db
    .select()
    .from(schema.evaluationAggregateResults)
    .where(eq(schema.evaluationAggregateResults.executionId, executionId));

  return rows[0] as Record<string, any> | undefined;
}

beforeAll(async () => {
  process.env.MAISTER_WORKTREES_ROOT = await mkdtemp(
    join(tmpdir(), "maister-pairwise-wt-"),
  );
  const packageRoot = await mkdtemp(join(tmpdir(), "maister-pairwise-pkg-"));

  await mkdir(join(packageRoot, "maister-agents"), { recursive: true });
  await writeFile(
    join(packageRoot, "maister-agents", "pairwise-judge.md"),
    `---
name: pairwise-judge
description: Pairwise judge
workspace: none
mode: session
triggers:
  - manual
risk_tier: read_only
---
Pick the better of the two candidates.
`,
    "utf8",
  );

  testDatabase = await startMainPostgresTestDb({
    databaseName: "pairwise_execution_test",
  });
  db = testDatabase.db;

  ({ provisionJudgeAttempts } = await import(
    "@/lib/evaluations/judges/launch"
  ));
  ({ evaluateAndAdvancePanel } = await import(
    "@/lib/evaluations/aggregation/worker"
  ));
  ({ submitBoundJudgeResult } = await import("@/lib/evaluations/judges/seal"));
  ({ issueJudgeAttemptToken } = await import("@/lib/agents/tokens"));
  ({ sealEvidenceSnapshot } = await import(
    "@/lib/evaluations/evidence/snapshots"
  ));
  ({ frozenExecutionParticipants } = await import(
    "@/lib/evaluations/frozen-participants"
  ));

  projectId = randomUUID();
  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });

  const runnerId = randomUUID();

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));
  await db
    .insert(schema.platformRuntimeSettings)
    .values({ id: "singleton", defaultRunnerId: runnerId })
    .onConflictDoUpdate({
      target: schema.platformRuntimeSettings.id,
      set: { defaultRunnerId: runnerId },
    });

  const installId = randomUUID();

  await db.insert(schema.packageInstalls).values({
    id: installId,
    sourceUrl: "github.com/x/core",
    name: "core",
    versionLabel: "v1.1.0",
    resolvedRevision: "deadbeef",
    manifest: { spec: { name: "core" } },
    manifestDigest: "d",
    installedPath: packageRoot,
    packageStatus: "Installed",
    trustStatus: "trusted",
  });
  await db.insert(schema.projectPackageAttachments).values({
    id: randomUUID(),
    projectId,
    packageInstallId: installId,
    packageName: "core",
  });
  await db.insert(schema.agents).values({
    id: AGENT_ID,
    packageName: "core",
    versionLabel: "v1.1.0",
    origin: "git",
    name: "Pairwise Judge",
    description: "Pairwise judge",
    workspace: "none",
    mode: "session",
    triggers: ["manual"],
    riskTier: "read_only",
    sourcePath: join(packageRoot, "maister-agents", "pairwise-judge.md"),
  });
  await db.insert(schema.agentProjectLinks).values({
    id: randomUUID(),
    agentId: AGENT_ID,
    projectId,
  });

  const flowId = randomUUID();

  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", nodes: [] },
    schemaVersion: 1,
  });

  taskId = randomUUID();

  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id: taskId,
    projectId,
    title: "T",
    prompt: "p",
    flowId,
  });

  methodRevisionId = randomUUID();
  await db.insert(schema.evaluationMethodRevisions).values({
    id: methodRevisionId,
    packageInstallId: installId,
    methodId: "head-to-head",
    qualifiedId: "core:head-to-head",
    packageName: "core",
    versionLabel: "v1.1.0",
    schemaVersion: 1,
    normalizedDefinition: PAIRWISE_DEFINITION,
    definitionDigest: "dd",
    promptDigest: "pd",
    schemaDigest: "sd",
    compat: { engineMin: "3.2.0" },
    activation: "enabled",
  });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("pairwise provisioning", () => {
  it("provisions one attempt matrix per unordered participant pair", async () => {
    const studyId = await freshStudy();
    const participantIds = await seedParticipants(studyId, ["A", "B", "C"]);
    const snapshotId = await sealSnapshotFor(studyId, participantIds);
    const executionId = await seedExecution(studyId, { snapshotId });

    const attempts = await provisionJudgeAttempts(executionId, db);

    // 3 participants → 3 pairs × 1 role × count 2 = 6 attempts, all with a match.
    expect(attempts).toHaveLength(6);
    for (const a of attempts) {
      expect(a.matchA).not.toBeNull();
      expect(a.matchB).not.toBeNull();
    }

    const pairs = new Set(attempts.map((a) => `${a.matchA}::${a.matchB}`));

    expect(pairs.size).toBe(3);

    // Idempotent re-drive adopts, never double-provisions.
    const reprovisioned = await provisionJudgeAttempts(executionId, db);

    expect(reprovisioned).toHaveLength(6);
  });
});

describe("pairwise aggregation", () => {
  it("aggregates resolved matches into a tournament ranking → completed", async () => {
    const studyId = await freshStudy();
    const [p1, p2, p3] = await seedParticipants(studyId, ["A", "B", "C"]);
    const snapshotId = await sealSnapshotFor(studyId, [p1, p2, p3]);
    const executionId = await seedExecution(studyId, { snapshotId });
    const attempts = await provisionJudgeAttempts(executionId, db);
    const forPair = (a: string, b: string) =>
      attempts.filter((x) => x.matchA === a && x.matchB === b);

    // p1 beats p2 and p3; p2 beats p3. Both picks per match agree (quorum 2).
    for (const at of forPair(p1, p2)) await sealPick(at.id, "a");
    for (const at of forPair(p1, p3)) await sealPick(at.id, "a");
    for (const at of forPair(p2, p3)) await sealPick(at.id, "a");

    const advanced = await evaluateAndAdvancePanel(executionId, db);

    expect(advanced).toBe(true);
    expect(await executionStatus(executionId)).toBe("completed");

    const agg = await latestAggregate(executionId);

    expect(agg?.algorithmId).toBe("pairwise_tournament");
    const standings = (agg?.displayValues as any).standings as Array<{
      participantId: string;
      rank: number;
      wins: number;
    }>;
    const top = standings.find((s) => s.rank === 1);

    expect(top?.participantId).toBe(p1);
    expect(top?.wins).toBe(2);
    expect((agg?.displayValues as any).unresolvedMatchCount).toBe(0);
  });

  it("marks the execution partial when a match falls below its quorum", async () => {
    const studyId = await freshStudy();
    const [p1, p2, p3] = await seedParticipants(studyId, ["A", "B", "C"]);
    const snapshotId = await sealSnapshotFor(studyId, [p1, p2, p3]);
    const executionId = await seedExecution(studyId, { snapshotId });
    const attempts = await provisionJudgeAttempts(executionId, db);
    const forPair = (a: string, b: string) =>
      attempts.filter((x) => x.matchA === a && x.matchB === b);

    for (const at of forPair(p1, p2)) await sealPick(at.id, "a");
    for (const at of forPair(p1, p3)) await sealPick(at.id, "a");
    // The p2/p3 match gets only ONE pick (quorum is 2) — it stays unresolved.
    const p2p3 = forPair(p2, p3);

    await sealPick(p2p3[0].id, "a");
    await sealTimeout(p2p3[1].id);

    const advanced = await evaluateAndAdvancePanel(executionId, db);

    expect(advanced).toBe(true);
    expect(await executionStatus(executionId)).toBe("partial");

    const agg = await latestAggregate(executionId);

    expect((agg?.displayValues as any).unresolvedMatchCount).toBe(1);
    expect(agg?.warnings).toContain("quorum_not_met");
  });
});

describe("frozen participant set (Codex-4)", () => {
  it("refuses to provision a pairwise panel without a sealed evidence snapshot", async () => {
    const studyId = await freshStudy();
    const executionId = await seedExecution(studyId);

    await seedParticipants(studyId, ["A", "B"]);

    await expect(provisionJudgeAttempts(executionId, db)).rejects.toMatchObject(
      { code: "PRECONDITION" },
    );
  });

  it("derives the frozen set from watermark keys — ordered, tombstone-inclusive", async () => {
    const studyId = await freshStudy();
    const [p1, p2, p3] = await seedParticipants(studyId, ["A", "B", "C"]);
    const snapshotId = await sealSnapshotFor(studyId, [p1, p2, p3]);
    const executionId = await seedExecution(studyId, { snapshotId });

    // A mid-flight tombstone must NOT shrink the frozen set.
    await db
      .update(schema.evaluationParticipants)
      .set({ removedAt: new Date() })
      .where(eq(schema.evaluationParticipants.id, p2));

    const frozen = await frozenExecutionParticipants(executionId, db);

    expect(frozen.map((p) => p.id)).toEqual([p1, p2, p3]);
  });

  it("ignores a participant added mid-judging: no new pairs, no phantom standing", async () => {
    const studyId = await freshStudy();
    const [p1, p2, p3] = await seedParticipants(studyId, ["A", "B", "C"]);
    const snapshotId = await sealSnapshotFor(studyId, [p1, p2, p3]);
    const executionId = await seedExecution(studyId, { snapshotId });
    const attempts = await provisionJudgeAttempts(executionId, db);

    expect(attempts).toHaveLength(6);

    // Membership add DURING judging — inert to the sealed execution.
    const [p4] = await seedParticipants(studyId, ["D"]);
    const reprovisioned = await provisionJudgeAttempts(executionId, db);

    expect(reprovisioned).toHaveLength(6);

    for (const at of attempts) await sealPick(at.id, "a");
    const advanced = await evaluateAndAdvancePanel(executionId, db);

    expect(advanced).toBe(true);
    expect(await executionStatus(executionId)).toBe("completed");

    const agg = await latestAggregate(executionId);
    const standings = (agg?.displayValues as any).standings as Array<{
      participantId: string;
    }>;

    expect(standings).toHaveLength(3);
    expect(standings.map((s) => s.participantId)).not.toContain(p4);
  });

  it("keeps a tombstoned participant's matches and standing (no vanish)", async () => {
    const studyId = await freshStudy();
    const [p1, p2, p3] = await seedParticipants(studyId, ["A", "B", "C"]);
    const snapshotId = await sealSnapshotFor(studyId, [p1, p2, p3]);
    const executionId = await seedExecution(studyId, { snapshotId });
    const attempts = await provisionJudgeAttempts(executionId, db);

    // Every match resolves a-side: p1 2-0, p2 1-1, p3 0-2.
    for (const at of attempts) await sealPick(at.id, "a");

    // Tombstone p3 AFTER its matches completed, BEFORE aggregation.
    await db
      .update(schema.evaluationParticipants)
      .set({ removedAt: new Date() })
      .where(eq(schema.evaluationParticipants.id, p3));

    const advanced = await evaluateAndAdvancePanel(executionId, db);

    expect(advanced).toBe(true);
    expect(await executionStatus(executionId)).toBe("completed");

    const agg = await latestAggregate(executionId);
    const standings = (agg?.displayValues as any).standings as Array<{
      participantId: string;
      wins: number;
      losses: number;
    }>;

    expect(standings).toHaveLength(3);
    const p3Row = standings.find((s) => s.participantId === p3);

    expect(p3Row?.losses).toBe(2);
    const p1Row = standings.find((s) => s.participantId === p1);

    expect(p1Row?.wins).toBe(2);
  });

  it("stays partial when an expected frozen match has no recorded attempts", async () => {
    const studyId = await freshStudy();
    const [p1, p2, p3] = await seedParticipants(studyId, ["A", "B", "C"]);
    const snapshotId = await sealSnapshotFor(studyId, [p1, p2, p3]);
    const executionId = await seedExecution(studyId, { snapshotId });
    const attempts = await provisionJudgeAttempts(executionId, db);

    // Simulate a lost pair (crash mid-provision): the p2/p3 attempts vanish.
    const lostPair = attempts.filter((x) => x.matchA === p2 && x.matchB === p3);

    expect(lostPair).toHaveLength(2);
    await db.delete(schema.evaluationJudgeAttempts).where(
      inArray(
        schema.evaluationJudgeAttempts.id,
        lostPair.map((a) => a.id),
      ),
    );

    for (const at of attempts.filter((a) => !lostPair.includes(a))) {
      await sealPick(at.id, "a");
    }

    const advanced = await evaluateAndAdvancePanel(executionId, db);

    expect(advanced).toBe(true);
    // The frozen expected matrix (3 pairs) keeps the lost match unresolved —
    // the execution must NOT complete with a missing match.
    expect(await executionStatus(executionId)).toBe("partial");

    const agg = await latestAggregate(executionId);

    expect((agg?.displayValues as any).unresolvedMatchCount).toBe(1);
    expect(agg?.warnings).toContain("quorum_not_met");
  });
});

describe("pairwise pick submission (seal branch)", () => {
  async function boundActorFor(attemptId: string): Promise<TokenActor> {
    const token = await issueJudgeAttemptToken({
      agentId: AGENT_ID,
      projectId,
      runId: randomUUID(),
      db,
    });

    await db
      .update(schema.evaluationJudgeAttempts)
      .set({ tokenId: token.tokenId, status: "running", runningAt: new Date() })
      .where(eq(schema.evaluationJudgeAttempts.id, attemptId));

    return {
      tokenId: token.tokenId,
      projectId,
      tokenKind: "agent",
      ownerUserId: null,
      agentId: AGENT_ID,
      actorLabel: "judge",
      scopes: ["evaluations:result:submit"],
      boundRunId: null,
    };
  }

  it("seals a pairwise attempt (criteria + winner) as completed", async () => {
    const studyId = await freshStudy();
    const participantIds = await seedParticipants(studyId, ["A", "B", "C"]);
    const snapshotId = await sealSnapshotFor(studyId, participantIds);
    const executionId = await seedExecution(studyId, { snapshotId });
    const attempts = await provisionJudgeAttempts(executionId, db);
    const actor = await boundActorFor(attempts[0].id);

    const outcome = await submitBoundJudgeResult(
      actor,
      {
        winner: "a",
        criteria: [{ criterionId: "overall", state: "scored", score: 5 }],
      },
      db,
    );

    expect(outcome).toMatchObject({ valid: true, attemptId: attempts[0].id });

    const [row] = await db
      .select({
        status: schema.evaluationJudgeAttempts.status,
        sealedResult: schema.evaluationJudgeAttempts.sealedResult,
      })
      .from(schema.evaluationJudgeAttempts)
      .where(eq(schema.evaluationJudgeAttempts.id, attempts[0].id));

    expect(row.status).toBe("completed");
    expect((row.sealedResult as any).winner).toBe("a");
  });

  it("rejects a pairwise submission with no winner (422 CONFIG), attempt preserved", async () => {
    const studyId = await freshStudy();
    const participantIds = await seedParticipants(studyId, ["A", "B", "C"]);
    const snapshotId = await sealSnapshotFor(studyId, participantIds);
    const executionId = await seedExecution(studyId, { snapshotId });
    const attempts = await provisionJudgeAttempts(executionId, db);
    const actor = await boundActorFor(attempts[0].id);

    await expect(
      submitBoundJudgeResult(
        actor,
        { criteria: [{ criterionId: "overall", state: "scored", score: 5 }] },
        db,
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    // The attempt is NOT terminalized — the judge can resubmit with a winner.
    const [row] = await db
      .select({ status: schema.evaluationJudgeAttempts.status })
      .from(schema.evaluationJudgeAttempts)
      .where(eq(schema.evaluationJudgeAttempts.id, attempts[0].id));

    expect(row.status).toBe("running");
  });
});
