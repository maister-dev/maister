import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import {
  getNodeObservatoryDetail,
  getPortfolioObservatory,
  getProjectObservatory,
} from "@/lib/queries/observatory";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let memberUserId: string;
let visibleProjectId: string;
let hiddenProjectId: string;
let visibleFlowId: string;
let hiddenFlowId: string;

const NOW = new Date("2026-06-05T12:00:00.000Z");

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("observatory_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema });

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(schema.domainEvents);
  await db.delete(schema.artifactInstances);
  await db.delete(schema.gateResults);
  await db.delete(schema.hitlRequests);
  await db.delete(schema.nodeAttempts);
  await db.delete(schema.runs);
  await db.delete(schema.tasks);
  await db.delete(schema.projectMembers);
  await db.delete(schema.flows);
  await db.delete(schema.flowRevisions);
  await db.delete(schema.projects);
  await db.delete(schema.users);

  memberUserId = randomUUID();
  visibleProjectId = randomUUID();
  hiddenProjectId = randomUUID();
  visibleFlowId = randomUUID();
  hiddenFlowId = randomUUID();

  await db.insert(schema.users).values({
    id: memberUserId,
    email: `observatory-${memberUserId}@maister.local`,
    role: "member",
    accountStatus: "active",
  });

  await db.insert(schema.projects).values([
    { taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
      id: visibleProjectId,
      slug: "observatory-visible",
      name: "Visible",
      repoPath: `/repos/observatory-visible-${visibleProjectId}`,
      maisterYamlPath: "/repos/visible/maister.yaml",
    },
    { taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
      id: hiddenProjectId,
      slug: "observatory-hidden",
      name: "Hidden",
      repoPath: `/repos/observatory-hidden-${hiddenProjectId}`,
      maisterYamlPath: "/repos/hidden/maister.yaml",
    },
  ]);

  await db.insert(schema.projectMembers).values({
    projectId: visibleProjectId,
    userId: memberUserId,
    role: "member",
  });

  await db.insert(schema.flows).values([
    {
      id: visibleFlowId,
      projectId: visibleProjectId,
      flowRefId: "aif",
      source: "github.com/acme/aif",
      version: "v1.0.0",
      installedPath: "/tmp/flows/aif",
      manifest: { schemaVersion: 1, name: "aif", steps: [] },
      schemaVersion: 1,
      enablementState: "Enabled",
      trustStatus: "trusted",
    },
    {
      id: hiddenFlowId,
      projectId: hiddenProjectId,
      flowRefId: "aif-hidden",
      source: "github.com/acme/aif-hidden",
      version: "v1.0.0",
      installedPath: "/tmp/flows/aif-hidden",
      manifest: { schemaVersion: 1, name: "aif-hidden", steps: [] },
      schemaVersion: 1,
      enablementState: "Enabled",
      trustStatus: "trusted",
    },
  ]);
});

