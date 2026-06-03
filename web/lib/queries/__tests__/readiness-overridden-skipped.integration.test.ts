// RED (M15 Task 10): getRunReadiness must:
// 1. Add "overridden" to ReadinessDTO.readiness union
// 2. Return readiness="overridden" when the only blocking gate with live
//    status is "overridden" (today returns "ready")
// 3. Return readiness="blocked" when ANY blocking gate (including non-external
//    kinds like command_check, ai_judgment, skill_check, artifact_required) has
//    status="skipped" (today ignores non-external skipped → falls through to "ready")
// 4. Respect priority: failed > stale > blocked > waiting > overridden > ready
//
// Spec: docs/system-analytics/readiness.md §State machine table + §Readiness classifier
//   Per-status contribution of a single blocking gate:
//     passed → clears phase
//     overridden → overridden (clears but flagged)
//     failed → failed
//     stale → stale
//     skipped → blocked (all kinds, not just external_check)
//     pending/running → waiting
//
//   Priority: failed > stale > blocked > waiting > overridden > ready
//
// getRunReadiness today:
// - ReadinessDTO.readiness union is "ready"|"blocked"|"stale"|"failed"|"waiting"
//   (missing "overridden")
// - Lines 350-367: explicitly handles skipped EXTERNAL_CHECK gates → blocked
//   but ignores skipped non-external blocking gates (they fall through to ready)
// - Never checks for overridden blocking gates unless it's the only contribution
//   (logic would fall through to ready)

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { getRunReadiness, type ReadinessDTO } from "@/lib/queries/readiness";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("readiness_overridden_skipped_test")
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

async function seedProject(slug: string): Promise<{
  projectId: string;
  flowId: string;
  executorId: string;
}> {
  const projectId = randomUUID();
  const flowId = randomUUID();
  const executorId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });

  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "test-flow",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/test-flow",
    manifest: { schemaVersion: 1, name: "Test", steps: [] },
    schemaVersion: 1,
  });

  await db.insert(schema.executors).values({
    id: executorId,
    projectId,
    executorRefId: "claude-sonnet",
    agent: "claude",
    model: "claude-sonnet-4-6",
  });

  return { projectId, flowId, executorId };
}

async function seedTask(projectId: string, flowId: string): Promise<string> {
  const taskId = randomUUID();

  await db.insert(schema.tasks as any).values({
    id: taskId,
    projectId,
    title: "Test Task",
    prompt: "Do something",
    flowId,
    status: "InFlight",
    stage: "InFlight",
    attemptNumber: 1,
  });

  return taskId;
}

async function seedRun(
  projectId: string,
  taskId: string,
  flowId: string,
  executorId: string,
): Promise<string> {
  const runId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(schema.runs as any).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    executorId,
    status: "Review",
    flowVersion: "v1.0.0",
    currentStepId: "review",
  });

  await db.insert(schema.workspaces as any).values({
    id: workspaceId,
    projectId,
    runId,
    branch: "maister/test",
    worktreePath: `/tmp/wt-${runId}`,
    parentRepoPath: `/tmp/repo`,
  });

  return runId;
}

async function seedNodeAttempt(runId: string): Promise<string> {
  const attemptId = randomUUID();

  await db.insert(schema.nodeAttempts as any).values({
    id: attemptId,
    runId,
    nodeId: "review",
    nodeType: "check",
    attempt: 1,
    status: "Succeeded",
    startedAt: new Date("2026-05-31T10:00:00.000Z"),
  });

  return attemptId;
}

async function seedBlockingGate(
  runId: string,
  nodeAttemptId: string,
  gateId: string,
  kind: string,
  status: string,
): Promise<void> {
  await db.insert(schema.gateResults as any).values({
    id: randomUUID(),
    runId,
    nodeAttemptId,
    gateId,
    kind,
    mode: "blocking",
    status,
  });
}

