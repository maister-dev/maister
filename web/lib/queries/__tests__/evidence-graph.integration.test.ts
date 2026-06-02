// T7.1 (RED): failing integration tests for the server evidence-graph model.
//
// Contract (module not built yet — RED on the missing import):
//   web/lib/queries/evidence-graph.ts exports
//     buildEvidenceGraph(runId, db?): Promise<EvidenceGraph>
//   nodes: task-input | node-attempt | artifact | gate | decision
//   edges: input | output | supersession | stale | flow | gate
//
// The graph is the read model the React Flow explorer renders. It must surface
// validity/state on every node and never emit a dangling edge.

import type { EvidenceGraph } from "@/lib/queries/evidence-graph";

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches run-timeline.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let buildEvidenceGraph: typeof import("@/lib/queries/evidence-graph").buildEvidenceGraph;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("evidence_graph_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ buildEvidenceGraph } = await import("@/lib/queries/evidence-graph"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function seedRun(): Promise<{ runId: string }> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: "Evidence Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });
  await db.insert(schema.executors).values({
    id: executorId,
    projectId,
    executorRefId: "claude-sonnet",
    agent: "claude",
    model: "claude-sonnet-4-6",
  });
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
    id: taskId,
    projectId,
    title: "Build the thing",
    prompt: "implement feature X",
    flowId,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    executorId,
    status: "Review",
    flowVersion: "v1.0.0",
  });

  return { runId };
}

// A realistic run: implement (ai_coding, succeeded) → checks (check,
// succeeded, one passed gate) → review (human, decision=approve). The
// implement node produced two diff artifacts of the same def — attempt-1's
// (now superseded) and attempt-2's (current) — plus a stale artifact, so the
// supersession + stale behaviors are exercised.
type Seeded = {
  runId: string;
  implementId: string;
  checksId: string;
  reviewId: string;
  oldDiffId: string;
  newDiffId: string;
  staleArtifactId: string;
};

async function seedRichRun(): Promise<Seeded> {
  const { runId } = await seedRun();

  const implementId = randomUUID();
  const checksId = randomUUID();
  const reviewId = randomUUID();

  await db.insert(schema.nodeAttempts).values({
    id: implementId,
    runId,
    nodeId: "implement",
    nodeType: "ai_coding",
    attempt: 1,
    status: "Succeeded",
    startedAt: new Date("2026-05-31T10:00:00.000Z"),
    endedAt: new Date("2026-05-31T10:05:00.000Z"),
  });
  await db.insert(schema.nodeAttempts).values({
    id: checksId,
    runId,
    nodeId: "checks",
    nodeType: "check",
    attempt: 1,
    status: "Succeeded",
    reworkFromNode: "implement",
    startedAt: new Date("2026-05-31T10:06:00.000Z"),
    endedAt: new Date("2026-05-31T10:07:00.000Z"),
  });
  await db.insert(schema.nodeAttempts).values({
    id: reviewId,
    runId,
    nodeId: "review",
    nodeType: "human",
    attempt: 1,
    status: "Succeeded",
    decision: "approve",
    reworkFromNode: "checks",
    startedAt: new Date("2026-05-31T10:08:00.000Z"),
    endedAt: new Date("2026-05-31T10:12:00.000Z"),
  });

  // One passed gate on the checks attempt.
  await db.insert(schema.gateResults).values({
    id: randomUUID(),
    runId,
    nodeAttemptId: checksId,
    gateId: "lint",
    kind: "command_check",
    mode: "blocking",
    status: "passed",
    verdict: { verdict: "pass" },
    createdAt: new Date("2026-05-31T10:06:30.000Z"),
  });

  // Implement produced impl-diff twice: the old (superseded) and the new
  // (current). old.supersededById -> new.id.
  const oldDiffId = randomUUID();
  const newDiffId = randomUUID();

  await db.insert(schema.artifactInstances).values({
    id: newDiffId,
    runId,
    nodeAttemptId: implementId,
    nodeId: "implement",
    attempt: 1,
    artifactDefId: "impl-diff",
    kind: "diff",
    producer: "runner",
    locator: { kind: "git-range", baseCommit: "base", headRef: "head" },
    validity: "current",
  });
  await db.insert(schema.artifactInstances).values({
    id: oldDiffId,
    runId,
    nodeAttemptId: implementId,
    nodeId: "implement",
    attempt: 1,
    artifactDefId: "impl-diff",
    kind: "diff",
    producer: "runner",
    locator: { kind: "git-range", baseCommit: "base", headRef: "head0" },
    validity: "superseded",
    supersededById: newDiffId,
  });

  // A stale artifact on the checks node (e.g. a lint report invalidated by rework).
  const staleArtifactId = randomUUID();

  await db.insert(schema.artifactInstances).values({
    id: staleArtifactId,
    runId,
    nodeAttemptId: checksId,
    nodeId: "checks",
    attempt: 1,
    artifactDefId: "lint-report",
    kind: "lint_report",
    producer: "runner",
    locator: { kind: "inline", text: "stale lint" },
    validity: "stale",
  });

  // The human review decision.
  await db.insert(schema.hitlRequests).values({
    id: randomUUID(),
    runId,
    stepId: "review",
    kind: "human",
    prompt: "Approve?",
    response: { decision: "approve" },
    decision: "approve",
    respondedAt: new Date("2026-05-31T10:12:00.000Z"),
  });

  return {
    runId,
    implementId,
    checksId,
    reviewId,
    oldDiffId,
    newDiffId,
    staleArtifactId,
  };
}