describe("observatory read models", () => {
  it("aggregates portfolio metrics for visible projects without leaking hidden rows", async () => {
    const { runId, implementAttemptId } = await seedRun({
      projectId: visibleProjectId,
      flowId: visibleFlowId,
      suffix: "visible",
    });

    await seedRun({
      projectId: hiddenProjectId,
      flowId: hiddenFlowId,
      suffix: "hidden",
      reworked: true,
    });

    await db
      .insert(schema.nodeAttempts)
      .values([
        attempt(
          runId,
          "implement",
          "ai_coding",
          1,
          "Succeeded",
          "visible-impl-1",
        ),
        attempt(
          runId,
          "implement",
          "ai_coding",
          2,
          "Succeeded",
          "visible-impl-2",
        ),
        attempt(runId, "review", "human", 1, "Reworked", "visible-review-1"),
      ]);
    await db.insert(schema.hitlRequests).values({
      id: "visible-hitl-1",
      runId,
      stepId: "review",
      kind: "human",
      prompt: "Review",
      decision: "rework",
      reworkTarget: "implement",
      workspacePolicy: "keep",
      createdAt: new Date("2026-06-05T11:30:00.000Z"),
      respondedAt: null,
    });
    await db.insert(schema.artifactInstances).values({
      id: "visible-artifact-1",
      runId,
      nodeAttemptId: implementAttemptId,
      nodeId: "implement",
      attempt: 1,
      artifactDefId: null,
      kind: "log",
      producer: "runner",
      locator: { kind: "inline", text: "redacted" },
      validity: "current",
    });

    const result = await getPortfolioObservatory(
      memberUserId,
      "member",
      { now: NOW },
      db,
    );

    expect(result.projects.map((project) => project.projectId)).toEqual([
      visibleProjectId,
    ]);
    expect(result.totals.correction.runCount).toBe(1);
    expect(result.totals.correction.retryCount).toBe(1);
    expect(result.totals.correction.reworkCount).toBe(1);
    expect(result.totals.correction.correctionRate).toBe(2);
    expect(result.totals.autonomy.openWaitCount).toBe(1);
    expect(result.artifacts.map((artifact) => artifact.artifactKey)).toEqual([
      "kind:log",
    ]);
  });

  it("counts budget escalations and terminations from domain_events, window+project scoped", async () => {
    // Escalation (run paused for budget decision).
    await seedDomainEvent({
      projectId: visibleProjectId,
      kind: "run.escalated",
      reason: "budget_exceeded",
    });
    // The three non-normalized terminate reasons: flow/scratch, agent, tree-root.
    await seedDomainEvent({
      projectId: visibleProjectId,
      kind: "run.failed",
      reason: "BUDGET_EXCEEDED",
    });
    await seedDomainEvent({
      projectId: visibleProjectId,
      kind: "run.failed",
      reason: "budget_breach",
    });
    await seedDomainEvent({
      projectId: visibleProjectId,
      kind: "run.failed",
      reason: "budget_exceeded",
    });
    // A non-budget failure must NOT count.
    await seedDomainEvent({
      projectId: visibleProjectId,
      kind: "run.failed",
      reason: "CRASH",
    });
    // A non-budget escalation (e.g. auto-retry exhaustion) must NOT count.
    await seedDomainEvent({
      projectId: visibleProjectId,
      kind: "run.escalated",
      reason: "auto_retry_exhausted",
    });
    // Outside the lookback window must NOT count.
    await seedDomainEvent({
      projectId: visibleProjectId,
      kind: "run.failed",
      reason: "BUDGET_EXCEEDED",
      createdAt: new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000),
    });
    // A budget breach in a project the member cannot see must NOT leak.
    await seedDomainEvent({
      projectId: hiddenProjectId,
      kind: "run.failed",
      reason: "BUDGET_EXCEEDED",
    });

    const portfolio = await getPortfolioObservatory(
      memberUserId,
      "member",
      { now: NOW },
      db,
    );
    const project = await getProjectObservatory(
      visibleProjectId,
      { now: NOW },
      db,
    );

    expect(portfolio.budget).toEqual({
      budgetEscalations: 1,
      budgetTerminations: 3,
    });
    expect(project.budget).toEqual({
      budgetEscalations: 1,
      budgetTerminations: 3,
    });
  });

  it("returns project and node detail aggregates with constant query count", async () => {
    const singleRun = await measureNodeDetailQueries(1);

    await resetRunRows();

    const multiRun = await measureNodeDetailQueries(8);

    expect(singleRun.project.totals.correction.runCount).toBe(1);
    expect(singleRun.detail.runs).toHaveLength(1);
    expect(singleRun.detail.attempts).toHaveLength(2);
    expect(multiRun.project.totals.correction.runCount).toBe(8);
    expect(
      multiRun.project.nodes.find((node) => node.nodeId === "checks")
        ?.retryCount,
    ).toBe(8);
    expect(multiRun.detail.nodeId).toBe("checks");
    expect(multiRun.detail.runs).toHaveLength(8);
    expect(multiRun.detail.attempts).toHaveLength(16);
    expect(multiRun.queryCount).toBe(singleRun.queryCount);
    // Absolute ceiling guards against a constant-but-inflated count that the
    // relative equality above would miss; the per-project dimension is covered
    // by the two-project visibility tests in this file.
    expect(singleRun.queryCount).toBeLessThanOrEqual(16);
  });

  it("uses one eligible run population for correction and autonomy", async () => {
    await seedRun({
      projectId: visibleProjectId,
      flowId: visibleFlowId,
      suffix: "legacy-no-ledger",
    });
    const current = await seedRun({
      projectId: visibleProjectId,
      flowId: visibleFlowId,
      suffix: "current-ledger",
      reworked: true,
    });

    await db
      .insert(schema.nodeAttempts)
      .values(
        attempt(
          current.runId,
          "implement",
          "ai_coding",
          1,
          "Succeeded",
          "current-ledger-impl",
        ),
      );
    await db.insert(schema.hitlRequests).values({
      id: "legacy-hitl",
      runId: "legacy-no-ledger-run",
      stepId: "review",
      kind: "human",
      prompt: "Legacy wait",
      decision: null,
      createdAt: new Date("2026-06-05T11:10:00.000Z"),
      respondedAt: null,
    });

    const project = await getProjectObservatory(
      visibleProjectId,
      { now: NOW },
      db,
    );

    expect(project.totals.correction.runIds).toEqual([current.runId]);
    expect(project.totals.correction.runCount).toBe(1);
    expect(project.totals.autonomy.runIds).toEqual([current.runId]);
    expect(project.totals.autonomy.totalSeconds).toBe(45 * 60);
    expect(project.totals.autonomy.openWaitCount).toBe(0);
  });

  it("uses artifact filters to narrow the shared metric run population", async () => {
    const logRun = await seedRun({
      projectId: visibleProjectId,
      flowId: visibleFlowId,
      suffix: "artifact-log",
    });
    const diffRun = await seedRun({
      projectId: visibleProjectId,
      flowId: visibleFlowId,
      suffix: "artifact-diff",
    });

    await db
      .insert(schema.nodeAttempts)
      .values([
        attempt(
          logRun.runId,
          "implement",
          "ai_coding",
          1,
          "Succeeded",
          "artifact-log-impl-1",
        ),
        attempt(
          diffRun.runId,
          "implement",
          "ai_coding",
          1,
          "Succeeded",
          "artifact-diff-impl-1",
        ),
      ]);
    await db.insert(schema.hitlRequests).values({
      id: "artifact-diff-hitl",
      runId: diffRun.runId,
      stepId: "review",
      kind: "human",
      prompt: "Diff review",
      decision: null,
      createdAt: new Date("2026-06-05T11:30:00.000Z"),
      respondedAt: null,
    });
    await db.insert(schema.artifactInstances).values([
      {
        id: "artifact-log-row",
        runId: logRun.runId,
        nodeAttemptId: "artifact-log-impl-1",
        nodeId: "implement",
        attempt: 1,
        artifactDefId: "runtime-log",
        kind: "log",
        producer: "runner",
        locator: { kind: "inline", text: "redacted" },
        validity: "current",
      },
      {
        id: "artifact-diff-row",
        runId: diffRun.runId,
        nodeAttemptId: "artifact-diff-impl-1",
        nodeId: "implement",
        attempt: 1,
        artifactDefId: "workspace-diff",
        kind: "diff",
        producer: "runner",
        locator: { kind: "inline", text: "redacted" },
        validity: "current",
      },
    ]);

    const logScope = await getProjectObservatory(
      visibleProjectId,
      { now: NOW, artifactKind: "log" },
      db,
    );
    const diffScope = await getProjectObservatory(
      visibleProjectId,
      { now: NOW, artifactDefId: "workspace-diff" },
      db,
    );

    expect(logScope.totals.correction.runIds).toEqual([logRun.runId]);
    expect(logScope.totals.autonomy.runIds).toEqual([logRun.runId]);
    expect(logScope.totals.autonomy.openWaitCount).toBe(0);
    expect(logScope.artifacts.map((artifact) => artifact.artifactKey)).toEqual([
      "def:runtime-log",
    ]);
    expect(diffScope.totals.correction.runIds).toEqual([diffRun.runId]);
    expect(diffScope.totals.autonomy.runIds).toEqual([diffRun.runId]);
    expect(diffScope.totals.autonomy.openWaitCount).toBe(1);
    expect(diffScope.artifacts.map((artifact) => artifact.artifactKey)).toEqual(
      ["def:workspace-diff"],
    );
  });

  it("ranks repeated visible signals without leaking inaccessible project signals", async () => {
    const first = await seedRun({
      projectId: visibleProjectId,
      flowId: visibleFlowId,
      suffix: "signals-first",
    });
    const second = await seedRun({
      projectId: visibleProjectId,
      flowId: visibleFlowId,
      suffix: "signals-second",
    });
    const hidden = await seedRun({
      projectId: hiddenProjectId,
      flowId: hiddenFlowId,
      suffix: "signals-hidden",
    });

    await db.insert(schema.nodeAttempts).values([
      attempt(first.runId, "checks", "check", 1, "Failed", "signals-checks-1", {
        errorCode: "TEST_FAIL",
        exitCode: 1,
      }),
      attempt(
        first.runId,
        "checks",
        "check",
        2,
        "Succeeded",
        "signals-checks-2",
        {
          errorCode: "TEST_FAIL",
        },
      ),
      attempt(
        second.runId,
        "checks",
        "check",
        2,
        "Succeeded",
        "signals-checks-3",
        {
          errorCode: "TEST_FAIL",
        },
      ),
      attempt(hidden.runId, "deploy", "check", 2, "Failed", "hidden-deploy-1", {
        errorCode: "DEPLOY_FAIL",
      }),
    ]);
    await db.insert(schema.hitlRequests).values([
      {
        id: "signals-hitl-1",
        runId: first.runId,
        stepId: "review",
        kind: "human",
        prompt: "Review",
        decision: "rework",
        reworkTarget: "implement",
        workspacePolicy: "keep",
        createdAt: new Date("2026-06-05T11:10:00.000Z"),
        respondedAt: new Date("2026-06-05T11:20:00.000Z"),
      },
      {
        id: "signals-hitl-2",
        runId: second.runId,
        stepId: "review",
        kind: "human",
        prompt: "Review",
        decision: "rework",
        reworkTarget: "implement",
        workspacePolicy: "keep",
        createdAt: new Date("2026-06-05T11:15:00.000Z"),
        respondedAt: new Date("2026-06-05T11:25:00.000Z"),
      },
    ]);
    await db.insert(schema.gateResults).values([
      {
        id: "signals-gate-1",
        runId: first.runId,
        nodeAttemptId: "signals-checks-1",
        gateId: "unit",
        kind: "command_check",
        mode: "blocking",
        status: "failed",
        verdict: { verdict: "fail", reasons: ["ACCESS_TOKEN=abc failed"] },
      },
      {
        id: "signals-gate-2",
        runId: second.runId,
        nodeAttemptId: "signals-checks-3",
        gateId: "unit",
        kind: "command_check",
        mode: "blocking",
        status: "failed",
        verdict: { verdict: "fail", recommendedAction: "rerun tests" },
      },
      {
        id: "hidden-gate-1",
        runId: hidden.runId,
        nodeAttemptId: "hidden-deploy-1",
        gateId: "deploy",
        kind: "command_check",
        mode: "blocking",
        status: "failed",
        verdict: { verdict: "fail", reasons: ["hidden"] },
      },
    ]);

    const result = await getPortfolioObservatory(
      memberUserId,
      "member",
      { now: NOW },
      db,
    );

    expect(result.topSignals.map((signal) => signal.key)).toContain(
      `gate:${visibleFlowId}:checks:unit:failed`,
    );
    expect(
      result.topSignals.some((signal) => signal.key.includes(hiddenFlowId)),
    ).toBe(false);
    expect(result.topSignals.flatMap((signal) => signal.examples)).toContain(
      "access_token=[redacted] failed",
    );
  });

  it("reconciles additive correction events with distinct run-count semantics", async () => {
    const first = await seedRun({
      projectId: visibleProjectId,
      flowId: visibleFlowId,
      suffix: "reconcile-first",
    });
    const second = await seedRun({
      projectId: visibleProjectId,
      flowId: visibleFlowId,
      suffix: "reconcile-second",
    });
    const hidden = await seedRun({
      projectId: hiddenProjectId,
      flowId: hiddenFlowId,
      suffix: "reconcile-hidden",
    });

    await db.insert(schema.nodeAttempts).values([
      attempt(
        first.runId,
        "implement",
        "ai_coding",
        1,
        "Succeeded",
        "rec-impl-1",
      ),
      attempt(first.runId, "checks", "check", 1, "Failed", "rec-checks-1", {
        errorCode: "TEST_FAIL",
      }),
      attempt(first.runId, "checks", "check", 2, "Succeeded", "rec-checks-2", {
        errorCode: "TEST_FAIL",
      }),
      attempt(second.runId, "checks", "check", 1, "Reworked", "rec-checks-3", {
        errorCode: "TEST_FAIL",
      }),
      attempt(hidden.runId, "checks", "check", 2, "Failed", "rec-hidden-1", {
        errorCode: "HIDDEN",
      }),
    ]);
    await db.insert(schema.gateResults).values({
      id: "rec-gate-1",
      runId: first.runId,
      nodeAttemptId: "rec-checks-1",
      gateId: "unit",
      kind: "command_check",
      mode: "blocking",
      status: "failed",
      verdict: { verdict: "fail", reasons: ["unit failed"] },
    });

    const project = await getProjectObservatory(
      visibleProjectId,
      { now: NOW },
      db,
    );
    const checksDetail = await getNodeObservatoryDetail(
      visibleProjectId,
      "checks",
      { now: NOW },
      db,
    );
    const nodeRunCountSum = project.nodes.reduce(
      (sum, node) => sum + node.runCount,
      0,
    );

    expect(project.totals.correction.runCount).toBe(2);
    expect(nodeRunCountSum).toBeGreaterThan(project.totals.correction.runCount);
    expect(checksDetail.correction.runCount).toBe(2);
    expect(checksDetail.runs.map((run) => run.runId).sort()).toEqual([
      first.runId,
      second.runId,
    ]);
    expect(checksDetail.runs.some((run) => run.runId === hidden.runId)).toBe(
      false,
    );
  });

  it("rolls up harness firing, never-fired flags, effectiveness, and coverage from seeded revisions", async () => {
    await seedFlowRevision({
      id: "rev-harness",
      manifest: {
        schemaVersion: 1,
        name: "aif",
        nodes: [
          {
            id: "implement",
            type: "ai_coding",
            action: { prompt: "implement {{ task.prompt }}" },
            settings: { skills: ["aif-implement"] },
            transitions: { success: "checks" },
          },
          {
            id: "checks",
            type: "check",
            action: { command: "pnpm test" },
            pre_finish: {
              gates: [
                { id: "unit", kind: "command_check", mode: "blocking" },
                { id: "lint", kind: "command_check" },
              ],
            },
          },
        ],
      },
    });
    await seedFlowRevision({
      id: "rev-broken",
      manifest: { schemaVersion: 1, name: "broken", nodes: "garbage" },
    });

    const runA = await seedRun({
      projectId: visibleProjectId,
      flowId: visibleFlowId,
      suffix: "harness-a",
      flowRevisionId: "rev-harness",
      resolvedCapabilitySet: capabilitySet(["strict-rule"]),
    });
    const runB = await seedRun({
      projectId: visibleProjectId,
      flowId: visibleFlowId,
      suffix: "harness-b",
      flowRevisionId: "rev-harness",
      resolvedCapabilitySet: capabilitySet([]),
    });
    const runC = await seedRun({
      projectId: visibleProjectId,
      flowId: visibleFlowId,
      suffix: "harness-c",
    });
    const runD = await seedRun({
      projectId: visibleProjectId,
      flowId: visibleFlowId,
      suffix: "harness-d",
      flowRevisionId: "rev-broken",
      resolvedCapabilitySet: capabilitySet([]),
    });

    await db
      .insert(schema.nodeAttempts)
      .values([
        attempt(
          runA.runId,
          "checks",
          "check",
          1,
          "Failed",
          "harness-a-checks-1",
        ),
        attempt(
          runA.runId,
          "checks",
          "check",
          2,
          "Succeeded",
          "harness-a-checks-2",
        ),
        attempt(
          runB.runId,
          "checks",
          "check",
          1,
          "Succeeded",
          "harness-b-checks-1",
        ),
        attempt(
          runC.runId,
          "checks",
          "check",
          1,
          "Succeeded",
          "harness-c-checks-1",
        ),
        attempt(
          runD.runId,
          "checks",
          "check",
          1,
          "Succeeded",
          "harness-d-checks-1",
        ),
      ]);

    const gate = (
      id: string,
      runId: string,
      nodeAttemptId: string,
      gateId: string,
      status: "passed" | "failed",
    ): typeof schema.gateResults.$inferInsert => ({
      id,
      runId,
      nodeAttemptId,
      gateId,
      kind: "command_check",
      mode: "blocking",
      status,
    });

    await db
      .insert(schema.gateResults)
      .values([
        gate("hg-unit-a1", runA.runId, "harness-a-checks-1", "unit", "failed"),
        gate("hg-unit-a2", runA.runId, "harness-a-checks-2", "unit", "passed"),
        gate("hg-unit-b1", runB.runId, "harness-b-checks-1", "unit", "passed"),
        gate("hg-unit-c1", runC.runId, "harness-c-checks-1", "unit", "passed"),
        ...Array.from({ length: 5 }, (_, index) =>
          gate(
            `hg-lint-a-${index}`,
            runA.runId,
            "harness-a-checks-2",
            "lint",
            "passed",
          ),
        ),
        ...Array.from({ length: 5 }, (_, index) =>
          gate(
            `hg-lint-b-${index}`,
            runB.runId,
            "harness-b-checks-1",
            "lint",
            "passed",
          ),
        ),
      ]);

    const project = await getProjectObservatory(
      visibleProjectId,
      { now: NOW },
      db,
    );

    const unit = project.harness.firing.groups.find(
      (group) => group.gateId === "unit",
    );
    const lint = project.harness.firing.groups.find(
      (group) => group.gateId === "lint",
    );

    expect(unit).toMatchObject({
      flowId: visibleFlowId,
      flowRefId: "aif",
      nodeId: "checks",
      executions: 4,
      passed: 3,
      failed: 1,
      failRate: 0.25,
    });
    expect(lint).toMatchObject({
      executions: 10,
      passed: 10,
      failed: 0,
      stale: 0,
      failRate: 0,
    });

    expect(project.harness.neverFired).toEqual([
      {
        flowId: visibleFlowId,
        flowRefId: "aif",
        nodeId: "checks",
        gateId: "lint",
        kind: "command_check",
        executions: 10,
      },
    ]);

    const unitEffectiveness = project.harness.effectiveness.gates.find(
      (row) => row.gateId === "unit",
    );

    expect(unitEffectiveness).toMatchObject({
      failedAttempts: 1,
      failedFollowedByRework: 1,
      passedAttempts: 3,
      passedFollowedByRework: 0,
      reworkRateAfterFail: 1,
      reworkRateAfterPass: 0,
      lift: null,
    });

    const capability = project.harness.effectiveness.capabilities.find(
      (row) => row.refId === "strict-rule",
    );

    expect(capability?.capabilityKind).toBe("rule");
    expect(capability?.withCapability.runCount).toBe(1);
    expect(capability?.withCapability.retryCount).toBe(1);
    expect(capability?.withCapability.correctionRate).toBe(1);
    // runB + runD carry resolved-but-empty sets; runC (null set) is excluded.
    expect(capability?.withoutCapability.runCount).toBe(2);
    expect(capability?.withoutCapability.correctionRate).toBe(0);
    expect(capability?.withoutCapability.runIds).not.toContain(runC.runId);

    expect(project.harness.coverage).toHaveLength(1);

    const flowCoverage = project.harness.coverage[0];

    expect(flowCoverage?.flowId).toBe(visibleFlowId);
    expect(flowCoverage?.flowRefId).toBe("aif");
    // rev-broken fails manifest parsing and is skipped with a WARN.
    expect(flowCoverage?.revisionCount).toBe(1);

    const checksCoverage = flowCoverage?.nodes.find(
      (node) => node.nodeId === "checks",
    );
    const implementCoverage = flowCoverage?.nodes.find(
      (node) => node.nodeId === "implement",
    );

    expect(checksCoverage).toMatchObject({
      gateCount: 2,
      blockingGateCount: 2,
      advisoryGateCount: 0,
      guideCount: 0,
      guidesWithoutSensors: false,
      // node attempts on (flow, checks): runA×2 + runB + runC + runD — NOT
      // per-gate evaluations (the unit+lint sum would be 14).
      executions: 5,
    });
    expect(implementCoverage).toMatchObject({
      gateCount: 0,
      blockingGateCount: 0,
      guideCount: 1,
      guidesWithoutSensors: true,
      executions: 0,
    });

    const portfolio = await getPortfolioObservatory(
      memberUserId,
      "member",
      { now: NOW },
      db,
    );

    expect(portfolio.harness.neverFired).toEqual(project.harness.neverFired);
    expect(portfolio.harness.coverage).toEqual(project.harness.coverage);
  });
});

