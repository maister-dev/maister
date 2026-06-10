import type { ArtifactInstance, GateResult, Run } from "@/lib/db/schema";
import type { SupervisorApi } from "@/lib/flows/runner-agent";
import type { SupervisorEvent } from "@/lib/supervisor-client";
import type { MutationReport } from "@/lib/flows/graph/mutation-check";

import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { recordArtifact } from "@/lib/flows/graph/artifact-store";
import { GIT_UNAVAILABLE_REASON } from "@/lib/flows/graph/mutation-check";
import { runFlow } from "@/lib/flows/runner";

const execFileAsync = promisify(execFile);

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
  // runner-agent's event consumer falls back to getDb() (requires DB_URL)
  // when no db is threaded — needed by the M29 ai_coding restriction tests
  // (mirrors calibrate-verdict-exec.integration.test.ts).
  process.env.DB_URL = container.getConnectionUri();
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function seedGraphRun(
  manifest: unknown,
): Promise<{ runId: string; runtimeRoot: string }> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const worktreePath = await mkdtemp(join(tmpdir(), "wt-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rt-"));

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: "Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "g",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/g",
    manifest,
    schemaVersion: 1,
  });
  await db
    .insert(schema.tasks)
    .values({ id: taskId, projectId, title: "t", prompt: "p", flowId });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    flowVersion: "v1.0.0",
    status: "Running",
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "feature/test",
    worktreePath,
    parentRepoPath: `/tmp/${slug}`,
  });

  return { runId, runtimeRoot };
}

async function getRun(runId: string): Promise<Run> {
  const rows = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as unknown as Run[];

  return rows[0];
}

async function getGates(runId: string): Promise<GateResult[]> {
  return (await db
    .select()
    .from(schema.gateResults)
    .where(eq(schema.gateResults.runId, runId))) as unknown as GateResult[];
}

function oneNode(gates: unknown[]) {
  return {
    schemaVersion: 1,
    name: "g",
    compat: { engine_min: "1.1.0" },
    nodes: [
      {
        id: "work",
        type: "cli",
        action: { command: "echo work" },
        pre_finish: { gates },
        transitions: { success: "done" },
      },
    ],
  };
}

describe("gate execution", () => {
  it("blocking command_check passes (exit 0) → node finishes, gate passed, run Review", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        { id: "fmt", kind: "command_check", mode: "blocking", command: "true" },
      ]),
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");
    const gates = await getGates(seeded.runId);

    expect(gates).toHaveLength(1);
    expect(gates[0].gateId).toBe("fmt");
    expect(gates[0].status).toBe("passed");
    expect((gates[0].verdict as { verdict: string }).verdict).toBe("pass");
  });

  it("blocking command_check fails (exit 1) → node Failed, run Failed", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        {
          id: "test",
          kind: "command_check",
          mode: "blocking",
          command: "false",
        },
      ]),
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Failed");
    const gates = await getGates(seeded.runId);

    expect(gates[0].status).toBe("failed");
  });

  it("advisory command_check fails but the node still finishes (run Review)", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        {
          id: "lint",
          kind: "command_check",
          mode: "advisory",
          command: "false",
        },
      ]),
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");
    const gates = await getGates(seeded.runId);

    expect(gates[0].status).toBe("failed"); // recorded, did not block
  });

  it("artifact_required (no inputArtifacts) passes vacuously; external_check stays pending; node finishes", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        { id: "art", kind: "artifact_required", mode: "blocking" },
        { id: "ext", kind: "external_check", mode: "blocking" },
      ]),
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    // The node finishes (artifact_required passes vacuously, external_check
    // stays pending — not a terminal failure at gate-exec time). However,
    // after Task 4 the readiness chokepoint fires for ALL flows regardless of
    // engine_min. The pending blocking external_check gate causes
    // assertEvidenceReady to return ready=false → run ends Failed.
    // (Pre-Task-4 the guard `artifactEnforcementActive &&` skipped the
    // chokepoint for engine_min "1.1.0" < "1.2.0", so the run reached Review.)
    expect((await getRun(seeded.runId)).status).toBe("Failed");
    const gates = await getGates(seeded.runId);

    // artifact_required with no inputArtifacts: vacuously all present → passed (T4.2)
    expect(gates.find((g) => g.gateId === "art")?.status).toBe("passed");
    expect(gates.find((g) => g.gateId === "ext")?.status).toBe("pending");
  });

  it("persists gate-declared inputArtifacts to gate_results.input_artifact_refs", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        {
          id: "fmt",
          kind: "command_check",
          mode: "blocking",
          command: "true",
          inputArtifacts: ["impl-diff", "test-report"],
        },
      ]),
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const gates = await getGates(seeded.runId);

    expect(gates[0].inputArtifactRefs).toEqual(["impl-diff", "test-report"]);
  });

  it("two blocking gates: a failing one fails the run, both verdicts recorded", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        { id: "a", kind: "command_check", mode: "blocking", command: "true" },
        { id: "b", kind: "command_check", mode: "blocking", command: "false" },
      ]),
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Failed");
    const gates = await getGates(seeded.runId);

    expect(gates.find((g) => g.gateId === "a")?.status).toBe("passed");
    expect(gates.find((g) => g.gateId === "b")?.status).toBe("failed");
  });
});

