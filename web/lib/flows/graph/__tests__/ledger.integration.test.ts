import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches schema.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import {
  appendNodeAttempt,
  claimTakeover,
  getActiveTakeover,
  getNodeAttemptsForRun,
  latestAttemptByNode,
  markDownstreamStale,
  markNodeReworked,
  markNodeSucceeded,
  nextAttemptFor,
  recordTakeoverReturn,
  setMaterializationPlan,
} from "@/lib/flows/graph/ledger";
import {
  blockingGatesSatisfied,
  createGateResult,
  getGateResultsForNodeAttempt,
  markGateOverridden,
  markGatePassed,
} from "@/lib/flows/graph/gate-store";

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
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
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
  });

  return runId;
}

describe("node_attempts ledger (append-only)", () => {
  it("auto-increments attempt per (run, node) and never mutates prior rows", async () => {
    const runId = await seedRun();

    expect(await nextAttemptFor(runId, "implement", db)).toBe(1);

    const a1 = await appendNodeAttempt({
      runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      db,
    });

    expect(a1.attempt).toBe(1);
    await markNodeSucceeded(
      a1.id,
      { stdout: "first", vars: { x: 1 }, acpSessionId: "sess-1" },
      db,
    );

    // Second attempt for the same node — append-only, attempt 2.
    expect(await nextAttemptFor(runId, "implement", db)).toBe(2);
    const a2 = await appendNodeAttempt({
      runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      reworkFromNode: "review",
      db,
    });

    expect(a2.attempt).toBe(2);
    await markNodeSucceeded(a2.id, { stdout: "second" }, db);

    const rows = await getNodeAttemptsForRun(runId, db);
    const implementRows = rows.filter((r) => r.nodeId === "implement");

    expect(implementRows).toHaveLength(2);

    // Prior attempt row is untouched (append-only): still its original stdout.
    const first = implementRows.find((r) => r.attempt === 1);

    expect(first?.stdout).toBe("first");
    expect(first?.status).toBe("Succeeded");
    expect(first?.acpSessionId).toBe("sess-1");

    const latest = latestAttemptByNode(rows);

    expect(latest.get("implement")?.attempt).toBe(2);
    expect(latest.get("implement")?.reworkFromNode).toBe("review");
  });

  it("markDownstreamStale stales only the latest attempt + its passed gates", async () => {
    const runId = await seedRun();

    // implement attempt 1 (Succeeded, historical).
    const old = await appendNodeAttempt({
      runId,
      nodeId: "checks",
      nodeType: "check",
      db,
    });

    await markNodeSucceeded(old.id, {}, db);

    // checks attempt 2 (current) with a passed blocking gate.
    const cur = await appendNodeAttempt({
      runId,
      nodeId: "checks",
      nodeType: "check",
      db,
    });

    await markNodeSucceeded(cur.id, {}, db);
    const gate = await createGateResult({
      runId,
      nodeAttemptId: cur.id,
      gateId: "test",
      kind: "command_check",
      mode: "blocking",
      db,
    });

    await markGatePassed(gate.id, { verdict: "pass" }, db);

    const result = await markDownstreamStale(runId, ["checks"], db);

    expect(result.staledNodes).toBe(1);
    expect(result.staledGates).toBe(1);

    const rows = await getNodeAttemptsForRun(runId, db);

    // Latest attempt -> Stale; prior attempt stays Succeeded (immutable).
    expect(rows.find((r) => r.id === cur.id)?.status).toBe("Stale");
    expect(rows.find((r) => r.id === old.id)?.status).toBe("Succeeded");

    const gates = await getGateResultsForNodeAttempt(cur.id, db);

    expect(gates[0].status).toBe("stale");
  });

  it("markNodeReworked records the decision on the review attempt", async () => {
    const runId = await seedRun();
    const review = await appendNodeAttempt({
      runId,
      nodeId: "review",
      nodeType: "human",
      db,
    });

    await markNodeReworked(
      review.id,
      { decision: "rework", workspacePolicy: "keep" },
      db,
    );

    const row = (await getNodeAttemptsForRun(runId, db)).find(
      (r) => r.id === review.id,
    );

    expect(row?.status).toBe("Reworked");
    expect(row?.decision).toBe("rework");
    expect(row?.workspacePolicy).toBe("keep");
  });

  it("setMaterializationPlan is write-once: the second call does not overwrite the first plan (T4.4)", async () => {
    const runId = await seedRun();
    const na = await appendNodeAttempt({
      runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      db,
    });

    const first = {
      profileDigest: "digest-first",
      resolvedRevisions: [{ refId: "github", kind: "mcp", sha: "sha-1111" }],
      materializedFiles: ["/tmp/profile.json"],
      enforcedClasses: ["github"],
      instructedClasses: [],
      refusedClasses: [],
      cleanup: { status: "pending" as const },
    };
    const second = {
      profileDigest: "digest-second",
      resolvedRevisions: [{ refId: "other", kind: "skill", sha: "sha-9999" }],
      materializedFiles: ["/tmp/other.json"],
      enforcedClasses: [],
      instructedClasses: ["other"],
      refusedClasses: [],
      cleanup: { status: "pending" as const },
    };

    await setMaterializationPlan(na.id, first, db);
    await setMaterializationPlan(na.id, second, db);

    const row = (await getNodeAttemptsForRun(runId, db)).find(
      (r) => r.id === na.id,
    );

    // The column-IS-NULL guard preserves the run-start snapshot: a resumed
    // attempt re-running the materialize path never rewrites the plan body.
    expect(row?.materializationPlan).toEqual(first);
  });
});