async function measureNodeDetailQueries(runCount: number): Promise<{
  detail: Awaited<ReturnType<typeof getNodeObservatoryDetail>>;
  project: Awaited<ReturnType<typeof getProjectObservatory>>;
  queryCount: number;
}> {
  const seededRuns = await Promise.all(
    Array.from({ length: runCount }, (_, index) =>
      seedRun({
        projectId: visibleProjectId,
        flowId: visibleFlowId,
        suffix: `node-detail-${runCount}-${index}`,
      }),
    ),
  );

  await db.insert(schema.nodeAttempts).values(
    seededRuns.flatMap(({ runId }, index) => [
      attempt(runId, "checks", "check", 1, "Failed", `checks-${index}-1`, {
        errorCode: "TEST_FAIL",
        exitCode: 1,
      }),
      attempt(runId, "checks", "check", 2, "Succeeded", `checks-${index}-2`),
    ]),
  );
  await db.insert(schema.gateResults).values({
    id: `gate-checks-${runCount}`,
    runId: seededRuns[0]?.runId ?? "missing",
    nodeAttemptId: "checks-0-1",
    gateId: "unit",
    kind: "command_check",
    mode: "blocking",
    status: "failed",
    verdict: {
      verdict: "fail",
      reasons: ["unit failed"],
      recommendedAction: "rerun",
    },
  });

  const counted = withQueryCount(db);
  const project = await getProjectObservatory(
    visibleProjectId,
    { now: NOW },
    counted.db,
  );
  const detail = await getNodeObservatoryDetail(
    visibleProjectId,
    "checks",
    { now: NOW },
    counted.db,
  );

  return { detail, project, queryCount: counted.count() };
}

