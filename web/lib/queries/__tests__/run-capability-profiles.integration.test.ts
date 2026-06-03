import type { MaterializationPlan } from "@/lib/db/schema";

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

let getRunCapabilityProfiles: typeof import("@/lib/queries/run").getRunCapabilityProfiles;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("run_cap_profiles_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ getRunCapabilityProfiles } = await import("@/lib/queries/run"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

// Seed a real flows + project + executor + task row and thread the non-null
// flowId, per the project test-hygiene rule (runs.flow_version NOT NULL).
async function seedRun(): Promise<{ runId: string; projectId: string }> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: "Cap Profile Test",
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
    title: "t",
    prompt: "p",
    flowId,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    executorId,
    status: "Running",
    flowVersion: "v1.0.0",
  });

  return { runId, projectId };
}

function plan(over: Partial<MaterializationPlan> = {}): MaterializationPlan {
  return {
    profileDigest: "abcdef0123456789deadbeef",
    resolvedRevisions: [
      { refId: "aif-skill-lint", kind: "skill", sha: "0011223344556677" },
    ],
    materializedFiles: [".maister/profile/skill.md"],
    enforcedClasses: ["aif-skill-lint"],
    instructedClasses: ["aif-mcp-search"],
    refusedClasses: ["aif-tool-shell"],
    cleanup: { status: "pending" },
    ...over,
  };
}

describe("getRunCapabilityProfiles (integration)", () => {
  it("returns ai_coding/judge node attempts that carry a materialization plan", async () => {
    const { runId } = await seedRun();

    await db.insert(schema.nodeAttempts).values({
      id: randomUUID(),
      runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      attempt: 1,
      status: "Succeeded",
      materializationPlan: plan(),
      startedAt: new Date("2026-06-01T10:00:00.000Z"),
    });

    const result = await getRunCapabilityProfiles(runId);

    expect(result).not.toBeNull();
    expect(result?.nodes).toHaveLength(1);

    const node = result!.nodes[0];

    expect(node.nodeId).toBe("implement");
    expect(node.nodeType).toBe("ai_coding");
    expect(node.plan.profileDigest).toBe("abcdef0123456789deadbeef");
    expect(node.plan.enforcedClasses).toEqual(["aif-skill-lint"]);
    expect(node.plan.instructedClasses).toEqual(["aif-mcp-search"]);
    expect(node.plan.refusedClasses).toEqual(["aif-tool-shell"]);
    // resolvedRevisions are enriched with a (null-when-absent) trust verdict.
    expect(node.plan.resolvedRevisions).toEqual([
      {
        refId: "aif-skill-lint",
        kind: "skill",
        sha: "0011223344556677",
        trustStatus: null,
      },
    ]);
  });

  it("excludes non-ai node types and nodes without a materialization plan", async () => {
    const { runId } = await seedRun();

    // ai_coding WITH a plan — included.
    await db.insert(schema.nodeAttempts).values({
      id: randomUUID(),
      runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      attempt: 1,
      status: "Succeeded",
      materializationPlan: plan(),
      startedAt: new Date("2026-06-01T10:00:00.000Z"),
    });

    // judge WITH a plan — included.
    await db.insert(schema.nodeAttempts).values({
      id: randomUUID(),
      runId,
      nodeId: "verdict",
      nodeType: "judge",
      attempt: 1,
      status: "Succeeded",
      materializationPlan: plan(),
      startedAt: new Date("2026-06-01T10:01:00.000Z"),
    });

    // cli node WITH a plan — excluded by nodeType filter.
    await db.insert(schema.nodeAttempts).values({
      id: randomUUID(),
      runId,
      nodeId: "build",
      nodeType: "cli",
      attempt: 1,
      status: "Succeeded",
      materializationPlan: plan(),
      startedAt: new Date("2026-06-01T10:02:00.000Z"),
    });

    // ai_coding WITHOUT a plan — excluded by the non-null-plan filter.
    await db.insert(schema.nodeAttempts).values({
      id: randomUUID(),
      runId,
      nodeId: "planless",
      nodeType: "ai_coding",
      attempt: 1,
      status: "Succeeded",
      startedAt: new Date("2026-06-01T10:03:00.000Z"),
    });

    const result = await getRunCapabilityProfiles(runId);

    expect(result?.nodes.map((n) => n.nodeId).sort()).toEqual([
      "implement",
      "verdict",
    ]);
  });

  it("attaches trustStatus from capability_imports keyed by (project, refId, sha)", async () => {
    const { runId, projectId } = await seedRun();

    await db.insert(schema.capabilityImports).values({
      id: randomUUID(),
      projectId,
      capabilityRefId: "aif-skill-lint",
      source: "github.com/x/lint",
      versionTag: "v1.0.0",
      resolvedRevision: "0011223344556677",
      manifestDigest: "md",
      manifest: {},
      installedPath: "/tmp/cap/lint",
      trustStatus: "untrusted",
    });

    await db.insert(schema.nodeAttempts).values({
      id: randomUUID(),
      runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      attempt: 1,
      status: "Succeeded",
      materializationPlan: plan(),
      startedAt: new Date("2026-06-01T10:00:00.000Z"),
    });

    const result = await getRunCapabilityProfiles(runId);
    const rev = result!.nodes[0].plan.resolvedRevisions[0];

    expect(rev.refId).toBe("aif-skill-lint");
    expect(rev.trustStatus).toBe("untrusted");
  });

  it("returns null when the run has no ai_coding/judge node with a plan", async () => {
    const { runId } = await seedRun();

    await db.insert(schema.nodeAttempts).values({
      id: randomUUID(),
      runId,
      nodeId: "build",
      nodeType: "cli",
      attempt: 1,
      status: "Succeeded",
      startedAt: new Date("2026-06-01T10:00:00.000Z"),
    });

    const result = await getRunCapabilityProfiles(runId);

    expect(result).toBeNull();
  });
});
