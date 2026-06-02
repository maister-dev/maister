import type { MaisterYamlV2 } from "@/lib/config.schema";

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { resolveExecutor, upsertExecutorsFromConfig } from "@/lib/executors";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("executors_test")
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

async function newProject(): Promise<string> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: slug,
    repoPath: `/repos/${slug}`,
    maisterYamlPath: `/repos/${slug}/maister.yaml`,
  });

  return projectId;
}

function configWith(over: Partial<MaisterYamlV2> = {}): MaisterYamlV2 {
  const defaults: MaisterYamlV2 = {
    schemaVersion: 2,
    project: {
      name: "p",
      repo_path: "/repos/p",
      main_branch: "main",
      branch_prefix: "maister/",
    },
    executors: [
      { id: "claude-sonnet", agent: "claude", model: "claude-sonnet-4-6" },
      { id: "codex-default", agent: "codex", model: "gpt-5-codex" },
    ],
    default_executor: "claude-sonnet",
    capabilities: {
      mcps: [],
      skills: [],
      rules: [],
      restrictions: [],
      settings: [],
      tools: [],
    },
    flow_roles: [],
    flows: [],
  };

  return {
    ...defaults,
    ...over,
    capabilities: over.capabilities ?? defaults.capabilities,
  };
}

describe("upsertExecutorsFromConfig (integration)", () => {
  it("re-running with same config is idempotent (PKs stable)", async () => {
    const projectId = await newProject();
    const cfg = configWith();

    const first = await upsertExecutorsFromConfig({
      projectId,
      config: cfg,
      db,
    });
    const second = await upsertExecutorsFromConfig({
      projectId,
      config: cfg,
      db,
    });

    expect(first.executorIdByRef).toEqual(second.executorIdByRef);
    expect(first.defaultExecutorId).toBe(second.defaultExecutorId);

    const rows = await db
      .select()
      .from(schema.executors)
      .where(eq(schema.executors.projectId, projectId));

    expect(rows).toHaveLength(2);
  });

  it("changing model on existing executor_ref_id updates in place (no duplicate)", async () => {
    const projectId = await newProject();
    const cfg = configWith();

    await upsertExecutorsFromConfig({ projectId, config: cfg, db });

    const bumped = configWith({
      executors: [
        { id: "claude-sonnet", agent: "claude", model: "claude-sonnet-4-7" },
        { id: "codex-default", agent: "codex", model: "gpt-5-codex" },
      ],
    });

    await upsertExecutorsFromConfig({ projectId, config: bumped, db });

    const rows = await db
      .select()
      .from(schema.executors)
      .where(eq(schema.executors.projectId, projectId));

    expect(rows).toHaveLength(2);
    const claude = rows.find((r: any) => r.executorRefId === "claude-sonnet");

    expect(claude?.model).toBe("claude-sonnet-4-7");
  });

  it("persists flow.executor_override on existing flow row; clearing resets to null", async () => {
    const projectId = await newProject();
    const flowDbId = randomUUID();

    await db.insert(schema.flows).values({
      id: flowDbId,
      projectId,
      flowRefId: "bugfix",
      source: "github.com/x/y",
      version: "v1.0.0",
      installedPath: "/tmp/flows/bugfix",
      manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
      schemaVersion: 1,
    });

    const cfgWithOverride = configWith({
      flows: [
        {
          id: "bugfix",
          source: "github.com/x/y",
          version: "v1.0.0",
          executor_override: "codex-default",
        },
      ],
    });

    const { executorIdByRef } = await upsertExecutorsFromConfig({
      projectId,
      config: cfgWithOverride,
      db,
    });

    const after = await db
      .select()
      .from(schema.flows)
      .where(
        and(
          eq(schema.flows.projectId, projectId),
          eq(schema.flows.flowRefId, "bugfix"),
        ),
      );

    expect(after[0].executorOverrideId).toBe(executorIdByRef["codex-default"]);

    // Clearing executor_override on the next call resets the column to null.
    const cfgCleared = configWith({
      flows: [{ id: "bugfix", source: "github.com/x/y", version: "v1.0.0" }],
    });

    await upsertExecutorsFromConfig({ projectId, config: cfgCleared, db });

    const after2 = await db
      .select()
      .from(schema.flows)
      .where(
        and(
          eq(schema.flows.projectId, projectId),
          eq(schema.flows.flowRefId, "bugfix"),
        ),
      );

    // Removing the YAML field MUST clear the persisted column so the
    // override chain in `resolveExecutor` falls through to the project
    // default. Skipping the CLEAR branch is the M6 adversarial-review
    // defect we are guarding against — keep this assertion strict.
    expect(after2[0].executorOverrideId).toBeNull();
  });

  it("CLEAR-half + resolveExecutor falls through to projectDefault after override removal", async () => {
    const projectId = await newProject();
    const flowDbId = randomUUID();

    await db.insert(schema.flows).values({
      id: flowDbId,
      projectId,
      flowRefId: "bugfix",
      source: "github.com/x/y",
      version: "v1.0.0",
      installedPath: "/tmp/flows/bugfix",
      manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
      schemaVersion: 1,
    });

    const cfgWithOverride = configWith({
      flows: [
        {
          id: "bugfix",
          source: "github.com/x/y",
          version: "v1.0.0",
          executor_override: "codex-default",
        },
      ],
    });

    const { executorIdByRef, defaultExecutorId } =
      await upsertExecutorsFromConfig({
        projectId,
        config: cfgWithOverride,
        db,
      });

    await db
      .update(schema.projects)
      .set({ defaultExecutorId })
      .where(eq(schema.projects.id, projectId));

    // Re-run with the override removed.
    const cfgCleared = configWith({
      flows: [{ id: "bugfix", source: "github.com/x/y", version: "v1.0.0" }],
    });

    await upsertExecutorsFromConfig({ projectId, config: cfgCleared, db });

    const flowRows = await db
      .select()
      .from(schema.flows)
      .where(eq(schema.flows.id, flowDbId));
    const projectRows = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));

    expect(flowRows[0].executorOverrideId).toBeNull();

    const resolved = resolveExecutor({
      task: { executorOverrideId: null },
      flow: {
        executorOverrideId: flowRows[0].executorOverrideId,
        recommendedExecutorId: flowRows[0].recommendedExecutorId,
      },
      project: { defaultExecutorId: projectRows[0].defaultExecutorId },
    });

    expect(resolved.tier).toBe("projectDefault");
    expect(resolved.executorId).toBe(defaultExecutorId);
    expect(resolved.executorId).not.toBe(executorIdByRef["codex-default"]);
  });

  it("router=ccr round-trips through the DB", async () => {
    const projectId = await newProject();
    const cfg = configWith({
      executors: [
        {
          id: "claude-glm",
          agent: "claude",
          model: "glm-4.6",
          env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" },
          router: "ccr",
        },
      ],
      default_executor: "claude-glm",
    });

    await upsertExecutorsFromConfig({ projectId, config: cfg, db });

    const rows = await db
      .select()
      .from(schema.executors)
      .where(
        and(
          eq(schema.executors.projectId, projectId),
          eq(schema.executors.executorRefId, "claude-glm"),
        ),
      );

    expect(rows[0].router).toBe("ccr");
    expect(rows[0].env).toEqual({
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    });
  });

  it("concurrent calls for the same projectId serialize without UNIQUE violation", async () => {
    const projectId = await newProject();
    const cfg = configWith();

    const results = await Promise.all([
      upsertExecutorsFromConfig({ projectId, config: cfg, db }),
      upsertExecutorsFromConfig({ projectId, config: cfg, db }),
      upsertExecutorsFromConfig({ projectId, config: cfg, db }),
    ]);

    expect(results).toHaveLength(3);
    // All callers see the same final PKs.
    const refs = Object.keys(results[0].executorIdByRef);

    for (const ref of refs) {
      const ids = results.map((r) => r.executorIdByRef[ref]);

      expect(new Set(ids).size).toBe(1);
    }

    const rows = await db
      .select()
      .from(schema.executors)
      .where(eq(schema.executors.projectId, projectId));

    expect(rows).toHaveLength(2);
  });

  it("resolveExecutor end-to-end: flowOverride tier fires against real DB rows", async () => {
    const projectId = await newProject();
    const cfg = configWith({
      flows: [
        {
          id: "bugfix",
          source: "github.com/x/y",
          version: "v1.0.0",
          executor_override: "codex-default",
        },
      ],
    });
    const flowDbId = randomUUID();

    await db.insert(schema.flows).values({
      id: flowDbId,
      projectId,
      flowRefId: "bugfix",
      source: "github.com/x/y",
      version: "v1.0.0",
      installedPath: "/tmp/flows/bugfix",
      manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
      schemaVersion: 1,
    });

    const { executorIdByRef, defaultExecutorId } =
      await upsertExecutorsFromConfig({ projectId, config: cfg, db });

    await db
      .update(schema.projects)
      .set({ defaultExecutorId })
      .where(eq(schema.projects.id, projectId));

    const flowRows = await db
      .select()
      .from(schema.flows)
      .where(eq(schema.flows.id, flowDbId));
    const projectRows = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));

    const resolved = resolveExecutor({
      task: { executorOverrideId: null },
      flow: {
        executorOverrideId: flowRows[0].executorOverrideId,
        recommendedExecutorId: flowRows[0].recommendedExecutorId,
      },
      project: { defaultExecutorId: projectRows[0].defaultExecutorId },
    });

    expect(resolved.tier).toBe("flowOverride");
    expect(resolved.executorId).toBe(executorIdByRef["codex-default"]);
    expect(resolved.executorId).not.toBe(defaultExecutorId);
  });

  it("WARN-logs (zero-row update) when flow.executor_override targets a not-yet-installed flow", async () => {
    const projectId = await newProject();
    const cfg = configWith({
      flows: [
        {
          id: "ghostflow",
          source: "github.com/x/y",
          version: "v1.0.0",
          executor_override: "claude-sonnet",
        },
      ],
    });

    const { executorIdByRef } = await upsertExecutorsFromConfig({
      projectId,
      config: cfg,
      db,
    });

    expect(executorIdByRef["claude-sonnet"]).toBeDefined();

    const rows = await db
      .select()
      .from(schema.flows)
      .where(eq(schema.flows.projectId, projectId));

    expect(rows).toHaveLength(0);
  });
});
