import type { DomainEventRow } from "@/lib/db/schema";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;
let agentsRoot: string;

let triggers: typeof import("@/lib/agents/triggers");
let launchModule: typeof import("@/lib/agents/launch");

const exec = promisify(execFile);

beforeAll(async () => {
  // Definitions live wherever `agents.source_path` points (ADR-089 rework:
  // an installed package dir in prod; a plain tmp dir here).
  agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-trig-"));

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  triggers = await import("@/lib/agents/triggers");
  launchModule = await import("@/lib/agents/launch");
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "agent_schedules"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "projects"`);
  await pool.query(`DELETE FROM "flow_revisions"`);

  projectId = randomUUID();
  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/maister.yaml', $4)`,
    [
      projectId,
      `p-${projectId.slice(0, 8)}`,
      `/repos/${projectId}`,
      `K${projectId
        .replace(/[^0-9A-Za-z]/g, "")
        .slice(0, 7)
        .toUpperCase()}`,
    ],
  );

  // RD4: the REAL launch path resolves the effective definition through the
  // project's pinned package — provision the test-pkg chain (revision row
  // pointing at agentsRoot + an Enabled/trusted flows pin).
  const revisionId = randomUUID();

  await pool.query(
    `INSERT INTO "flow_revisions"
       ("id", "flow_ref_id", "source", "version_label", "resolved_revision",
        "manifest_digest", "manifest", "schema_version", "installed_path", "package_status")
     VALUES ($1, 'test-pkg', 'github.com/acme/test-pkg', 'v1.0.0', 'rev-1',
             'digest', '{}'::jsonb, 1, $2, 'Installed')`,
    [revisionId, agentsRoot],
  );
  await pool.query(
    `INSERT INTO "flows"
       ("id", "project_id", "flow_ref_id", "source", "version", "installed_path",
        "manifest", "schema_version", "enabled_revision_id", "enablement_state",
        "trust_status", "version_binding")
     VALUES ($1, $2, 'test-pkg', 'github.com/acme/test-pkg', 'v1.0.0', $3,
             '{}'::jsonb, 1, $4, 'Enabled', 'trusted', 'pinned')`,
    [randomUUID(), projectId, agentsRoot, revisionId],
  );

  // The consumer tests exercise the REAL launch path (the partial-unique
  // claim), so the runner chain must resolve: seed a ready default runner.
  await pool.query(
    `INSERT INTO "platform_acp_runners" ("id", "adapter", "capability_agent", "model", "provider", "readiness_status")
     VALUES ('trig-runner', 'claude', 'claude', 'claude-sonnet-4-6', '{"kind":"anthropic"}'::jsonb, 'Ready')
     ON CONFLICT (id) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO "platform_runtime_settings" ("id", "default_runner_id")
     VALUES ('singleton', 'trig-runner')
     ON CONFLICT (id) DO UPDATE SET "default_runner_id" = 'trig-runner'`,
  );
});

// Seeds the definition file inside the fixture package dir + the catalog
// index row + the project link; returns the package-qualified id.
async function seedAgent(args: {
  id: string;
  triggers: string[];
  workspace?: string;
  riskTier?: string;
}): Promise<string> {
  const qualifiedId = `test-pkg:${args.id}`;
  const workspace = args.workspace ?? "none";
  const riskTier = args.riskTier ?? "read_only";

  await mkdir(path.join(agentsRoot, "maister-agents"), { recursive: true });
  await writeFile(
    path.join(agentsRoot, "maister-agents", `${args.id}.md`),
    `---
name: ${args.id}
description: d
workspace: ${workspace}
mode: session
triggers:
${args.triggers.map((t) => `  - ${t}`).join("\n")}
risk_tier: ${riskTier}
---
Do the thing.
`,
    "utf8",
  );

  await pool.query(
    `INSERT INTO "agents" ("id", "flow_ref_id", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path")
     VALUES ($1, 'test-pkg', 'v1.0.0', 'git', $2, 'd', $5, 'session', $3::jsonb, $6, $4)`,
    [
      qualifiedId,
      args.id,
      JSON.stringify(args.triggers),
      path.join(agentsRoot, "maister-agents", `${args.id}.md`),
      workspace,
      riskTier,
    ],
  );
  await pool.query(
    `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id") VALUES ($1, $2, $3)`,
    [randomUUID(), qualifiedId, projectId],
  );

  return qualifiedId;
}

