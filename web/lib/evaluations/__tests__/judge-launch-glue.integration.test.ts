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
import { TOKEN_SCOPES } from "@/types/token-scopes";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof fullSchema>;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
// The supervisor/ACP boundary: force tryStartRun to NOT promote, so the run row
// stays a stable Pending and the agent-session spawn microtask (the only
// supervisor touchpoint on this path) never fires. Everything below the seam —
// launchAgentRun's run insert, the crash-safe runId contract, and the real
// issueJudgeAttemptToken mint — runs for real against Testcontainers.
vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();

  return {
    ...actual,
    tryStartRun: vi.fn(async () => ({ started: false, queuePosition: 1 })),
    promoteNextPending: vi.fn(async () => null),
  };
});

let launchJudgePanel: typeof import("@/lib/evaluations/judges/launch").launchJudgePanel;
let provisionJudgeAttempts: typeof import("@/lib/evaluations/judges/launch").provisionJudgeAttempts;
let defaultJudgeSpawn: typeof import("@/lib/evaluations/judges/launch").defaultJudgeSpawn;
let issueJudgeAttemptToken: typeof import("@/lib/agents/tokens").issueJudgeAttemptToken;
let EVALUATION_JUDGE_TOKEN_SCOPES: typeof import("@/lib/agents/tokens").EVALUATION_JUDGE_TOKEN_SCOPES;

const AGENT_ID = "core:sdd-judge";
const EXPECTED_JUDGE_SCOPES = [
  "evaluations:context:read",
  "evaluations:evidence:read",
  "evaluations:objective:read",
  "evaluations:result:submit",
];

let projectId: string;
let studyId: string;
let methodRevisionId: string;

const NORMALIZED_DEFINITION = {
  definition: {
    id: "sdd-quality",
    criteria: [
      {
        id: "correctness",
        weight: 0.6,
        scale: { min: 0, max: 5 },
        optional: false,
      },
      {
        id: "maintainability",
        weight: 0.4,
        scale: { min: 0, max: 5 },
        optional: false,
      },
    ],
    judges: { roles: [{ id: "reviewer", count: 2 }] },
    aggregation: { algorithm: "weighted_mean@1" },
    panelPolicy: { quorum: 2 },
    caps: {},
    objectiveChecks: [],
  },
  criteria: [
    { id: "correctness", normalizedWeight: 0.6 },
    { id: "maintainability", normalizedWeight: 0.4 },
  ],
};

async function seedExecution(): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.evaluationExecutions).values({
    id,
    studyId,
    status: "judging",
    methodRevisionId,
    randomizationSeed: `seed-${id.slice(0, 8)}`,
    judgePolicySnapshot: {
      roleBindings: [{ role: "reviewer", agentId: AGENT_ID }],
    },
  });

  return id;
}

