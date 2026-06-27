import type { ArtifactInstance, NodeAttempt, Run } from "@/lib/db/schema";
import type { ExecutionPolicy } from "@/lib/runs/execution-policy";

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { runFlow } from "@/lib/flows/runner";

// ADR-072 runner-side review-comment compose (Task 7): open threads compose
// into the rework commentsVar, the review-gate schema carries
// { maxLoops, gateAttempt }, and the composed payload is recorded as a
// human_note evidence artifact linked to the gate's node_attempt.

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

type Seeded = {
  runId: string;
  slug: string;
  runtimeRoot: string;
};

async function seedGraphRun(
  manifest: unknown,
  opts: { executionPolicy?: ExecutionPolicy } = {},
): Promise<Seeded> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const worktreePath = await mkdtemp(join(tmpdir(), "wt-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rt-"));

  await db.insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
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
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
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
    flowVersion: "v1.0.0",
    status: "Running",
    ...(opts.executionPolicy !== undefined
      ? { executionPolicy: opts.executionPolicy }
      : {}),
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
    id: randomUUID(),
    runId,
    projectId,
    branch: "feature/test",
    worktreePath,
    parentRepoPath: `/tmp/${slug}`,
  });

  return { runId, slug, runtimeRoot };
}

async function getRun(runId: string): Promise<Run> {
  const rows = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as unknown as Run[];

  return rows[0];
}

async function getAttempts(runId: string): Promise<NodeAttempt[]> {
  return (await db
    .select()
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.runId, runId))) as unknown as NodeAttempt[];
}

async function getHitlRows(
  runId: string,
): Promise<Array<{ id: string; schema: unknown }>> {
  return (await db
    .select()
    .from(schema.hitlRequests)
    .where(eq(schema.hitlRequests.runId, runId))
    .orderBy(asc(schema.hitlRequests.createdAt))) as Array<{
    id: string;
    schema: unknown;
  }>;
}

type InlineLocator = {
  kind: string;
  text?: string;
  hitlRequestId?: string;
  threadIds?: string[];
};

// The composed-payload evidence rows (kind human_note, locator inline) of a
// run — distinct from recordDefaultArtifacts' human_note rows, which use the
// hitl-response locator.
async function getComposedEvidence(runId: string): Promise<ArtifactInstance[]> {
  const rows = (await db
    .select()
    .from(schema.artifactInstances)
    .where(
      eq(schema.artifactInstances.runId, runId),
    )) as unknown as ArtifactInstance[];

  return rows.filter(
    (r) =>
      r.kind === "human_note" && (r.locator as InlineLocator).kind === "inline",
  );
}

// Mirrors the respond route's two-phase commit observable state: the stored
// response is stamped on the pending hitl row (Phase 1/3) BEFORE the runner
// consumes the input artifact — the evidence recorder reads that row.
async function writeDecision(
  seeded: Seeded,
  nodeId: string,
  decision: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const dir = join(
    seeded.runtimeRoot,
    ".maister",
    seeded.slug,
    "runs",
    seeded.runId,
  );
  const payload = { decision, ...extra };

  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `input-${nodeId}.json`),
    JSON.stringify(payload),
    "utf8",
  );
  await db
    .update(schema.hitlRequests)
    .set({ response: payload, respondedAt: new Date() })
    .where(
      and(
        eq(schema.hitlRequests.runId, seeded.runId),
        eq(schema.hitlRequests.stepId, nodeId),
        isNull(schema.hitlRequests.respondedAt),
      ),
    );
}