function fakeEvent(overrides: Partial<DomainEventRow>): DomainEventRow {
  return {
    id: 1n as unknown as DomainEventRow["id"],
    kind: "task.created",
    projectId,
    taskId: null,
    runId: null,
    actorType: "user",
    actorId: randomUUID(),
    payload: { title: "t" },
    occurredAt: new Date(),
    createdAt: new Date(),
    txId: "0" as unknown as DomainEventRow["txId"],
    ...overrides,
  } as DomainEventRow;
}

describe("agent cron dispatcher (agent_tick.dispatcher)", () => {
  it("claims a due row exactly once across concurrent ticks and never backfills", async () => {
    const cronAgent = await seedAgent({ id: "cron-agent", triggers: ["cron"] });

    const past = new Date(Date.now() - 10 * 60_000);

    await pool.query(
      `INSERT INTO "agent_schedules" ("id", "agent_id", "project_id", "trigger_type", "cron_expr", "timezone", "next_fire_at")
       VALUES ($1, $2, $3, 'cron', '*/5 * * * *', 'UTC', $4)`,
      [randomUUID(), cronAgent, projectId, past],
    );

    const launches: string[] = [];
    const launch = async (
      input: Parameters<typeof launchModule.launchAgentRun>[0],
    ) => {
      launches.push(input.agentId);

      return { runId: randomUUID(), status: "Running" as const };
    };

    const [a, b] = await Promise.all([
      triggers.dispatchDueAgentSchedules({ db, launch }),
      triggers.dispatchDueAgentSchedules({ db, launch }),
    ]);

    // Exactly one tick wins the claim; the missed window fires once.
    expect(a.claimed + b.claimed).toBe(1);
    expect(launches).toEqual(["test-pkg:cron-agent"]);

    const row = await pool.query(
      `SELECT "next_fire_at", "last_fired_at" FROM "agent_schedules"`,
    );

    expect(new Date(row.rows[0].next_fire_at).getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );
    expect(row.rows[0].last_fired_at).not.toBeNull();

    // A third tick sees nothing due.
    const c = await triggers.dispatchDueAgentSchedules({ db, launch });

    expect(c.claimed).toBe(0);
    expect(launches).toHaveLength(1);
  });
});

