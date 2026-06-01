import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// FIXME(any): drizzle-orm@0.36 ships duplicate peer-dep variants in pnpm
// (one with better-sqlite3, one without). Typed table imports from
// `@/lib/db/schema` clash with the test-file's own drizzle copy. Runtime
// works; we cast to `any` to silence the type-only conflict.
import * as fullSchema from "@/lib/db/schema";
import { setEnforcementSnapshot } from "@/lib/flows/graph/ledger";

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

function newId(): string {
  return randomUUID();
}

async function seedChain() {
  const projectId = newId();
  const executorId = newId();
  const flowId = newId();
  const taskId = newId();
  const runId = newId();
  const workspaceId = newId();
  const hitlId = newId();

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
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
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
    schemaVersion: 1,
  });

  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    title: "Test task",
    prompt: "do the thing",
    flowId,
  });

  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    executorId,
    flowVersion: "v1.0.0",
  });

  await db.insert(schema.workspaces).values({
    id: workspaceId,
    runId,
    projectId,
    branch: "feature/test",
    worktreePath: `/tmp/wt-${workspaceId.slice(0, 8)}`,
    parentRepoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
  });

  await db.insert(schema.hitlRequests).values({
    id: hitlId,
    runId,
    stepId: "step-1",
    kind: "form",
    schema: { schemaVersion: 1, fields: [] },
    prompt: "Confirm?",
  });

  return { projectId, executorId, flowId, taskId, runId, workspaceId, hitlId };
}