async function resetRunRows(): Promise<void> {
  await db.delete(schema.artifactInstances);
  await db.delete(schema.gateResults);
  await db.delete(schema.hitlRequests);
  await db.delete(schema.nodeAttempts);
  await db.delete(schema.runs);
  await db.delete(schema.tasks);
}

async function seedRun(input: {
  projectId: string;
  flowId: string;
  suffix: string;
  reworked?: boolean;
  flowRevisionId?: string;
  resolvedCapabilitySet?: schema.ResolvedCapabilitySet;
}): Promise<{ runId: string; implementAttemptId: string }> {
  const taskId = `${input.suffix}-task`;
  const runId = `${input.suffix}-run`;
  const implementAttemptId = `${input.suffix}-impl-1`;

  await db.insert(schema.tasks).values({ number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId: input.projectId,
    title: input.suffix,
    prompt: input.suffix,
    flowId: input.flowId,
    status: "InFlight",
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId: input.projectId,
    flowId: input.flowId,
    status: input.reworked ? "Review" : "Running",
    flowVersion: "v1.0.0",
    flowRevisionId: input.flowRevisionId ?? null,
    resolvedCapabilitySet: input.resolvedCapabilitySet ?? null,
    startedAt: new Date("2026-06-05T11:00:00.000Z"),
    endedAt: input.reworked ? new Date("2026-06-05T11:45:00.000Z") : null,
  });

  return { runId, implementAttemptId };
}