function nodesOfKind(graph: EvidenceGraph, kind: string) {
  return graph.nodes.filter((n) => n.kind === kind);
}

function edgesOfKind(graph: EvidenceGraph, kind: string) {
  return graph.edges.filter((e) => e.kind === kind);
}

describe("buildEvidenceGraph (integration)", () => {
  it("emits exactly one task-input node", async () => {
    const { runId } = await seedRichRun();

    const graph = await buildEvidenceGraph(runId);

    expect(nodesOfKind(graph, "task-input")).toHaveLength(1);
  });

  it("emits one node-attempt node per node_attempts row with status/meta", async () => {
    const seeded = await seedRichRun();

    const graph = await buildEvidenceGraph(seeded.runId);
    const attempts = nodesOfKind(graph, "node-attempt");

    expect(attempts).toHaveLength(3);

    const implement = attempts.find((n) => n.meta.nodeId === "implement");

    expect(implement).toBeDefined();
    expect(implement?.state).toBe("Succeeded");
    expect(implement?.meta.attempt).toBe(1);
    expect(implement?.meta.nodeType).toBe("ai_coding");
  });

  it("emits one artifact node per artifact_instances row with validity as state", async () => {
    const seeded = await seedRichRun();

    const graph = await buildEvidenceGraph(seeded.runId);
    const artifacts = nodesOfKind(graph, "artifact");

    expect(artifacts).toHaveLength(3);

    const byArtifactId = new Map(artifacts.map((n) => [n.meta.artifactId, n]));

    expect(byArtifactId.get(seeded.newDiffId)?.state).toBe("current");
    expect(byArtifactId.get(seeded.oldDiffId)?.state).toBe("superseded");
    expect(byArtifactId.get(seeded.staleArtifactId)?.state).toBe("stale");

    // meta carries the artifact kind.
    expect(byArtifactId.get(seeded.newDiffId)?.meta.kind).toBe("diff");
  });

  it("emits one gate node per gate_results row with status/meta", async () => {
    const seeded = await seedRichRun();

    const graph = await buildEvidenceGraph(seeded.runId);
    const gates = nodesOfKind(graph, "gate");

    expect(gates).toHaveLength(1);
    expect(gates[0].state).toBe("passed");
    expect(gates[0].meta.gateKind).toBe("command_check");
    expect(gates[0].meta.mode).toBe("blocking");
  });

  it("emits one decision node per hitl_requests row that has a decision", async () => {
    const seeded = await seedRichRun();

    const graph = await buildEvidenceGraph(seeded.runId);
    const decisions = nodesOfKind(graph, "decision");

    expect(decisions).toHaveLength(1);
    expect(JSON.stringify(decisions[0])).toContain("approve");
  });

  it("emits an input edge from task-input to the earliest node-attempt", async () => {
    const seeded = await seedRichRun();

    const graph = await buildEvidenceGraph(seeded.runId);
    const taskInput = nodesOfKind(graph, "task-input")[0];
    const inputEdges = edgesOfKind(graph, "input");

    expect(inputEdges.length).toBeGreaterThanOrEqual(1);
    expect(inputEdges.every((e) => e.source === taskInput.id)).toBe(true);

    // Targets are node-attempt nodes.
    const attemptIds = new Set(
      nodesOfKind(graph, "node-attempt").map((n) => n.id),
    );

    expect(inputEdges.every((e) => attemptIds.has(e.target))).toBe(true);
  });

  it("emits an output edge from a node-attempt to each artifact it produced", async () => {
    const seeded = await seedRichRun();

    const graph = await buildEvidenceGraph(seeded.runId);
    const outputEdges = edgesOfKind(graph, "output");

    expect(outputEdges.length).toBeGreaterThanOrEqual(1);

    const implementNode = nodesOfKind(graph, "node-attempt").find(
      (n) => n.meta.nodeId === "implement",
    );
    const newDiffNode = nodesOfKind(graph, "artifact").find(
      (n) => n.meta.artifactId === seeded.newDiffId,
    );

    expect(
      outputEdges.some(
        (e) => e.source === implementNode?.id && e.target === newDiffNode?.id,
      ),
    ).toBe(true);
  });

  it("emits a gate edge from a node-attempt to its gates", async () => {
    const seeded = await seedRichRun();

    const graph = await buildEvidenceGraph(seeded.runId);
    const gateEdges = edgesOfKind(graph, "gate");
    const checksNode = nodesOfKind(graph, "node-attempt").find(
      (n) => n.meta.nodeId === "checks",
    );
    const gateNode = nodesOfKind(graph, "gate")[0];

    expect(
      gateEdges.some(
        (e) => e.source === checksNode?.id && e.target === gateNode.id,
      ),
    ).toBe(true);
  });

  it("emits a distinguishable supersession edge from the superseded artifact to the newer one", async () => {
    const seeded = await seedRichRun();

    const graph = await buildEvidenceGraph(seeded.runId);
    const supersession = edgesOfKind(graph, "supersession");

    expect(supersession.length).toBeGreaterThanOrEqual(1);

    const oldNode = nodesOfKind(graph, "artifact").find(
      (n) => n.meta.artifactId === seeded.oldDiffId,
    );
    const newNode = nodesOfKind(graph, "artifact").find(
      (n) => n.meta.artifactId === seeded.newDiffId,
    );

    expect(
      supersession.some(
        (e) => e.source === oldNode?.id && e.target === newNode?.id,
      ),
    ).toBe(true);
  });

  it("emits at least one flow edge between sequential node-attempts", async () => {
    const seeded = await seedRichRun();

    const graph = await buildEvidenceGraph(seeded.runId);
    const flowEdges = edgesOfKind(graph, "flow");

    expect(flowEdges.length).toBeGreaterThanOrEqual(1);

    // Flow edges connect node-attempt nodes.
    const attemptIds = new Set(
      nodesOfKind(graph, "node-attempt").map((n) => n.id),
    );

    expect(
      flowEdges.every(
        (e) => attemptIds.has(e.source) && attemptIds.has(e.target),
      ),
    ).toBe(true);
  });

  it("surfaces stale state on the stale artifact node", async () => {
    const seeded = await seedRichRun();

    const graph = await buildEvidenceGraph(seeded.runId);
    const staleNode = nodesOfKind(graph, "artifact").find(
      (n) => n.meta.artifactId === seeded.staleArtifactId,
    );

    expect(staleNode).toBeDefined();
    expect(staleNode?.state).toBe("stale");
  });

  it("never emits a dangling edge (every endpoint references an existing node)", async () => {
    const seeded = await seedRichRun();

    const graph = await buildEvidenceGraph(seeded.runId);
    const nodeIds = new Set(graph.nodes.map((n) => n.id));

    for (const edge of graph.edges) {
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
    }
  });

  it("handles an empty-ish run: task-input + one node-attempt + the input edge, no dangling edges", async () => {
    const { runId } = await seedRun();

    const onlyAttemptId = randomUUID();

    await db.insert(schema.nodeAttempts).values({
      id: onlyAttemptId,
      runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      attempt: 1,
      status: "Running",
      startedAt: new Date("2026-05-31T12:00:00.000Z"),
    });

    const graph = await buildEvidenceGraph(runId);

    expect(nodesOfKind(graph, "task-input")).toHaveLength(1);
    expect(nodesOfKind(graph, "node-attempt")).toHaveLength(1);
    expect(nodesOfKind(graph, "artifact")).toHaveLength(0);
    expect(nodesOfKind(graph, "gate")).toHaveLength(0);
    expect(edgesOfKind(graph, "input").length).toBeGreaterThanOrEqual(1);

    const nodeIds = new Set(graph.nodes.map((n) => n.id));

    for (const edge of graph.edges) {
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
    }
  });
});