// T4.2: artifact_required gate execution
describe("T4.2: artifact_required gate (M12 typed artifacts)", () => {
  it("artifact_required with all inputArtifacts present → gate passed", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        {
          id: "verify-artifacts",
          kind: "artifact_required",
          mode: "blocking",
          inputArtifacts: ["impl-diff", "test-report"],
        },
      ]),
    );

    // Seed CURRENT artifacts before runFlow so the gate can see them.
    // nodeAttemptId is null (run-level artifact, no FK constraint issue).
    await recordArtifact(
      {
        runId: seeded.runId,
        nodeId: "work",
        kind: "diff",
        producer: "runner",
        artifactDefId: "impl-diff",
        locator: { kind: "inline", text: "impl changes" },
        validity: "current",
      },
      db,
    );
    await recordArtifact(
      {
        runId: seeded.runId,
        nodeId: "work",
        kind: "test_report",
        producer: "runner",
        artifactDefId: "test-report",
        locator: { kind: "inline", text: "all tests pass" },
        validity: "current",
      },
      db,
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const gates = await getGates(seeded.runId);
    const verifyGate = gates.find((g) => g.gateId === "verify-artifacts");

    expect(verifyGate?.inputArtifactRefs).toEqual(["impl-diff", "test-report"]);
    // RED: gate must check artifacts and pass when all present
    expect(verifyGate?.status).toBe("passed");
  });

  it("artifact_required with missing inputArtifact → gate failed", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        {
          id: "verify-artifacts",
          kind: "artifact_required",
          mode: "blocking",
          inputArtifacts: ["missing-artifact"],
        },
      ]),
    );

    // Do NOT seed any artifact; the gate must detect missing and fail
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const gates = await getGates(seeded.runId);
    const verifyGate = gates.find((g) => g.gateId === "verify-artifacts");

    // RED: gate must check artifacts and fail when missing
    expect(verifyGate?.status).toBe("failed");
  });

  it("artifact_required with stale inputArtifact → gate failed", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        {
          id: "verify-artifacts",
          kind: "artifact_required",
          mode: "blocking",
          inputArtifacts: ["stale-artifact"],
        },
      ]),
    );

    // Seed a STALE artifact before runFlow; gate must detect non-current and fail.
    await recordArtifact(
      {
        runId: seeded.runId,
        nodeId: "work",
        kind: "lint_report",
        producer: "runner",
        artifactDefId: "stale-artifact",
        locator: { kind: "inline", text: "old data" },
        validity: "stale",
      },
      db,
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const gates = await getGates(seeded.runId);
    const verifyGate = gates.find((g) => g.gateId === "verify-artifacts");

    // RED: gate must check validity and fail when stale
    expect(verifyGate?.status).toBe("failed");
  });

  it("artifact_required advisory mode with missing artifact → recorded failed but non-blocking", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        {
          id: "optional-verify",
          kind: "artifact_required",
          mode: "advisory",
          inputArtifacts: ["missing"],
        },
      ]),
    );

    // Do NOT seed the artifact; gate must detect missing
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    // RED: advisory gate fails (missing artifact) but does NOT block → node finishes → run Review
    expect((await getRun(seeded.runId)).status).toBe("Review");
    const gates = await getGates(seeded.runId);
    const optionalGate = gates.find((g) => g.gateId === "optional-verify");

    // RED: gate must check artifacts and record failed, but mode=advisory means non-blocking
    expect(optionalGate?.status).toBe("failed");
    expect(optionalGate?.mode).toBe("advisory");
  });

  it("artifact_required gate with output declaration → sets outputArtifactRef", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        {
          id: "verify-and-output",
          kind: "artifact_required",
          mode: "blocking",
          inputArtifacts: ["input-def"],
          output: { id: "validated-output", kind: "lint_report" },
        },
      ]),
    );

    // Seed the required input artifact before runFlow so the gate can see it.
    await recordArtifact(
      {
        runId: seeded.runId,
        nodeId: "work",
        kind: "lint_report",
        producer: "runner",
        artifactDefId: "input-def",
        locator: { kind: "inline", text: "input data" },
        validity: "current",
      },
      db,
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const gates = await getGates(seeded.runId);
    const verifyGate = gates.find((g) => g.gateId === "verify-and-output");

    // RED: gate must set outputArtifactRef when declared
    expect(verifyGate?.outputArtifactRef).toBe("validated-output");
  });
});