describe("getRunReadiness — overridden + skipped gate handling (M15 Task 10)", () => {
  describe("Case 1: overridden blocking gate only → readiness='overridden'", () => {
    it("single overridden blocking gate makes readiness='overridden' (RED: returns 'ready')", async () => {
      const { projectId, flowId, executorId } = await seedProject(
        `over-1-${randomUUID().slice(0, 8)}`,
      );
      const taskId = await seedTask(projectId, flowId);
      const runId = await seedRun(projectId, taskId, flowId, executorId);
      const nodeAttemptId = await seedNodeAttempt(runId);

      // Single blocking gate with status="overridden"
      await seedBlockingGate(
        runId,
        nodeAttemptId,
        "manual-override",
        "external_check",
        "overridden",
      );

      const dto = await getRunReadiness(runId, projectId, db);

      expect(dto).not.toBeNull();
      // RED today: returns "ready" because it falls through all the checks.
      // After fix: should be "overridden".
      expect(dto!.readiness).toBe("overridden");
    });
  });

  describe("Case 2: skipped blocking gate of non-external kind → readiness='blocked'", () => {
    it("skipped command_check blocking gate makes readiness='blocked' (RED: returns 'ready')", async () => {
      const { projectId, flowId, executorId } = await seedProject(
        `skip-cmd-${randomUUID().slice(0, 8)}`,
      );
      const taskId = await seedTask(projectId, flowId);
      const runId = await seedRun(projectId, taskId, flowId, executorId);
      const nodeAttemptId = await seedNodeAttempt(runId);

      // Blocking command_check gate with status="skipped"
      await seedBlockingGate(
        runId,
        nodeAttemptId,
        "pre-check",
        "command_check",
        "skipped",
      );

      const dto = await getRunReadiness(runId, projectId, db);

      expect(dto).not.toBeNull();
      // RED today: no special logic for non-external skipped → falls through to "ready".
      // After fix: should be "blocked".
      expect(dto!.readiness).toBe("blocked");
    });

    it("skipped ai_judgment blocking gate makes readiness='blocked' (RED: returns 'ready')", async () => {
      const { projectId, flowId, executorId } = await seedProject(
        `skip-aij-${randomUUID().slice(0, 8)}`,
      );
      const taskId = await seedTask(projectId, flowId);
      const runId = await seedRun(projectId, taskId, flowId, executorId);
      const nodeAttemptId = await seedNodeAttempt(runId);

      // Blocking ai_judgment gate with status="skipped"
      await seedBlockingGate(
        runId,
        nodeAttemptId,
        "judge",
        "ai_judgment",
        "skipped",
      );

      const dto = await getRunReadiness(runId, projectId, db);

      expect(dto).not.toBeNull();
      // RED today: falls through to "ready".
      // After fix: should be "blocked".
      expect(dto!.readiness).toBe("blocked");
    });

    it("skipped skill_check blocking gate makes readiness='blocked' (RED: returns 'ready')", async () => {
      const { projectId, flowId, executorId } = await seedProject(
        `skip-skill-${randomUUID().slice(0, 8)}`,
      );
      const taskId = await seedTask(projectId, flowId);
      const runId = await seedRun(projectId, taskId, flowId, executorId);
      const nodeAttemptId = await seedNodeAttempt(runId);

      // Blocking skill_check gate with status="skipped"
      await seedBlockingGate(
        runId,
        nodeAttemptId,
        "skill",
        "skill_check",
        "skipped",
      );

      const dto = await getRunReadiness(runId, projectId, db);

      expect(dto).not.toBeNull();
      // RED today: falls through to "ready".
      // After fix: should be "blocked".
      expect(dto!.readiness).toBe("blocked");
    });
  });

  describe("Case 3: skipped external_check blocking gate → readiness='blocked' (GREEN: already works)", () => {
    it("skipped external_check blocks (guard test to ensure we don't regress)", async () => {
      const { projectId, flowId, executorId } = await seedProject(
        `skip-ext-${randomUUID().slice(0, 8)}`,
      );
      const taskId = await seedTask(projectId, flowId);
      const runId = await seedRun(projectId, taskId, flowId, executorId);
      const nodeAttemptId = await seedNodeAttempt(runId);

      // Blocking external_check gate with status="skipped" (already handled today)
      await seedBlockingGate(
        runId,
        nodeAttemptId,
        "ci",
        "external_check",
        "skipped",
      );

      const dto = await getRunReadiness(runId, projectId, db);

      expect(dto).not.toBeNull();
      // This already works: lines 350-367 explicitly check for skipped external gates.
      expect(dto!.readiness).toBe("blocked");
    });
  });

  describe("Case 4: precedence — failed outranks overridden", () => {
    it("failed gate + overridden gate → readiness='failed' (priority failed > overridden)", async () => {
      const { projectId, flowId, executorId } = await seedProject(
        `prec-fail-over-${randomUUID().slice(0, 8)}`,
      );
      const taskId = await seedTask(projectId, flowId);
      const runId = await seedRun(projectId, taskId, flowId, executorId);
      const nodeAttemptId = await seedNodeAttempt(runId);

      // One failed, one overridden — failed should win.
      await seedBlockingGate(
        runId,
        nodeAttemptId,
        "gate-1",
        "command_check",
        "failed",
      );
      await seedBlockingGate(
        runId,
        nodeAttemptId,
        "gate-2",
        "external_check",
        "overridden",
      );

      const dto = await getRunReadiness(runId, projectId, db);

      expect(dto).not.toBeNull();
      // Priority: failed > stale > blocked > waiting > overridden > ready
      expect(dto!.readiness).toBe("failed");
    });
  });

  describe("Case 5: precedence — waiting outranks overridden", () => {
    it("pending gate + overridden gate → readiness='waiting' (priority waiting > overridden)", async () => {
      const { projectId, flowId, executorId } = await seedProject(
        `prec-wait-over-${randomUUID().slice(0, 8)}`,
      );
      const taskId = await seedTask(projectId, flowId);
      const runId = await seedRun(projectId, taskId, flowId, executorId);
      const nodeAttemptId = await seedNodeAttempt(runId);

      // One pending, one overridden — waiting (pending) should win.
      await seedBlockingGate(
        runId,
        nodeAttemptId,
        "gate-1",
        "external_check",
        "pending",
      );
      await seedBlockingGate(
        runId,
        nodeAttemptId,
        "gate-2",
        "command_check",
        "overridden",
      );

      const dto = await getRunReadiness(runId, projectId, db);

      expect(dto).not.toBeNull();
      // Priority: failed > stale > blocked > waiting > overridden > ready
      expect(dto!.readiness).toBe("waiting");
    });
  });

  describe("Case 6: regression — clean run (all gates passed) → readiness='ready'", () => {
    it("all passed blocking gates → readiness='ready'", async () => {
      const { projectId, flowId, executorId } = await seedProject(
        `clean-${randomUUID().slice(0, 8)}`,
      );
      const taskId = await seedTask(projectId, flowId);
      const runId = await seedRun(projectId, taskId, flowId, executorId);
      const nodeAttemptId = await seedNodeAttempt(runId);

      // Two gates, both passed
      await seedBlockingGate(
        runId,
        nodeAttemptId,
        "gate-1",
        "command_check",
        "passed",
      );
      await seedBlockingGate(
        runId,
        nodeAttemptId,
        "gate-2",
        "external_check",
        "passed",
      );

      const dto = await getRunReadiness(runId, projectId, db);

      expect(dto).not.toBeNull();
      expect(dto!.readiness).toBe("ready");
    });

    it("no blocking gates → readiness='ready'", async () => {
      const { projectId, flowId, executorId } = await seedProject(
        `no-gates-${randomUUID().slice(0, 8)}`,
      );
      const taskId = await seedTask(projectId, flowId);
      const runId = await seedRun(projectId, taskId, flowId, executorId);

      await seedNodeAttempt(runId);
      // No gates inserted at all

      const dto = await getRunReadiness(runId, projectId, db);

      expect(dto).not.toBeNull();
      expect(dto!.readiness).toBe("ready");
    });
  });

  describe("Case 7: TYPE assertion — 'overridden' is in ReadinessDTO.readiness union (RED: type error today)", () => {
    it("'overridden' is a valid ReadinessDTO readiness value", () => {
      // This is a compile-time assertion. At runtime it's a no-op.
      // But at typecheck time (tsc), this will FAIL if 'overridden' is not
      // in the ReadinessDTO['readiness'] union.
      const readinessValue: ReadinessDTO["readiness"] = "overridden";

      expect(readinessValue).toBe("overridden");
    });
  });
});