describe("agent_triggers outbox consumer (ADR-086/087)", () => {
  it("at-least-once redelivery of the same event converges to exactly one run", async () => {
    const eventAgent = await seedAgent({
      id: "event-agent",
      triggers: ["domain_event"],
    });

    await pool.query(
      `INSERT INTO "agent_schedules" ("id", "agent_id", "project_id", "trigger_type", "event_match")
       VALUES ($1, $2, $3, 'event', '{"kinds":["task.created"]}'::jsonb)`,
      [randomUUID(), eventAgent, projectId],
    );

    const consumer = triggers.buildAgentTriggersConsumer({ db });
    const event = fakeEvent({ id: 777 as unknown as DomainEventRow["id"] });

    // Same window delivered twice (crash-before-advance redelivery).
    await consumer.handle([event]);
    await consumer.handle([event]);

    const runs = await pool.query(
      `SELECT "trigger_event_id", "status" FROM "runs" WHERE "agent_id" = $1`,
      [eventAgent],
    );

    expect(runs.rows).toHaveLength(1);
    expect(Number(runs.rows[0].trigger_event_id)).toBe(777);
  });

  it("self-actored events never re-trigger the agent; foreign actors do", async () => {
    const triager = await seedAgent({
      id: "triager",
      triggers: ["domain_event"],
    });

    await pool.query(
      `INSERT INTO "agent_schedules" ("id", "agent_id", "project_id", "trigger_type", "event_match")
       VALUES ($1, $2, $3, 'event', '{"kinds":["task.comment_added"]}'::jsonb)`,
      [randomUUID(), triager, projectId],
    );

    const consumer = triggers.buildAgentTriggersConsumer({ db });

    // The triager's own comment (the question it just asked).
    await consumer.handle([
      fakeEvent({
        id: 1001 as unknown as DomainEventRow["id"],
        kind: "task.comment_added",
        actorType: "agent",
        actorId: triager,
      }),
    ]);

    let runs = await pool.query(
      `SELECT count(*)::int AS n FROM "runs" WHERE "agent_id" = $1`,
      [triager],
    );

    expect(runs.rows[0].n).toBe(0);

    // The human's reply re-triggers it.
    await consumer.handle([
      fakeEvent({
        id: 1002 as unknown as DomainEventRow["id"],
        kind: "task.comment_added",
        actorType: "user",
        actorId: randomUUID(),
      }),
    ]);

    runs = await pool.query(
      `SELECT count(*)::int AS n FROM "runs" WHERE "agent_id" = $1`,
      [triager],
    );

    expect(runs.rows[0].n).toBe(1);
  });

  it("kind/project mismatches and refusals never throw (idempotent contract)", async () => {
    const narrowAgent = await seedAgent({
      id: "narrow-agent",
      triggers: ["domain_event"],
    });

    await pool.query(
      `INSERT INTO "agent_schedules" ("id", "agent_id", "project_id", "trigger_type", "event_match")
       VALUES ($1, $2, $3, 'event', '{"kinds":["run.failed"]}'::jsonb)`,
      [randomUUID(), narrowAgent, projectId],
    );

    const consumer = triggers.buildAgentTriggersConsumer({ db });

    // Wrong kind + wrong project: both no-ops, no throw.
    await consumer.handle([
      fakeEvent({ id: 2001 as unknown as DomainEventRow["id"] }),
      fakeEvent({
        id: 2002 as unknown as DomainEventRow["id"],
        kind: "run.failed",
        projectId: randomUUID(),
      }),
    ]);

    const runs = await pool.query(
      `SELECT count(*)::int AS n FROM "runs" WHERE "agent_id" = $1`,
      [narrowAgent],
    );

    expect(runs.rows[0].n).toBe(0);
  });

  it("pin divergence: the pinned version lacking the trigger refuses without throwing (RD4)", async () => {
    // Index row advertises domain_event, but the PINNED definition file only
    // declares manual — the effective-definition guard refuses the launch.
    const divergent = await seedAgent({
      id: "divergent-agent",
      triggers: ["manual"],
    });

    await pool.query(
      `UPDATE "agents" SET "triggers" = '["manual","domain_event"]'::jsonb WHERE "id" = $1`,
      [divergent],
    );
    await pool.query(
      `INSERT INTO "agent_schedules" ("id", "agent_id", "project_id", "trigger_type", "event_match")
       VALUES ($1, $2, $3, 'event', '{"kinds":["task.created"]}'::jsonb)`,
      [randomUUID(), divergent, projectId],
    );

    const consumer = triggers.buildAgentTriggersConsumer({ db });

    await consumer.handle([
      fakeEvent({ id: 3001 as unknown as DomainEventRow["id"] }),
    ]);

    const runs = await pool.query(
      `SELECT count(*)::int AS n FROM "runs" WHERE "agent_id" = $1`,
      [divergent],
    );

    expect(runs.rows[0].n).toBe(0);
  });
});

describe("agent launch refusals (ADR-090)", () => {
  it("refuses a risk_tier=destructive agent (PRECONDITION, ADR-041 gate)", async () => {
    const agentId = await seedAgent({
      id: "destroyer",
      triggers: ["manual"],
      riskTier: "destructive",
    });

    let err: { code?: string; message?: string } | null = null;

    try {
      await launchModule.launchAgentRun({
        agentId,
        projectId,
        trigger: { source: "manual" },
        db,
      });
    } catch (e) {
      err = e as { code?: string; message?: string };
    }

    expect(err).not.toBeNull();
    expect(err?.code).toBe("PRECONDITION");
    expect(String(err?.message)).toMatch(/destructive/);
  });

  it("refuses a repo_read launch when the parent checkout is dirty", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "maister-baseline-"));

    await exec("git", ["-C", repo, "init", "-q", "-b", "main"]);
    await writeFile(path.join(repo, "README.md"), "hi\n");
    await exec("git", ["-C", repo, "add", "-A"]);
    await exec("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "init",
    ]);
    // Leave an uncommitted file so the baseline is dirty.
    await writeFile(path.join(repo, "stray.txt"), "uncommitted\n");
    await pool.query(`UPDATE "projects" SET "repo_path" = $1 WHERE "id" = $2`, [
      repo,
      projectId,
    ]);

    const agentId = await seedAgent({
      id: "reader",
      triggers: ["manual"],
      workspace: "repo_read",
    });

    let err: { code?: string; message?: string } | null = null;

    try {
      await launchModule.launchAgentRun({
        agentId,
        projectId,
        trigger: { source: "manual" },
        db,
      });
    } catch (e) {
      err = e as { code?: string; message?: string };
    }

    expect(err).not.toBeNull();
    expect(err?.code).toBe("PRECONDITION");
    expect(String(err?.message)).toMatch(/dirty/);
  });
});