// ===========================================================================
// M29 (ADR-073): mutation assertions on artifact_required gates
// ===========================================================================

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 4 * 1024 * 1024,
  });

  return stdout;
}

// A real git worktree: main at C0 (base.txt); branch `feature` checked out.
// `commitOnFeature` adds the given files as C1 BEFORE runFlow (the cumulative
// branch diff). Returns the repo dir (used as the run's worktreePath).
async function makeGitWorktree(
  commitOnFeature: Record<string, string> = {},
): Promise<{ worktreePath: string; c0: string }> {
  const repo = await mkdtemp(join(tmpdir(), "mutation-wt-"));

  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "test@maister.local");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "base.txt"), "base\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "C0 base");
  const c0 = (await git(repo, "rev-parse", "HEAD")).trim();

  await git(repo, "checkout", "-q", "-b", "feature");

  const entries = Object.entries(commitOnFeature);

  if (entries.length > 0) {
    for (const [rel, content] of entries) {
      const abs = join(repo, rel);

      await execFileAsync("mkdir", ["-p", join(abs, "..")]);
      await writeFile(abs, content);
    }
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "C1 feature work");
  }

  return { worktreePath: repo, c0 };
}

// Same seeding as seedGraphRun but the workspace points at a REAL git repo on
// branch `feature` (so resolveDiffRange/touchedPaths evaluate).
async function seedGitGraphRun(
  manifest: unknown,
  worktreePath: string,
): Promise<{ runId: string; runtimeRoot: string; projectId: string }> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rt-"));

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: "Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "g",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/g",
    manifest,
    schemaVersion: 1,
  });
  await db
    .insert(schema.tasks)
    .values({ id: taskId, projectId, title: "t", prompt: "p", flowId });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    flowVersion: "v1.0.0",
    status: "Running",
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "feature",
    worktreePath,
    parentRepoPath: `/tmp/${slug}`,
  });

  return { runId, runtimeRoot, projectId };
}

function mutationManifest(gate: Record<string, unknown>, command = "true") {
  return {
    schemaVersion: 1,
    name: "g",
    compat: { engine_min: "1.3.0" },
    nodes: [
      {
        id: "work",
        type: "cli",
        action: { command },
        pre_finish: { gates: [gate] },
        transitions: { success: "done" },
      },
    ],
  };
}

async function getMutationReports(runId: string): Promise<ArtifactInstance[]> {
  return (await db
    .select()
    .from(schema.artifactInstances)
    .where(
      and(
        eq(schema.artifactInstances.runId, runId),
        eq(schema.artifactInstances.kind, "mutation_report"),
      ),
    )) as unknown as ArtifactInstance[];
}