beforeAll(async () => {
  // workspace:none launches mkdir a per-run workdir under the worktrees root.
  process.env.MAISTER_WORKTREES_ROOT = await mkdtemp(
    join(tmpdir(), "maister-judge-glue-wt-"),
  );

  // The EFFECTIVE agent definition is resolved from the attached package
  // install's maister-agents/<stem>.md — materialize a real one on disk.
  const packageRoot = await mkdtemp(join(tmpdir(), "maister-judge-glue-pkg-"));

  await mkdir(join(packageRoot, "maister-agents"), { recursive: true });
  await writeFile(
    join(packageRoot, "maister-agents", "sdd-judge.md"),
    `---
name: sdd-judge
description: Evaluation judge
workspace: none
mode: session
triggers:
  - manual
risk_tier: read_only
---
Judge the bound evidence snapshot.
`,
    "utf8",
  );

  testDatabase = await startMainPostgresTestDb({
    databaseName: "judge_launch_glue_test",
  });
  db = testDatabase.db;

  ({ launchJudgePanel, provisionJudgeAttempts, defaultJudgeSpawn } =
    await import("@/lib/evaluations/judges/launch"));
  ({ issueJudgeAttemptToken, EVALUATION_JUDGE_TOKEN_SCOPES } = await import(
    "@/lib/agents/tokens"
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

  // The launch path resolves the platform default runner chain.
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

  // Attached + trusted + Installed package chain the effective-definition
  // resolver walks (ADR-106).
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
    name: "SDD Judge",
    description: "Evaluation judge",
    workspace: "none",
    mode: "session",
    triggers: ["manual"],
    riskTier: "read_only",
    sourcePath: join(packageRoot, "maister-agents", "sdd-judge.md"),
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

  const taskId = randomUUID();

  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id: taskId,
    projectId,
    title: "T",
    prompt: "p",
    flowId,
  });

  studyId = randomUUID();
  await db.insert(schema.evaluationStudies).values({
    id: studyId,
    projectId,
    taskId,
    title: "Study",
    status: "open",
  });

  methodRevisionId = randomUUID();
  await db.insert(schema.evaluationMethodRevisions).values({
    id: methodRevisionId,
    packageInstallId: installId,
    methodId: "sdd-quality",
    qualifiedId: "core:sdd-quality",
    packageName: "core",
    versionLabel: "v1.1.0",
    schemaVersion: 1,
    normalizedDefinition: NORMALIZED_DEFINITION,
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

describe("defaultJudgeSpawn + issueJudgeAttemptToken glue (real launch path)", () => {
  it("issueJudgeAttemptToken mints EXACTLY the 4 attempt-bound judge scopes", async () => {
    const runId = randomUUID();
    const token = await issueJudgeAttemptToken({
      agentId: AGENT_ID,
      projectId,
      runId,
      db,
    });

    expect(token.tokenId).toBeTruthy();
    expect(token.secret).toBeTruthy();

    const [row] = await db
      .select()
      .from(schema.projectTokens)
      .where(eq(schema.projectTokens.id, token.tokenId));

    expect([...(row.scopes as string[])].sort()).toEqual(
      [...EXPECTED_JUDGE_SCOPES].sort(),
    );
    // The exported constant IS the expected set, and every scope is a known
    // member of the platform scope taxonomy.
    expect([...EVALUATION_JUDGE_TOKEN_SCOPES].sort()).toEqual(
      [...EXPECTED_JUDGE_SCOPES].sort(),
    );
    for (const scope of row.scopes as string[]) {
      expect(TOKEN_SCOPES).toContain(scope);
    }

    expect(row.token_kind).toBe("agent");
    expect(row.agent_id).toBe(AGENT_ID);
    expect(row.name).toBe(`agent-run:${runId}`);
    expect(row.expires_at).not.toBeNull();
    expect(row.revoked_at).toBeNull();
  });

  it("launchJudgePanel with the REAL defaultJudgeSpawn creates agent Runs and records tokenId + runId on the attempts", async () => {
    const executionId = await seedExecution();

    const result = await launchJudgePanel(
      executionId,
      { spawn: defaultJudgeSpawn(db) },
      db,
    );

    expect(result).toEqual({ launched: 2, adopted: 0 });

    const attempts = await db
      .select()
      .from(schema.evaluationJudgeAttempts)
      .where(eq(schema.evaluationJudgeAttempts.executionId, executionId));

    expect(attempts).toHaveLength(2);

    for (const attempt of attempts) {
      expect(attempt.agentRunId).not.toBeNull();
      expect(attempt.tokenId).not.toBeNull();
      // Crash-safe contract: the run carries EXACTLY the pre-recorded intent id.
      expect(attempt.agentRunId).toBe(attempt.intendedRunId);
      // D12 (Pending handling): the scheduler stub parks every run in Pending,
      // so the attempt stays queued with NO runningAt — the timeout clock
      // anchors at session Running, never at enqueue.
      expect(attempt.status).toBe("queued");
      expect(attempt.runningAt).toBeNull();
    }

    const runRows = await db
      .select()
      .from(schema.runs)
      .where(
        inArray(
          schema.runs.id,
          attempts.map((a: Record<string, any>) => a.agentRunId as string),
        ),
      );

    expect(runRows).toHaveLength(2);
    for (const run of runRows) {
      expect(run.runKind).toBe("agent");
      expect(run.agentId).toBe(AGENT_ID);
      expect(run.projectId).toBe(projectId);
      expect(run.agentWorkspace).toBe("none");
      // The scheduler stub refused the slot, so the run parks in Pending
      // (a live scheduler would flip it Running and spawn the ACP session).
      expect(["Pending", "Running"]).toContain(run.status);
    }

    const tokenRows = await db
      .select()
      .from(schema.projectTokens)
      .where(
        inArray(
          schema.projectTokens.id,
          attempts.map((a: Record<string, any>) => a.tokenId as string),
        ),
      );

    expect(tokenRows).toHaveLength(2);
    for (const token of tokenRows) {
      expect([...(token.scopes as string[])].sort()).toEqual(
        [...EXPECTED_JUDGE_SCOPES].sort(),
      );
      expect(token.token_kind).toBe("agent");
      expect(token.agent_id).toBe(AGENT_ID);
    }

    // Each token's deterministic name binds it to its attempt's run.
    const nameByTokenId = new Map(
      tokenRows.map((t: Record<string, any>) => [t.id, t.name]),
    );

    for (const attempt of attempts) {
      expect(nameByTokenId.get(attempt.tokenId)).toBe(
        `agent-run:${attempt.agentRunId}`,
      );
    }

    // Re-drive: every attempt is adopted, nothing is duplicated.
    const relaunched = await launchJudgePanel(
      executionId,
      { spawn: defaultJudgeSpawn(db) },
      db,
    );

    expect(relaunched).toEqual({ launched: 0, adopted: 2 });
  });

  it("defaultJudgeSpawn honors the caller-supplied runId and refuses a reused (deduped) id", async () => {
    const executionId = await seedExecution();
    const attempts = await provisionJudgeAttempts(executionId, db);
    const attempt = attempts.find((a) => a.ordinal === 1)!;
    const spawn = defaultJudgeSpawn(db);
    const intendedRunId = randomUUID();

    const spawned = await spawn({
      agentId: AGENT_ID,
      projectId,
      runnerId: null,
      executionId,
      attemptId: attempt.id,
      role: attempt.role,
      ordinal: attempt.ordinal,
      runId: intendedRunId,
    });

    expect(spawned.runId).toBe(intendedRunId);

    const [run] = await db
      .select({ id: schema.runs.id, runKind: schema.runs.runKind })
      .from(schema.runs)
      .where(eq(schema.runs.id, intendedRunId));

    expect(run).toBeTruthy();
    expect(run.runKind).toBe("agent");

    // A reused id dedups inside launchAgentRun; the seam surfaces it as a
    // typed CONFLICT instead of silently double-binding the attempt.
    await expect(
      spawn({
        agentId: AGENT_ID,
        projectId,
        runnerId: null,
        executionId,
        attemptId: attempt.id,
        role: attempt.role,
        ordinal: attempt.ordinal,
        runId: intendedRunId,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