async function seedThread(args: {
  runId: string;
  hitlRequestId: string;
  id: string;
  gateAttempt?: number;
  filePath: string;
  side?: "old" | "new";
  line: number;
  lineContent: string;
  authorLabel?: string;
  body: string;
  status?: "open" | "resolved";
  createdAt: Date;
  replies?: Array<{
    id: string;
    authorLabel?: string;
    body: string;
    createdAt: Date;
  }>;
}): Promise<void> {
  await db.insert(schema.reviewComments).values({
    id: args.id,
    runId: args.runId,
    hitlRequestId: args.hitlRequestId,
    nodeId: "review",
    gateAttempt: args.gateAttempt ?? 1,
    authorLabel: args.authorLabel ?? "Alice",
    filePath: args.filePath,
    side: args.side ?? "new",
    line: args.line,
    lineContent: args.lineContent,
    body: args.body,
    status: args.status ?? "open",
    resolvedAt: args.status === "resolved" ? new Date() : null,
    createdAt: args.createdAt,
  });
  for (const reply of args.replies ?? []) {
    await db.insert(schema.reviewComments).values({
      id: reply.id,
      runId: args.runId,
      hitlRequestId: args.hitlRequestId,
      nodeId: "review",
      gateAttempt: args.gateAttempt ?? 1,
      parentId: args.id,
      authorLabel: reply.authorLabel ?? "Bob",
      body: reply.body,
      status: "open",
      createdAt: reply.createdAt,
    });
  }
}

// `fix` echoes the injected var verbatim (printf %s adds no trailing newline),
// so node_attempts.stdout IS the injected commentsVar value, byte-exact.
const composeFlow = {
  schemaVersion: 1,
  name: "g",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "plan",
      type: "cli",
      action: { command: "echo plan" },
      transitions: { success: "review" },
    },
    {
      id: "review",
      type: "human",
      finish: {
        human: {
          decisions: ["approve", "rework"],
          commentsVar: "review_comments",
        },
      },
      transitions: { approve: "done", rework: "fix" },
      rework: {
        allowedTargets: ["fix"],
        workspacePolicies: ["keep"],
        maxLoops: 2,
        commentsVar: "review_comments",
      },
    },
    {
      id: "fix",
      type: "cli",
      action: { command: `printf '%s' "{{ review_comments }}"` },
      transitions: { success: "done" },
    },
  ],
};

// fix loops back to review, so a second rework composes again at gate visit 2.
const loopFlow = {
  schemaVersion: 1,
  name: "g",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "plan",
      type: "cli",
      action: { command: "echo plan" },
      transitions: { success: "review" },
    },
    {
      id: "review",
      type: "human",
      finish: {
        human: {
          decisions: ["approve", "rework"],
          commentsVar: "review_comments",
        },
      },
      transitions: { approve: "done", rework: "fix" },
      rework: {
        allowedTargets: ["fix"],
        workspacePolicies: ["keep"],
        maxLoops: 3,
        commentsVar: "review_comments",
      },
    },
    {
      id: "fix",
      type: "cli",
      action: { command: `printf '%s' "{{ review_comments }}"` },
      transitions: { success: "review" },
    },
  ],
};

// maxLoops: 1, fix loops back to review — the exhaustion boundary flow:
// gate visits 1 and 2 are allowed (total = maxLoops + 1), a FRESH visit 3
// must never start (docs/system-analytics/review-comments.md).
const boundaryFlow = {
  schemaVersion: 1,
  name: "g",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "plan",
      type: "cli",
      action: { command: "echo plan" },
      transitions: { success: "review" },
    },
    {
      id: "review",
      type: "human",
      finish: {
        human: {
          decisions: ["approve", "rework"],
          commentsVar: "review_comments",
        },
      },
      transitions: { approve: "done", rework: "fix" },
      rework: {
        allowedTargets: ["fix"],
        workspacePolicies: ["keep"],
        maxLoops: 1,
        commentsVar: "review_comments",
      },
    },
    {
      id: "fix",
      type: "cli",
      action: { command: `printf '%s' "{{ review_comments }}"` },
      transitions: { success: "review" },
    },
  ],
};

// A review gate with NO rework block — maxLoops must stamp null.
const noReworkFlow = {
  schemaVersion: 1,
  name: "g",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "plan",
      type: "cli",
      action: { command: "echo plan" },
      transitions: { success: "review" },
    },
    {
      id: "review",
      type: "human",
      finish: { human: { decisions: ["approve"] } },
      transitions: { approve: "done" },
    },
  ],
};