function parseReport(row: ArtifactInstance): MutationReport {
  const locator = row.locator as { kind: string; text: string };

  expect(locator.kind).toBe("inline");

  return JSON.parse(locator.text) as MutationReport;
}

// End-turn supervisor spy so an ai_coding node finishes without a real agent
// (mirrors runner-graph.materialize.integration.test.ts).
function makeEndTurnSupervisor(): SupervisorApi {
  async function* endTurnStream(): AsyncGenerator<SupervisorEvent> {
    yield {
      type: "session.exited",
      sessionId: "sup-1",
      monotonicId: 1,
      exitCode: 0,
    } as SupervisorEvent;
  }

  return {
    createSession: vi.fn(async () => ({
      sessionId: "sup-1",
      pid: 1,
      acpSessionId: "acp-1",
    })) as unknown as SupervisorApi["createSession"],
    deleteSession: vi.fn(async () => undefined),
    sendPrompt: vi.fn(async () => ({ stopReason: "end_turn" as const })),
    streamSession: vi.fn(() =>
      endTurnStream(),
    ) as unknown as SupervisorApi["streamSession"],
    cancelPermission: vi.fn(
      async () => ({ ok: true }) as { ok: true },
    ) as unknown as SupervisorApi["cancelPermission"],
    deliverPermission: vi.fn(
      async () => ({ ok: true }) as { ok: true },
    ) as unknown as SupervisorApi["deliverPermission"],
  };
}

async function seedRestrictionRecord(
  projectId: string,
  material: Record<string, unknown>,
): Promise<void> {
  await db.insert(schema.capabilityRecords).values({
    id: randomUUID(),
    projectId,
    capabilityRefId: "no-secrets",
    kind: "restriction",
    label: "No secrets",
    source: "project",
    agents: ["claude", "codex"],
    enforceability: "instructed",
    selectable: true,
    selectedByDefault: false,
    material,
  });
}

// The node action commits inside the worktree (bash -c, cwd=worktreePath) —
// the node-scoped range starts at the node-start capture, so only commits
// made DURING the node count as its touches.
const COMMIT_DOCS =
  'mkdir -p docs && echo note > docs/note.md && git add -A && git commit -q -m "node work"';
const COMMIT_SRC =
  'mkdir -p src && echo "export {};" > src/a.ts && git add -A && git commit -q -m "node work"';