async function seedDomainEvent(input: {
  projectId: string;
  kind: schema.DomainEventRow["kind"];
  reason: string;
  createdAt?: Date;
}): Promise<void> {
  const at = input.createdAt ?? new Date(NOW.getTime() - 60 * 60 * 1000);

  await db.insert(schema.domainEvents).values({
    kind: input.kind,
    projectId: input.projectId,
    runId: null,
    actorType: "system",
    actorId: null,
    payload: { reason: input.reason },
    occurredAt: at,
    createdAt: at,
  });
}

async function seedFlowRevision(input: {
  id: string;
  manifest: unknown;
}): Promise<void> {
  await db.insert(schema.flowRevisions).values({
    id: input.id,
    flowRefId: "aif",
    source: "github.com/acme/aif",
    versionLabel: "v1.0.0",
    resolvedRevision: input.id,
    manifestDigest: `digest-${input.id}`,
    manifest: input.manifest,
    schemaVersion: 1,
    installedPath: `/tmp/flows/${input.id}`,
  });
}

function capabilitySet(refIds: string[]): schema.ResolvedCapabilitySet {
  return {
    flowRevisionId: "rev-harness",
    flowOrigin: "git",
    capabilities: refIds.map((refId) => ({
      refId,
      kind: "rule",
      sha: null,
      scope: "project",
    })),
    mcps: [],
  };
}

function attempt(
  runId: string,
  nodeId: string,
  nodeType: "ai_coding" | "check" | "human",
  attemptNumber: number,
  status: "Succeeded" | "Failed" | "Reworked",
  id: string,
  opts: { errorCode?: string; exitCode?: number } = {},
): typeof schema.nodeAttempts.$inferInsert {
  return {
    id,
    runId,
    nodeId,
    nodeType,
    attempt: attemptNumber,
    status,
    errorCode: opts.errorCode,
    exitCode: opts.exitCode,
  };
}

function withQueryCount(database: NodePgDatabase<typeof schema>): {
  db: NodePgDatabase<typeof schema>;
  count: () => number;
} {
  let statements = 0;

  return {
    db: new Proxy(database, {
      get(target, prop, receiver) {
        if (prop === "select") {
          const select = Reflect.get(target, prop, receiver) as unknown as (
            ...args: unknown[]
          ) => unknown;

          return (...args: unknown[]) => {
            statements += 1;

            return select.apply(target, args);
          };
        }

        return Reflect.get(target, prop, receiver);
      },
    }) as NodePgDatabase<typeof schema>,
    count: () => statements,
  };
}