// The FROZEN serialization (docs/system-analytics/review-comments.md) for the
// two-thread fixture below — hardcoded, never derived from the composer.
const EXPECTED_COMPOSED = [
  "fix-the-error-handling",
  "",
  "## Review comments",
  "",
  "### lib/a.ts:3 (new)",
  "",
  "> const a = 1;",
  "",
  "**Alice:**",
  "",
  "Rename this variable",
  "",
  "**Reply — Bob:**",
  "",
  "Agreed",
  "",
  "### lib/b.ts:10 (old)",
  "",
  "> return x;",
  "",
  "**Alice:**",
  "",
  "Avoid early return",
].join("\n");

async function seedTwoThreads(
  runId: string,
  hitlRequestId: string,
): Promise<{ rootA: string; rootB: string }> {
  const rootA = randomUUID();
  const rootB = randomUUID();

  // Inserted out of (file_path) order on purpose — compose must re-order.
  await seedThread({
    runId,
    hitlRequestId,
    id: rootB,
    filePath: "lib/b.ts",
    side: "old",
    line: 10,
    lineContent: "return x;",
    body: "Avoid early return",
    createdAt: new Date("2026-06-10T10:02:00Z"),
  });
  await seedThread({
    runId,
    hitlRequestId,
    id: rootA,
    filePath: "lib/a.ts",
    side: "new",
    line: 3,
    lineContent: "const a = 1;",
    body: "Rename this variable",
    createdAt: new Date("2026-06-10T10:00:00Z"),
    replies: [
      {
        id: randomUUID(),
        body: "Agreed",
        createdAt: new Date("2026-06-10T10:05:00Z"),
      },
    ],
  });

  return { rootA, rootB };
}

describe("runGraph — ADR-072 review-comment compose into commentsVar", () => {
  it("composes two open threads (file/line ordered, replies included) into the rework target's context", async () => {
    const seeded = await seedGraphRun(composeFlow);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    const gate = (await getHitlRows(seeded.runId))[0];

    await seedTwoThreads(seeded.runId, gate.id);

    await writeDecision(seeded, "review", "rework", {
      comments: "fix-the-error-handling",
    });
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const fix = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "fix",
    );

    expect(fix?.status).toBe("Succeeded");
    expect(fix?.stdout).toBe(EXPECTED_COMPOSED);
  }, 60_000);

  it("zero open threads → injected value is BYTE-IDENTICAL to the raw summary", async () => {
    const seeded = await seedGraphRun(composeFlow);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    await writeDecision(seeded, "review", "rework", {
      comments: "tighten-errors",
    });
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const fix = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "fix",
    );

    expect(fix?.status).toBe("Succeeded");
    // Hard regression guarantee (D3): byte-identity, not just containment.
    expect(fix?.stdout).toBe("tighten-errors");
  }, 60_000);

  it("zero open threads + no summary → nothing injected (seeded empty commentsVar renders)", async () => {
    const seeded = await seedGraphRun(composeFlow);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const fix = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "fix",
    );

    expect(fix?.status).toBe("Succeeded");
    expect(fix?.stdout).toBe("");

    // No compose happened → no composed-payload evidence row either.
    expect(await getComposedEvidence(seeded.runId)).toHaveLength(0);
  }, 60_000);

  it("resolved threads never serialize", async () => {
    const seeded = await seedGraphRun(composeFlow);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const gate = (await getHitlRows(seeded.runId))[0];

    await seedThread({
      runId: seeded.runId,
      hitlRequestId: gate.id,
      id: randomUUID(),
      filePath: "lib/open.ts",
      line: 1,
      lineContent: "open line",
      body: "Still-unaddressed",
      createdAt: new Date("2026-06-10T10:00:00Z"),
    });
    await seedThread({
      runId: seeded.runId,
      hitlRequestId: gate.id,
      id: randomUUID(),
      filePath: "lib/resolved.ts",
      line: 2,
      lineContent: "resolved line",
      body: "Already-addressed",
      status: "resolved",
      createdAt: new Date("2026-06-10T10:01:00Z"),
    });

    await writeDecision(seeded, "review", "rework", { comments: "summary" });
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const fix = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "fix",
    );

    expect(fix?.stdout).toContain("Still-unaddressed");
    expect(fix?.stdout).toContain("### lib/open.ts:1 (new)");
    expect(fix?.stdout).not.toContain("Already-addressed");
    expect(fix?.stdout).not.toContain("lib/resolved.ts");
  }, 60_000);

  it("threads authored at gate visit 1 still compose at visit 2's rework (cross-iteration carry)", async () => {
    const seeded = await seedGraphRun(loopFlow);

    // Visit 1: pause; author one thread; rework.
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const visit1 = (await getHitlRows(seeded.runId))[0];

    await seedThread({
      runId: seeded.runId,
      hitlRequestId: visit1.id,
      id: randomUUID(),
      filePath: "lib/c.ts",
      line: 5,
      lineContent: "let y = 2;",
      authorLabel: "Carol",
      body: "Use-const-here",
      createdAt: new Date("2026-06-10T10:00:00Z"),
    });
    await writeDecision(seeded, "review", "rework", { comments: "first-pass" });
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    // Visit 2: NO new comments; rework again — the still-open visit-1 thread
    // must compose into fix attempt 2.
    await writeDecision(seeded, "review", "rework", {
      comments: "second-pass",
    });
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const fixAttempts = (await getAttempts(seeded.runId))
      .filter((a) => a.nodeId === "fix")
      .sort((a, b) => a.attempt - b.attempt);

    expect(fixAttempts).toHaveLength(2);
    expect(fixAttempts[1].stdout).toContain("second-pass");
    expect(fixAttempts[1].stdout).toContain("### lib/c.ts:5 (new)");
    expect(fixAttempts[1].stdout).toContain("> let y = 2;");
    expect(fixAttempts[1].stdout).toContain("**Carol:**");
    expect(fixAttempts[1].stdout).toContain("Use-const-here");
  }, 60_000);
});