async function seedScratchParents() {
  const projectId = newId();
  const executorId = newId();
  const userId = newId();

  await db.insert(schema.users).values({
    id: userId,
    email: `scratch-${userId.slice(0, 8)}@example.test`,
    role: "member",
    accountStatus: "active",
  });

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `scratch-${projectId.slice(0, 8)}`,
    name: "Scratch Test",
    repoPath: `/tmp/scratch-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });

  await db.insert(schema.executors).values({
    id: executorId,
    projectId,
    executorRefId: "codex-default",
    agent: "codex",
    model: "gpt-5-codex",
  });

  return { projectId, executorId, userId };
}

async function countWhere(
  table: string,
  idCol: string,
  id: string,
): Promise<number> {
  const result = await db.execute(
    sql.raw(`select count(*)::int as c from ${table} where ${idCol} = '${id}'`),
  );

  return Number((result.rows[0] as { c: number }).c);
}

describe("schema round-trip", () => {
  it("inserts one row per table with FK chain intact", async () => {
    const ids = await seedChain();

    expect(await countWhere("projects", "id", ids.projectId)).toBe(1);
    expect(await countWhere("executors", "id", ids.executorId)).toBe(1);
    expect(await countWhere("flows", "id", ids.flowId)).toBe(1);
    expect(await countWhere("tasks", "id", ids.taskId)).toBe(1);
    expect(await countWhere("runs", "id", ids.runId)).toBe(1);
    expect(await countWhere("workspaces", "id", ids.workspaceId)).toBe(1);
    expect(await countWhere("hitl_requests", "id", ids.hitlId)).toBe(1);
  });

  it("inserts scratch run rows with nullable task and flow links", async () => {
    const { projectId, executorId, userId } = await seedScratchParents();
    const runId = newId();
    const workspaceId = newId();
    const messageId = newId();
    const attachmentId = newId();
    const profileId = newId();

    await db.insert(schema.runs).values({
      id: runId,
      runKind: "scratch",
      projectId,
      executorId,
      status: "Running",
      flowVersion: "scratch",
      flowRevision: "manual",
    });

    await db.insert(schema.workspaces).values({
      id: workspaceId,
      runId,
      projectId,
      branch: "scratch/test",
      worktreePath: `/tmp/scratch-wt-${workspaceId.slice(0, 8)}`,
      parentRepoPath: `/tmp/scratch-${projectId.slice(0, 8)}`,
    });

    await db.insert(schema.scratchRuns).values({
      runId,
      projectId,
      name: "Scratch test",
      initialPrompt: "Explore the parser",
      planMode: "plan-first",
      baseBranch: "main",
      baseCommit: "abc123",
      targetBranch: "main",
      dialogStatus: "WaitingForUser",
      supervisorSessionId: newId(),
      createdByUserId: userId,
    });

    await db.insert(schema.scratchMessages).values({
      id: messageId,
      runId,
      sequence: 1,
      role: "user",
      content: "Explore the parser",
    });

    await db.insert(schema.scratchAttachments).values({
      id: attachmentId,
      runId,
      messageId,
      kind: "text_note",
      value: "Focus on edge cases.",
    });

    await db.insert(schema.scratchCapabilityProfiles).values({
      id: profileId,
      runId,
      profileDigest: "sha256:test",
      materializedPath: `/tmp/scratch-wt-${workspaceId.slice(0, 8)}/.maister/capabilities/profile.json`,
      selectedMcpIds: ["filesystem"],
      selectedSkillIds: ["aif-implement"],
      selectedRuleIds: ["project-base"],
      restrictions: { mode: "instructed" },
      adapterLaunch: { env: { MAISTER_CAPABILITY_PROFILE: "profile.json" } },
    });

    expect(await countWhere("runs", "id", runId)).toBe(1);
    expect(await countWhere("scratch_runs", "run_id", runId)).toBe(1);
    expect(await countWhere("scratch_messages", "id", messageId)).toBe(1);
    expect(await countWhere("scratch_attachments", "id", attachmentId)).toBe(1);
    expect(
      await countWhere("scratch_capability_profiles", "id", profileId),
    ).toBe(1);

    await db.delete(schema.runs).where(sql`${schema.runs.id} = ${runId}`);

    expect(await countWhere("scratch_runs", "run_id", runId)).toBe(0);
    expect(await countWhere("scratch_messages", "id", messageId)).toBe(0);
    expect(await countWhere("scratch_attachments", "id", attachmentId)).toBe(0);
    expect(
      await countWhere("scratch_capability_profiles", "id", profileId),
    ).toBe(0);
  });
});

describe("UNIQUE constraints", () => {
  it("rejects duplicate projects.slug", async () => {
    const id1 = newId();
    const id2 = newId();
    const slug = `dup-${id1.slice(0, 8)}`;

    await db.insert(schema.projects).values({
      id: id1,
      slug,
      name: "p1",
      repoPath: `/tmp/p1-${id1.slice(0, 8)}`,
      maisterYamlPath: "/tmp/m.yaml",
    });

    await expect(
      db.insert(schema.projects).values({
        id: id2,
        slug,
        name: "p2",
        repoPath: `/tmp/p2-${id2.slice(0, 8)}`,
        maisterYamlPath: "/tmp/m.yaml",
      }),
    ).rejects.toThrow();
  });

  it("rejects duplicate (executors.project_id, executor_ref_id)", async () => {
    const ids = await seedChain();

    await expect(
      db.insert(schema.executors).values({
        id: newId(),
        projectId: ids.projectId,
        executorRefId: "claude-sonnet",
        agent: "claude",
        model: "claude-sonnet-4-6",
      }),
    ).rejects.toThrow();
  });

  it("rejects duplicate (tasks.id, attempt_number)", async () => {
    const ids = await seedChain();

    await expect(
      db.insert(schema.tasks).values({
        id: ids.taskId,
        projectId: ids.projectId,
        title: "x",
        prompt: "x",
        flowId: ids.flowId,
        attemptNumber: 1,
      }),
    ).rejects.toThrow();
  });
});

describe("node_attempts.enforcement_snapshot (M11c, migration 0013)", () => {
  it("round-trips the typed verdict array and defaults to null", async () => {
    const ids = await seedChain();
    const withSnapshot = newId();
    const withoutSnapshot = newId();
    const snapshot = [
      {
        class: "mcps",
        declared: "strict",
        capability: "instructed",
        verdict: "refused",
      },
      {
        class: "permissionMode",
        declared: "instruct",
        capability: "instructed",
        verdict: "instructed",
      },
    ];

    await db.insert(schema.nodeAttempts).values({
      id: withSnapshot,
      runId: ids.runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      attempt: 1,
      status: "Failed",
      errorCode: "CONFIG",
      enforcementSnapshot: snapshot,
    });

    await db.insert(schema.nodeAttempts).values({
      id: withoutSnapshot,
      runId: ids.runId,
      nodeId: "checks",
      nodeType: "check",
      attempt: 1,
      status: "Succeeded",
    });

    const rows = await db.execute(
      sql.raw(
        `select id, enforcement_snapshot from node_attempts where run_id = '${ids.runId}' order by node_id`,
      ),
    );
    const byId = new Map(
      rows.rows.map((r) => [
        (r as { id: string }).id,
        (r as { enforcement_snapshot: unknown }).enforcement_snapshot,
      ]),
    );

    expect(byId.get(withSnapshot)).toEqual(snapshot);
    expect(byId.get(withoutSnapshot)).toBeNull();
  });

  it("setEnforcementSnapshot is write-once — a resume re-eval never overwrites the original verdicts", async () => {
    const ids = await seedChain();
    const attemptId = newId();
    const original = [
      {
        class: "mcps",
        declared: "strict",
        capability: "instructed",
        verdict: "refused",
      },
    ];
    const rewrite = [
      {
        class: "tools",
        declared: "instruct",
        capability: "instructed",
        verdict: "instructed",
      },
    ];

    await db.insert(schema.nodeAttempts).values({
      id: attemptId,
      runId: ids.runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      attempt: 1,
      status: "Running",
    });

    // First write lands.
    await setEnforcementSnapshot(attemptId, original as never, db as never);
    // A NeedsInput resume reuses the attempt and re-runs the gate — the second
    // write MUST be a no-op so the original first-attempt audit is preserved.
    await setEnforcementSnapshot(attemptId, rewrite as never, db as never);

    const rows = await db.execute(
      sql.raw(
        `select enforcement_snapshot from node_attempts where id = '${attemptId}'`,
      ),
    );

    expect(
      (rows.rows[0] as { enforcement_snapshot: unknown }).enforcement_snapshot,
    ).toEqual(original);
  });
});

describe("onDelete cascade", () => {
  it("removes runs + workspaces + tasks + hitl_requests when parent project is deleted", async () => {
    const ids = await seedChain();

    await db.execute(
      sql.raw(`delete from projects where id = '${ids.projectId}'`),
    );

    expect(await countWhere("tasks", "id", ids.taskId)).toBe(0);
    expect(await countWhere("runs", "id", ids.runId)).toBe(0);
    expect(await countWhere("workspaces", "id", ids.workspaceId)).toBe(0);
    expect(await countWhere("hitl_requests", "id", ids.hitlId)).toBe(0);
    expect(await countWhere("executors", "id", ids.executorId)).toBe(0);
    expect(await countWhere("flows", "id", ids.flowId)).toBe(0);
  });
});

describe("connectivity sanity", () => {
  it("select 1 works", async () => {
    const result = await db.execute(sql`select 1 as n`);

    expect(result.rows[0]).toEqual({ n: 1 });
  });
});