describe("M29: must_touch assertions (blocking artifact_required)", () => {
  it("no path matches → gate failed, run Failed, mutation_report recorded with hash+size", async () => {
    const { worktreePath } = await makeGitWorktree();
    const seeded = await seedGitGraphRun(
      mutationManifest(
        {
          id: "verify",
          kind: "artifact_required",
          mode: "blocking",
          must_touch: ["src/**"],
          output: { id: "verify-report", kind: "mutation_report" },
        },
        COMMIT_DOCS,
      ),
      worktreePath,
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Failed");

    const gate = (await getGates(seeded.runId)).find(
      (g) => g.gateId === "verify",
    );

    expect(gate?.status).toBe("failed");
    const verdict = gate?.verdict as {
      reasons?: string[];
      payload?: { assertionFailed?: boolean };
    };

    expect(verdict.payload?.assertionFailed).toBe(true);
    expect(verdict.reasons?.[0]).toContain("must_touch: no path matched");

    const reports = await getMutationReports(seeded.runId);

    expect(reports).toHaveLength(1);
    expect(reports[0].validity).toBe("current");
    expect(reports[0].artifactDefId).toBe("verify-report");
    expect(reports[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(reports[0].sizeBytes).toBeGreaterThan(0);

    const report = parseReport(reports[0]);

    expect(report.basis).toBe("node");
    expect(report.touched).toEqual(["docs/note.md"]);
    expect(report.mustTouch.matched).toEqual([]);
  }, 60_000);

  it("a matching path → gate passed, run Review, report still recorded (deterministic fallback id)", async () => {
    const { worktreePath } = await makeGitWorktree();
    const seeded = await seedGitGraphRun(
      mutationManifest(
        {
          id: "verify",
          kind: "artifact_required",
          mode: "blocking",
          must_touch: ["src/**"],
        },
        COMMIT_SRC,
      ),
      worktreePath,
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const gate = (await getGates(seeded.runId)).find(
      (g) => g.gateId === "verify",
    );

    expect(gate?.status).toBe("passed");

    const reports = await getMutationReports(seeded.runId);

    expect(reports).toHaveLength(1);
    expect(reports[0].artifactDefId).toBeNull();
    expect(reports[0].id).toContain(":mutation:verify");

    const report = parseReport(reports[0]);

    expect(report.mustTouch.matched).toEqual(["src/a.ts"]);
    expect(report.violations).toEqual([]);
  }, 60_000);

  it("advisory mode: assertion failure recorded, node proceeds (run Review)", async () => {
    const { worktreePath } = await makeGitWorktree();
    const seeded = await seedGitGraphRun(
      mutationManifest(
        {
          id: "verify",
          kind: "artifact_required",
          mode: "advisory",
          must_touch: ["src/**"],
        },
        COMMIT_DOCS,
      ),
      worktreePath,
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");
    expect(
      (await getGates(seeded.runId)).find((g) => g.gateId === "verify")?.status,
    ).toBe("failed");
    expect(await getMutationReports(seeded.runId)).toHaveLength(1);
  }, 60_000);

  it("git unavailable → blocking gate fails with the git-unavailable reason, report evaluated:false", async () => {
    // Plain mkdtemp worktree — NOT a git repo.
    const seeded = await seedGraphRunAt13(
      mutationManifest({
        id: "verify",
        kind: "artifact_required",
        mode: "blocking",
        must_touch: ["src/**"],
      }),
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Failed");

    const gate = (await getGates(seeded.runId)).find(
      (g) => g.gateId === "verify",
    );

    expect(gate?.status).toBe("failed");
    const verdict = gate?.verdict as {
      reasons?: string[];
      payload?: { assertionFailed?: boolean };
    };

    expect(verdict.reasons).toEqual([GIT_UNAVAILABLE_REASON]);
    expect(verdict.payload?.assertionFailed).toBe(true);

    const reports = await getMutationReports(seeded.runId);

    expect(reports).toHaveLength(1);
    expect(parseReport(reports[0]).evaluated).toBe(false);
  }, 60_000);

  it("rework no-op delta passes: preserved node-start spans attempt 1's commit", async () => {
    // Attempt-2 shape: the node-start file (write-if-absent) preserved C0 from
    // attempt 1; the attempt-1 commit (src/a.ts) is already on the branch; the
    // re-run action is a no-op. The node range C0..C1 still matches.
    const { worktreePath, c0 } = await makeGitWorktree({
      "src/a.ts": "export const a = 1;\n",
    });
    const seeded = await seedGitGraphRun(
      mutationManifest(
        {
          id: "verify",
          kind: "artifact_required",
          mode: "blocking",
          must_touch: ["src/**"],
        },
        "echo noop",
      ),
      worktreePath,
    );

    // Pre-seed the capture exactly as attempt 1 would have written it.
    const runDir = join(
      seeded.runtimeRoot,
      ".maister",
      (await getRunProjectSlug(seeded.runId)) ?? "",
      "runs",
      seeded.runId,
    );

    await execFileAsync("mkdir", ["-p", runDir]);
    await writeFile(
      join(runDir, "node-start-work.json"),
      JSON.stringify({ head: c0 }),
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const reports = await getMutationReports(seeded.runId);
    const report = parseReport(reports[0]);

    expect(report.basis).toBe("node");
    expect(report.nodeRange.base).toBe(c0);
    expect(report.mustTouch.matched).toEqual(["src/a.ts"]);
  }, 60_000);

  it("unreadable node-start capture → basis cumulative-fallback recorded", async () => {
    const { worktreePath } = await makeGitWorktree({
      "src/a.ts": "export const a = 1;\n",
    });
    const seeded = await seedGitGraphRun(
      mutationManifest({
        id: "verify",
        kind: "artifact_required",
        mode: "blocking",
        must_touch: ["src/**"],
      }),
      worktreePath,
    );

    // A corrupt capture (legacy run shape): present → write-if-absent keeps
    // it; unreadable → the gate falls back to the cumulative range.
    const runDir = join(
      seeded.runtimeRoot,
      ".maister",
      (await getRunProjectSlug(seeded.runId)) ?? "",
      "runs",
      seeded.runId,
    );

    await execFileAsync("mkdir", ["-p", runDir]);
    await writeFile(join(runDir, "node-start-work.json"), "not json{{");

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const report = parseReport((await getMutationReports(seeded.runId))[0]);

    expect(report.basis).toBe("cumulative-fallback");
    expect(report.mustTouch.matched).toEqual(["src/a.ts"]);
  }, 60_000);
});

describe("M29: must_not_touch via M14 restriction paths", () => {
  function aiCodingManifest(restrictionIds: string[]) {
    return {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.3.0" },
      nodes: [
        {
          id: "work",
          type: "ai_coding",
          action: { prompt: "do the work" },
          settings: { restrictions: restrictionIds },
          pre_finish: {
            gates: [
              {
                id: "verify",
                kind: "artifact_required",
                mode: "blocking",
                must_not_touch: "restrictions",
              },
            ],
          },
          transitions: { success: "done" },
        },
      ],
    };
  }

  it("cumulative diff touching a restriction path → gate failed with the violation", async () => {
    const { worktreePath } = await makeGitWorktree({
      "secrets/key.pem": "PRIVATE\n",
    });
    const seeded = await seedGitGraphRun(
      aiCodingManifest(["no-secrets"]),
      worktreePath,
    );

    await seedRestrictionRecord(seeded.projectId, {
      path: null,
      hasContent: true,
      paths: ["secrets/**"],
    });

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: makeEndTurnSupervisor(),
    });

    expect((await getRun(seeded.runId)).status).toBe("Failed");

    const gate = (await getGates(seeded.runId)).find(
      (g) => g.gateId === "verify",
    );

    expect(gate?.status).toBe("failed");
    const verdict = gate?.verdict as {
      reasons?: string[];
      payload?: { assertionFailed?: boolean };
    };

    expect(verdict.payload?.assertionFailed).toBe(true);
    expect(verdict.reasons?.[0]).toContain("must_not_touch: 1 violation(s)");
    expect(verdict.reasons?.[0]).toContain("secrets/key.pem");

    const report = parseReport((await getMutationReports(seeded.runId))[0]);

    expect(report.restrictions.checked).toEqual([
      {
        id: "no-secrets",
        paths: ["secrets/**"],
        violations: ["secrets/key.pem"],
      },
    ]);
  }, 60_000);

  it("restriction without paths → unmatchable, gate passes", async () => {
    const { worktreePath } = await makeGitWorktree({
      "secrets/key.pem": "PRIVATE\n",
    });
    const seeded = await seedGitGraphRun(
      aiCodingManifest(["no-secrets"]),
      worktreePath,
    );

    await seedRestrictionRecord(seeded.projectId, {
      path: null,
      hasContent: true,
    });

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: makeEndTurnSupervisor(),
    });

    expect((await getRun(seeded.runId)).status).toBe("Review");
    expect(
      (await getGates(seeded.runId)).find((g) => g.gateId === "verify")?.status,
    ).toBe("passed");

    const report = parseReport((await getMutationReports(seeded.runId))[0]);

    expect(report.restrictions.unmatchable).toEqual(["no-secrets"]);
    expect(report.restrictions.checked).toEqual([]);
  }, 60_000);
});

// seedGraphRun with an engine_min 1.3.0 manifest (plain non-git worktree).
async function seedGraphRunAt13(
  manifest: unknown,
): Promise<{ runId: string; runtimeRoot: string }> {
  return seedGraphRun(manifest);
}

async function getRunProjectSlug(runId: string): Promise<string | null> {
  const rows = (await db
    .select({ slug: schema.projects.slug })
    .from(schema.runs)
    .innerJoin(schema.projects, eq(schema.runs.projectId, schema.projects.id))
    .where(eq(schema.runs.id, runId))) as Array<{ slug: string }>;

  return rows[0]?.slug ?? null;
}