describe("runGraph — ADR-072 review-gate schema { maxLoops, gateAttempt }", () => {
  it("stamps maxLoops from rework and the 1-based visit number across gate visits", async () => {
    const seeded = await seedGraphRun(loopFlow);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    await writeDecision(seeded, "review", "rework", { comments: "again" });
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const hitl = await getHitlRows(seeded.runId);

    expect(hitl).toHaveLength(2);
    expect(
      (hitl[0].schema as { maxLoops: number; gateAttempt: number }).maxLoops,
    ).toBe(3);
    expect(
      (hitl[0].schema as { maxLoops: number; gateAttempt: number }).gateAttempt,
    ).toBe(1);
    expect(
      (hitl[1].schema as { maxLoops: number; gateAttempt: number }).maxLoops,
    ).toBe(3);
    expect(
      (hitl[1].schema as { maxLoops: number; gateAttempt: number }).gateAttempt,
    ).toBe(2);
  }, 60_000);

  it("stamps maxLoops null when the review node declares no rework", async () => {
    const seeded = await seedGraphRun(noReworkFlow);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    const hitl = await getHitlRows(seeded.runId);

    expect(hitl).toHaveLength(1);
    expect((hitl[0].schema as { maxLoops: number | null }).maxLoops).toBeNull();
    expect((hitl[0].schema as { gateAttempt: number }).gateAttempt).toBe(1);
  });
});

