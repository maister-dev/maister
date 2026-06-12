// M34 (ADR-089 D11) — the attach-panel service: attach (conflict-safe),
// one-transaction link PATCH with full schedule replacement (cron validated,
// event kinds taxonomy-checked), detach with token revocation (the ADR-089
// rotation guarantee).

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  attachAgent,
  detachAgent,
  getProjectAgentsView,
  updateAgentLink,
} from "@/lib/agents/project-links";
import { issueAgentRunToken } from "@/lib/agents/tokens";
import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const fx = { projectId: "", agentId: "platform-helper" };

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("agent_links_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  fx.projectId = randomUUID();

  await db.insert(schema.projects).values({
    id: fx.projectId,
    slug: "agent-links",
    name: "Agent Links",
    repoPath: "/tmp/agent-links",
    maisterYamlPath: "/tmp/agent-links/maister.yaml",
    taskKey: "ALK",
  });
  await db.insert(schema.agents).values({
    id: fx.agentId,
    flowRefId: "test-pkg",
    versionLabel: "v1.0.0",
    origin: "git",
    name: fx.agentId,
    description: "d",
    workspace: "none",
    mode: "session",
    triggers: ["manual", "cron", "domain_event"],
    riskTier: "read_only",
    sourcePath: `/tmp/agents/${fx.agentId}/agent.md`,
  });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("project agent links (attach panel service)", () => {
  it("attaches once, then refuses the duplicate with CONFLICT", async () => {
    const { linkId } = await attachAgent(
      { projectId: fx.projectId, agentId: fx.agentId },
      db,
    );

    expect(linkId).toBeTruthy();

    await expect(
      attachAgent({ projectId: fx.projectId, agentId: fx.agentId }, db),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("PATCH replaces the trigger bindings wholesale and validates cron + event kinds", async () => {
    await updateAgentLink(
      {
        projectId: fx.projectId,
        agentId: fx.agentId,
        patch: {
          schedules: [
            { triggerType: "cron", cronExpr: "*/15 * * * *", timezone: "UTC" },
            { triggerType: "event", eventKinds: ["task.created"] },
          ],
        },
      },
      db,
    );

    let view = await getProjectAgentsView(fx.projectId, db);

    expect(view.attached[0].schedules).toHaveLength(2);

    // Full replacement — the second PATCH leaves exactly one binding.
    await updateAgentLink(
      {
        projectId: fx.projectId,
        agentId: fx.agentId,
        patch: {
          schedules: [
            { triggerType: "event", eventKinds: ["task.comment_added"] },
          ],
        },
      },
      db,
    );

    view = await getProjectAgentsView(fx.projectId, db);
    expect(view.attached[0].schedules).toEqual([
      {
        triggerType: "event",
        eventKinds: ["task.comment_added"],
        enabled: true,
      },
    ]);

    await expect(
      updateAgentLink(
        {
          projectId: fx.projectId,
          agentId: fx.agentId,
          patch: {
            schedules: [
              { triggerType: "cron", cronExpr: "not a cron", timezone: "UTC" },
            ],
          },
        },
        db,
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    await expect(
      updateAgentLink(
        {
          projectId: fx.projectId,
          agentId: fx.agentId,
          patch: {
            schedules: [{ triggerType: "event", eventKinds: ["not.a.kind"] }],
          },
        },
        db,
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });

  it("detach removes link + bindings and revokes every live (agent, project) token", async () => {
    await issueAgentRunToken({
      agentId: fx.agentId,
      projectId: fx.projectId,
      runId: randomUUID(),
      db,
    });

    await detachAgent({ projectId: fx.projectId, agentId: fx.agentId }, db);

    const links = await pool.query(
      `SELECT count(*)::int AS n FROM agent_project_links WHERE agent_id = $1`,
      [fx.agentId],
    );
    const schedules = await pool.query(
      `SELECT count(*)::int AS n FROM agent_schedules WHERE agent_id = $1`,
      [fx.agentId],
    );
    const liveTokens = await pool.query(
      `SELECT count(*)::int AS n FROM project_tokens
       WHERE agent_id = $1 AND revoked_at IS NULL`,
      [fx.agentId],
    );

    expect(links.rows[0].n).toBe(0);
    expect(schedules.rows[0].n).toBe(0);
    expect(liveTokens.rows[0].n).toBe(0);

    // Idempotency contract: a second detach is a 404-shaped PRECONDITION.
    await expect(
      detachAgent({ projectId: fx.projectId, agentId: fx.agentId }, db),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    // The agent is attachable again afterwards.
    const again = await attachAgent(
      { projectId: fx.projectId, agentId: fx.agentId },
      db,
    );

    expect(again.linkId).toBeTruthy();
  });
});