describe("gate_results store", () => {
  it("round-trips a structured verdict and supports override-without-erasure", async () => {
    const runId = await seedRun();
    const na = await appendNodeAttempt({
      runId,
      nodeId: "judge",
      nodeType: "judge",
      db,
    });
    const gate = await createGateResult({
      runId,
      nodeAttemptId: na.id,
      gateId: "quality",
      kind: "ai_judgment",
      mode: "blocking",
      db,
    });

    const verdict = {
      verdict: "fail",
      confidence: 0.8,
      reasons: ["missing tests"],
      recommendedAction: "rework",
    };

    await markGatePassed(gate.id, verdict, db);

    let rows = await getGateResultsForNodeAttempt(na.id, db);

    expect(rows[0].verdict).toEqual(verdict);
    expect(rows[0].status).toBe("passed");

    // Override retains the original verdict (no erasure, ADR-028).
    await markGateOverridden(gate.id, "hitl-123", db);
    rows = await getGateResultsForNodeAttempt(na.id, db);

    expect(rows[0].status).toBe("overridden");
    expect(rows[0].overriddenBy).toBe("hitl-123");
    expect(rows[0].verdict).toEqual(verdict);
  });

  it("blockingGatesSatisfied is true only when every blocking gate passed/overridden", async () => {
    const runId = await seedRun();
    const na = await appendNodeAttempt({
      runId,
      nodeId: "checks",
      nodeType: "check",
      db,
    });

    const g1 = await createGateResult({
      runId,
      nodeAttemptId: na.id,
      gateId: "fmt",
      kind: "command_check",
      mode: "blocking",
      db,
    });
    const g2 = await createGateResult({
      runId,
      nodeAttemptId: na.id,
      gateId: "advisory-quality",
      kind: "ai_judgment",
      mode: "advisory",
      status: "failed",
      db,
    });

    expect(g2).toBeDefined();
    expect(await blockingGatesSatisfied(na.id, db)).toBe(false); // g1 still running

    await markGatePassed(g1.id, undefined, db);

    expect(await blockingGatesSatisfied(na.id, db)).toBe(true); // advisory ignored
  });
});

// M11b Phase 2.3: takeover ledger helpers. claimTakeover appends the
// human_review node's node_attempts row carrying owner_user_id;
// recordTakeoverReturn writes the raw git log/diff + base ref on that row;
// getActiveTakeover reads back the active (un-returned) takeover row.
async function seedUser(): Promise<string> {
  const userId = randomUUID();

  await db.insert(schema.users).values({
    id: userId,
    email: `owner-${userId.slice(0, 8)}@maister.local`,
    role: "member",
  });

  return userId;
}

describe("node_attempts takeover columns (M11b)", () => {
  it("claimTakeover appends a human_review attempt with owner_user_id; getActiveTakeover reads it back", async () => {
    const runId = await seedRun();
    const userId = await seedUser();

    const claim = await claimTakeover({
      runId,
      nodeId: "review",
      userId,
      db,
    });

    expect(claim.attempt).toBe(1);

    const active = await getActiveTakeover(runId, db);

    expect(active?.id).toBe(claim.id);
    expect(active?.nodeId).toBe("review");
    expect(active?.nodeType).toBe("human");
    expect(active?.ownerUserId).toBe(userId);
    // No return recorded yet: the takeover columns are still null.
    expect(active?.returnedCommits).toBeNull();
    expect(active?.returnedDiff).toBeNull();
    expect(active?.baseRef).toBeNull();
    expect(active?.endedAt).toBeNull();
  });

  it("recordTakeoverReturn writes returned_commits / returned_diff / base_ref on the takeover row + ends it", async () => {
    const runId = await seedRun();
    const userId = await seedUser();

    const claim = await claimTakeover({
      runId,
      nodeId: "review",
      userId,
      db,
    });

    await recordTakeoverReturn({
      runId,
      nodeId: "review",
      baseRef: "abc123",
      returnedCommits: "abc123 fix the thing",
      returnedDiff: "diff --git a/x b/x\n+changed",
      db,
    });

    const row = (await getNodeAttemptsForRun(runId, db)).find(
      (r) => r.id === claim.id,
    );

    expect(row?.ownerUserId).toBe(userId);
    expect(row?.baseRef).toBe("abc123");
    expect(row?.returnedCommits).toBe("abc123 fix the thing");
    expect(row?.returnedDiff).toBe("diff --git a/x b/x\n+changed");
    expect(row?.endedAt).not.toBeNull();
  });

  it("getActiveTakeover returns null once the takeover row has been returned", async () => {
    const runId = await seedRun();
    const userId = await seedUser();

    await claimTakeover({ runId, nodeId: "review", userId, db });
    await recordTakeoverReturn({
      runId,
      nodeId: "review",
      baseRef: "base",
      returnedCommits: "c",
      returnedDiff: "d",
      db,
    });

    const active = await getActiveTakeover(runId, db);

    expect(active).toBeNull();
  });

  it("owner_user_id FK SET NULL: deleting the owner nulls the column, leaving the audit row", async () => {
    const runId = await seedRun();
    const userId = await seedUser();

    const claim = await claimTakeover({ runId, nodeId: "review", userId, db });

    await db.delete(schema.users).where(eq(schema.users.id, userId));

    const row = (await getNodeAttemptsForRun(runId, db)).find(
      (r) => r.id === claim.id,
    );

    expect(row).toBeDefined();
    expect(row?.ownerUserId).toBeNull();
  });
});