describe("runGraph — ADR-072 loop-exhaustion engine boundary (total visits = maxLoops + 1)", () => {
  it("approve at the final allowed visit (gateAttempt = maxLoops + 1) proceeds — NOT Failed", async () => {
    const seeded = await seedGraphRun(boundaryFlow);

    // Visit 1.
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    // Rework at visit 1 (allowed: gateAttempt 1 ≤ maxLoops 1) → visit 2.
    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    // APPROVE at visit 2 (= maxLoops + 1, the final allowed visit). The
    // resume REUSES visit 2's existing attempt row, so the ledger count
    // already includes this visit — the loop bound must not kill the
    // decision (it guards STARTING fresh visit maxLoops + 2, not processing
    // the final allowed one).
    await writeDecision(seeded, "review", "approve");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const review2 = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "review" && a.attempt === 2,
    );

    expect(review2?.status).toBe("Succeeded");
    expect(review2?.decision).toBe("approve");
  }, 60_000);

  it("an overrunning rework at the final visit with reworkExhaustion=fail → run Failed at the decision site (A.2)", async () => {
    // boundaryFlow has maxLoops: 1. Under the explicit `fail` action the
    // overrunning rework (gateAttempt 2 > maxLoops 1) is intercepted at the
    // rework-decision site (A.2) and the run Fails — the pre-A.2 outcome, now
    // policy-driven rather than the loop-top backstop (which remains as
    // defense-in-depth). The overrun rework is NOT consumed into a Reworked
    // attempt: the visit-2 row is marked Failed and no third review row starts.
    const seeded = await seedGraphRun(boundaryFlow, {
      executionPolicy: {
        preset: "supervised",
        overrides: { reworkExhaustion: "fail" },
      },
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Failed");

    const reviewAttempts = (await getAttempts(seeded.runId)).filter(
      (a) => a.nodeId === "review",
    );

    expect(reviewAttempts).toHaveLength(2);
    expect(reviewAttempts.find((a) => a.attempt === 2)?.status).toBe("Failed");
  }, 60_000);
});

describe("runGraph — ADR-072 composed-payload evidence (human_note, locator inline)", () => {
  it("records exactly one inline human_note per compose, linked to the gate's node_attempt", async () => {
    const seeded = await seedGraphRun(composeFlow);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const gate = (await getHitlRows(seeded.runId))[0];
    const { rootA, rootB } = await seedTwoThreads(seeded.runId, gate.id);

    await writeDecision(seeded, "review", "rework", {
      comments: "fix-the-error-handling",
    });
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const evidence = await getComposedEvidence(seeded.runId);

    expect(evidence).toHaveLength(1);

    const row = evidence[0];
    const reviewAttempt1 = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "review" && a.attempt === 1,
    );

    expect(row.producer).toBe("runner");
    expect(row.nodeId).toBe("review");
    expect(row.attempt).toBe(1);
    expect(row.nodeAttemptId).toBe(reviewAttempt1?.id);
    expect(row.validity).toBe("current");
    // Reserved `adr071:` namespace — declared-output ids are
    // `run:<nodeAttemptId>:<artifactDefId>`, so a def literally named
    // `rework-comments` can never collide with this runner-internal row.
    expect(row.id).toBe(`run:${reviewAttempt1?.id}:adr071:rework-comments`);

    const locator = row.locator as InlineLocator;

    expect(locator.text).toBe(EXPECTED_COMPOSED);
    expect(locator.hitlRequestId).toBe(gate.id);
    // Serialized order: lib/a.ts before lib/b.ts.
    expect(locator.threadIds).toEqual([rootA, rootB]);
  }, 60_000);

  it("zero-thread compose records evidence with the raw summary and empty threadIds", async () => {
    const seeded = await seedGraphRun(composeFlow);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    await writeDecision(seeded, "review", "rework", {
      comments: "tighten-errors",
    });
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const evidence = await getComposedEvidence(seeded.runId);

    expect(evidence).toHaveLength(1);
    expect((evidence[0].locator as InlineLocator).text).toBe("tighten-errors");
    expect((evidence[0].locator as InlineLocator).threadIds).toEqual([]);
  }, 60_000);

  it("a later compose stays current while the prior visit's evidence goes stale", async () => {
    const seeded = await seedGraphRun(loopFlow);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const visit1 = (await getHitlRows(seeded.runId))[0];

    await seedThread({
      runId: seeded.runId,
      hitlRequestId: visit1.id,
      id: randomUUID(),
      filePath: "lib/c.ts",
      line: 5,
      lineContent: "let y = 2;",
      body: "Use-const-here",
      createdAt: new Date("2026-06-10T10:00:00Z"),
    });
    await writeDecision(seeded, "review", "rework", { comments: "first-pass" });
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    await writeDecision(seeded, "review", "rework", {
      comments: "second-pass",
    });
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const evidence = (await getComposedEvidence(seeded.runId)).sort(
      (a, b) => (a.attempt ?? 0) - (b.attempt ?? 0),
    );

    expect(evidence).toHaveLength(2);
    // Visit-1 evidence was staled by visit-2's rework downstream staling
    // (review is itself downstream of the rework target `fix`).
    expect(evidence[0].validity).toBe("stale");
    expect(evidence[1].validity).toBe("current");
    expect((evidence[1].locator as InlineLocator).text).toContain(
      "second-pass",
    );
  }, 60_000);
});
