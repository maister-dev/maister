import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let agentsRoot: string;

// MAISTER_AGENTS_ROOT must be set BEFORE the registry module is imported so
// the path helpers resolve into the temp catalog; import dynamically.
let registry: typeof import("@/lib/agents/registry");

beforeAll(async () => {
  agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-agents-"));
  process.env.MAISTER_AGENTS_ROOT = agentsRoot;

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  registry = await import("@/lib/agents/registry");
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  await rm(agentsRoot, { recursive: true, force: true });
  delete process.env.MAISTER_AGENTS_ROOT;
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "projects"`);
  await rm(agentsRoot, { recursive: true, force: true });
  await mkdir(agentsRoot, { recursive: true });
});

async function seedProject(slug: string): Promise<string> {
  const projectId = randomUUID();

  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/maister.yaml', $4)`,
    [
      projectId,
      slug,
      `/repos/${slug}-${projectId}`,
      `K${projectId
        .replace(/[^0-9A-Za-z]/g, "")
        .slice(0, 7)
        .toUpperCase()}`,
    ],
  );

  return projectId;
}

function definitionMd(opts?: {
  runner?: string | null;
  scope?: "platform" | "project";
  project?: string;
}): string {
  const runnerLine = opts?.runner ? `runner: ${opts.runner}\n` : "";
  const projectLine = opts?.project ? `project: ${opts.project}\n` : "";

  return `---
name: Triager
description: Classifies tasks
scope: ${opts?.scope ?? "platform"}
${projectLine}${runnerLine}workspace: none
mode: session
triggers:
  - manual
risk_tier: read_only
---
Triage the task.
`;
}

async function writeAgentMd(id: string, content: string): Promise<void> {
  await mkdir(path.join(agentsRoot, id), { recursive: true });
  await writeFile(path.join(agentsRoot, id, "agent.md"), content, "utf8");
}

async function agentRow(
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, id));

  return rows[0] as Record<string, unknown> | undefined;
}

describe("agents registry", () => {
  it("registers a platform agent and SET/CLEAR-syncs the runner column", async () => {
    await writeAgentMd("triager", definitionMd({ runner: undefined }));
    await pool.query(
      `INSERT INTO "platform_acp_runners" ("id", "adapter", "capability_agent", "model", "provider")
       VALUES ('claude-default', 'claude', 'claude', 'claude-sonnet-4-6', '{"kind":"anthropic"}'::jsonb)
       ON CONFLICT DO NOTHING`,
    );

    // SET
    await writeAgentMd("triager", definitionMd({ runner: "claude-default" }));
    await registry.registerAgentFromFile("triager", db);
    expect((await agentRow("triager"))?.runnerId).toBe("claude-default");

    // CLEAR — field removed from the .md resets the column
    await writeAgentMd("triager", definitionMd({}));
    await registry.registerAgentFromFile("triager", db);
    expect((await agentRow("triager"))?.runnerId).toBeNull();

    // idempotent re-SET
    await writeAgentMd("triager", definitionMd({ runner: "claude-default" }));
    await registry.registerAgentFromFile("triager", db);
    expect((await agentRow("triager"))?.runnerId).toBe("claude-default");
  });

  it("refuses an invalid definition with CONFIG and writes no row", async () => {
    await writeAgentMd("broken", "---\nname: X\n---\nbody\n");

    await expect(
      registry.registerAgentFromFile("broken", db),
    ).rejects.toSatisfy(
      (err: unknown) => isMaisterError(err) && err.code === "CONFIG",
    );
    expect(await agentRow("broken")).toBeUndefined();
  });

  it("refuses an unknown project slug with CONFIG", async () => {
    await writeAgentMd(
      "proj-agent",
      definitionMd({ scope: "project", project: "ghost" }),
    );

    await expect(
      registry.registerAgentFromFile("proj-agent", db),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) &&
        err.code === "CONFIG" &&
        /ghost/.test(err.message),
    );
  });

  it("auto-links project-scope agents to their bound project", async () => {
    const projectId = await seedProject("myapp");

    await writeAgentMd(
      "proj-agent",
      definitionMd({ scope: "project", project: "myapp" }),
    );
    await registry.registerAgentFromFile("proj-agent", db);

    const links = await db
      .select()
      .from(schema.agentProjectLinks)
      .where(eq(schema.agentProjectLinks.agentId, "proj-agent"));

    expect(links).toHaveLength(1);
    expect((links[0] as { projectId: string }).projectId).toBe(projectId);

    // idempotent re-register keeps one link
    await registry.registerAgentFromFile("proj-agent", db);
    const linksAgain = await db
      .select()
      .from(schema.agentProjectLinks)
      .where(eq(schema.agentProjectLinks.agentId, "proj-agent"));

    expect(linksAgain).toHaveLength(1);
  });

  it("createAgent writes the .md, registers, and refuses id collisions", async () => {
    const parsed = await registry.createAgent(
      {
        id: "creator",
        name: "Creator",
        description: "d",
        scope: "platform",
        workspace: "none",
        mode: "session",
        triggers: ["manual"],
        riskTier: "read_only",
        prompt: "p",
      },
      db,
    );

    expect(parsed.id).toBe("creator");
    expect(await agentRow("creator")).toBeDefined();

    await expect(
      registry.createAgent(
        {
          id: "creator",
          name: "Creator 2",
          description: "d",
          scope: "platform",
          workspace: "none",
          mode: "session",
          triggers: ["manual"],
          riskTier: "read_only",
          prompt: "p",
        },
        db,
      ),
    ).rejects.toSatisfy(
      (err: unknown) => isMaisterError(err) && err.code === "CONFLICT",
    );
  });

  it("resync registers parseable dirs, reports invalid ones, disables missing rows", async () => {
    await writeAgentMd("good", definitionMd({}));
    await writeAgentMd("bad", "---\nname: only-name\n---\nbody\n");
    // a row whose dir is gone
    await db.insert(schema.agents).values({
      id: "vanished",
      scope: "platform",
      name: "V",
      description: "d",
      workspace: "none",
      mode: "session",
      triggers: ["manual"],
      riskTier: "read_only",
      sourcePath: "/gone/agent.md",
    });

    const summary = await registry.resyncAgents(db);

    expect(summary.synced).toBe(1);
    expect(summary.invalid).toHaveLength(1);
    expect(summary.invalid[0].id).toBe("bad");
    expect(summary.missing).toContain("vanished");
    expect((await agentRow("vanished"))?.enabled).toBe(false);
    expect(await agentRow("good")).toBeDefined();
  });

  it("deleteAgent is usage-guarded by live runs and cleans up otherwise", async () => {
    const projectId = await seedProject("delproj");

    await writeAgentMd("victim", definitionMd({}));
    await registry.registerAgentFromFile("victim", db);

    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "agent_id", "trigger_source", "project_id", "flow_version", "flow_revision", "status")
       VALUES ($1, 'agent', 'victim', 'manual', $2, 'agent', 'manual', 'Running')`,
      [randomUUID(), projectId],
    );

    await expect(registry.deleteAgent("victim", db)).rejects.toSatisfy(
      (err: unknown) => isMaisterError(err) && err.code === "CONFLICT",
    );

    await pool.query(
      `UPDATE "runs" SET "status" = 'Done', "ended_at" = now() WHERE "agent_id" = 'victim'`,
    );
    await registry.deleteAgent("victim", db);
    expect(await agentRow("victim")).toBeUndefined();
  });
});
