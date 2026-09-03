import type { DomainEventRow } from "@/lib/db/schema";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  GRAPH_ONLY_CUTOVER_REASON,
  GRAPH_ONLY_CUTOVER_SOURCE,
} from "@/lib/domain-events/cutover";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
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

  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
  // ADR-164: every launch places the run on the local execution host.
  await fakeExecutionHosts(db);

  triggers = await import("@/lib/agents/triggers");
  launchModule = await import("@/lib/agents/launch");
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "agent_schedules"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "project_package_attachments"`);
  await pool.query(`DELETE FROM "package_installs"`);
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

  // (ADR-106) The package-anchored chain the REAL launch path resolves
  // through: an attached, trusted, Installed package_install at agentsRoot.
  const packageInstallId = randomUUID();

  await pool.query(
    `INSERT INTO "package_installs"
       ("id", "source_url", "name", "version_label", "resolved_revision",
        "manifest", "manifest_digest", "installed_path", "package_status", "trust_status")
     VALUES ($1, 'github.com/acme/test-pkg', 'test-pkg', 'v1.0.0', 'rev-pkg-1',
             '{}'::jsonb, 'digest', $2, 'Installed', 'trusted')`,
    [packageInstallId, agentsRoot],
  );
  await pool.query(
    `INSERT INTO "project_package_attachments"
       ("id", "project_id", "package_install_id", "package_name")
     VALUES ($1, $2, $3, 'test-pkg')`,
    [randomUUID(), projectId, packageInstallId],
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
    `INSERT INTO "agents" ("id", "package_name", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path")
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

async function seedTask(): Promise<string> {
  const taskId = randomUUID();

  await pool.query(
    `INSERT INTO "tasks" ("id", "project_id", "number", "title", "prompt")
     VALUES ($1, $2, $3, 'Clarify deployment', 'Deploy the service')`,
    [taskId, projectId, Math.trunc(Math.random() * 1e9) + 1],
  );

  return taskId;
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

  // ADR-151 D8: the tick filters trigger_type='cron' explicitly, so a mention
  // row (all-null cron columns) is invisible to it. Asserted, not assumed —
  // a mention row picked up here would crash on its null cron_expr.
  it("never claims a mention binding", async () => {
    const mentionAgent = await seedAgent({
      id: "mention-cron-agent",
      triggers: ["domain_event"],
    });

    await pool.query(
      `INSERT INTO "agent_schedules" ("id", "agent_id", "project_id", "trigger_type")
       VALUES ($1, $2, $3, 'mention')`,
      [randomUUID(), mentionAgent, projectId],
    );

    const launches: string[] = [];
    const summary = await triggers.dispatchDueAgentSchedules({
      db,
      launch: async (input) => {
        launches.push(input.agentId);

        return { runId: randomUUID(), status: "Running" as const };
      },
    });

    expect(summary.due).toBe(0);
    expect(summary.claimed).toBe(0);
    expect(launches).toEqual([]);
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

  // ADR-163: `run.review` now has a SECOND emitter — the flow graph runner's
  // Review branch, for a delegated flow child. That widens the population this
  // consumer sees, and the widening is INTENDED, not incidental: an agent bound
  // to `run.review` fires on a delegated flow child's review exactly as it does
  // on an agent child's. Pinned so a future narrowing of the matcher (or of the
  // emit) is a loud failure rather than a silently missing trigger.
  it("delivers a FLOW child's run.review to an agent bound to that kind", async () => {
    const reviewAgent = await seedAgent({
      id: "review-watcher",
      triggers: ["domain_event"],
    });

    await pool.query(
      `INSERT INTO "agent_schedules" ("id", "agent_id", "project_id", "trigger_type", "event_match")
       VALUES ($1, $2, $3, 'event', '{"kinds":["run.review"]}'::jsonb)`,
      [randomUUID(), reviewAgent, projectId],
    );

    const consumer = triggers.buildAgentTriggersConsumer({ db });

    await consumer.handle([
      fakeEvent({
        id: 4242 as unknown as DomainEventRow["id"],
        kind: "run.review",
        actorType: "system",
        actorId: null,
        payload: {
          runKind: "flow",
          status: "Review",
          parentRunId: randomUUID(),
        },
      }),
    ]);

    const runs = await pool.query(
      `SELECT "trigger_event_id" FROM "runs" WHERE "agent_id" = $1`,
      [reviewAgent],
    );

    expect(runs.rows).toHaveLength(1);
    expect(Number(runs.rows[0].trigger_event_id)).toBe(4242);
  });

  // ADR-151 D8: the generic matcher filters trigger_type='event' explicitly,
  // so a mention binding never joins the eventMatch.kinds fan-out (its
  // event_match is null and would match nothing anyway — the point is that the
  // filter, not the null payload, is what excludes it).
  it("the generic event matcher never selects a mention binding", async () => {
    const mentionAgent = await seedAgent({
      id: "mention-generic-agent",
      triggers: ["domain_event"],
    });

    await pool.query(
      `INSERT INTO "agent_schedules" ("id", "agent_id", "project_id", "trigger_type")
       VALUES ($1, $2, $3, 'mention')`,
      [randomUUID(), mentionAgent, projectId],
    );

    const consumer = triggers.buildAgentTriggersConsumer({ db });

    await consumer.handle([
      fakeEvent({
        id: 811 as unknown as DomainEventRow["id"],
        kind: "task.created",
      }),
    ]);

    const runs = await pool.query(
      `SELECT "id" FROM "runs" WHERE "agent_id" = $1`,
      [mentionAgent],
    );
    const outcome = await pool.query(
      `SELECT "last_outcome", "last_attempt_at" FROM "agent_schedules" WHERE "agent_id" = $1`,
      [mentionAgent],
    );

    expect(runs.rows).toHaveLength(0);
    expect(outcome.rows[0]).toEqual({
      last_outcome: null,
      last_attempt_at: null,
    });
  });

  it("routes a clarification answer only to its requesting attached agent without a schedule", async () => {
    const requestingAgent = await seedAgent({
      id: "requesting-agent",
      triggers: ["domain_event"],
    });
    const unrelatedSubscriber = await seedAgent({
      id: "unrelated-subscriber",
      triggers: ["domain_event"],
    });
    const taskId = await seedTask();

    // This schedule is deliberately eligible for the same event. A directed
    // clarification answer must never fall through to public subscriptions.
    await pool.query(
      `INSERT INTO "agent_schedules" ("id", "agent_id", "project_id", "trigger_type", "event_match")
       VALUES ($1, $2, $3, 'event', '{"kinds":["task.clarification_answered"]}'::jsonb)`,
      [randomUUID(), unrelatedSubscriber, projectId],
    );

    const event = fakeEvent({
      id: 4001 as unknown as DomainEventRow["id"],
      kind: "task.clarification_answered",
      taskId,
      payload: {
        clarificationId: randomUUID(),
        hitlRequestId: randomUUID(),
        requestingAgentId: requestingAgent,
      },
    });
    const consumer = triggers.buildAgentTriggersConsumer({ db });

    await consumer.handle([event]);
    await consumer.handle([event]);

    const runs = await pool.query(
      `SELECT "agent_id", "trigger_event_id", "task_id" FROM "runs" WHERE "trigger_event_id" = 4001`,
    );

    expect(runs.rows).toEqual([
      {
        agent_id: requestingAgent,
        trigger_event_id: "4001",
        task_id: taskId,
      },
    ]);
  });

  it.each([
    {
      name: "the requester is disabled",
      sql: `UPDATE "agents" SET "enabled" = false WHERE "id" = $1`,
    },
    {
      name: "the project attachment is disabled",
      sql: `UPDATE "agent_project_links" SET "enabled" = false WHERE "agent_id" = $1`,
    },
    {
      name: "the requester is quarantined",
      sql: `UPDATE "agents" SET "quarantined_at" = now() WHERE "id" = $1`,
    },
  ])("fails closed when $name", async ({ sql: updateSql }) => {
    const requestingAgent = await seedAgent({
      id: "ineligible-requester",
      triggers: ["domain_event"],
    });
    const taskId = await seedTask();

    await pool.query(updateSql, [requestingAgent]);

    await triggers.buildAgentTriggersConsumer({ db }).handle([
      fakeEvent({
        id: 4002 as unknown as DomainEventRow["id"],
        kind: "task.clarification_answered",
        taskId,
        payload: {
          clarificationId: randomUUID(),
          hitlRequestId: randomUUID(),
          requestingAgentId: requestingAgent,
        },
      }),
    ]);

    const runs = await pool.query(
      `SELECT count(*)::int AS n FROM "runs" WHERE "trigger_event_id" = 4002`,
    );

    expect(runs.rows[0].n).toBe(0);
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

  it("does not launch an event agent for a graph-only cut-over failure", async () => {
    const agent = await seedAgent({
      id: "cutover-agent",
      triggers: ["domain_event"],
    });

    await pool.query(
      `INSERT INTO "agent_schedules" ("id", "agent_id", "project_id", "trigger_type", "event_match")
       VALUES ($1, $2, $3, 'event', '{"kinds":["run.failed"]}'::jsonb)`,
      [randomUUID(), agent, projectId],
    );

    await triggers.buildAgentTriggersConsumer({ db }).handle([
      fakeEvent({
        id: 2100 as unknown as DomainEventRow["id"],
        kind: "run.failed",
        runId: randomUUID(),
        payload: {
          reason: GRAPH_ONLY_CUTOVER_REASON,
          source: GRAPH_ONLY_CUTOVER_SOURCE,
        },
      }),
    ]);

    const runs = await pool.query(
      `SELECT count(*)::int AS n FROM "runs" WHERE "agent_id" = $1`,
      [agent],
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

// ADR-151 — one case per row of the frozen summon decision table, plus the
// interaction cases that keep the pre-existing generic path intact.
describe("mention summons in the agent_triggers consumer (ADR-151)", () => {
  async function seedMentionAgent(args: {
    id: string;
    triggers?: string[];
    binding?: boolean;
    bindingEnabled?: boolean;
  }): Promise<{ agentId: string; scheduleId: string | null }> {
    const agentId = await seedAgent({
      id: args.id,
      triggers: args.triggers ?? ["domain_event"],
    });

    if (args.binding === false) return { agentId, scheduleId: null };

    const scheduleId = randomUUID();

    await pool.query(
      `INSERT INTO "agent_schedules" ("id", "agent_id", "project_id", "trigger_type", "enabled")
       VALUES ($1, $2, $3, 'mention', $4)`,
      [scheduleId, agentId, projectId, args.bindingEnabled ?? true],
    );

    return { agentId, scheduleId };
  }

  function commentEvent(over: {
    id: number;
    taskId?: string | null;
    mentionedAgentIds?: string[];
    actorType?: "user" | "agent" | "system";
    actorId?: string | null;
  }): DomainEventRow {
    return fakeEvent({
      id: over.id as unknown as DomainEventRow["id"],
      kind: "task.comment_added",
      taskId: over.taskId ?? null,
      actorType: over.actorType ?? "user",
      actorId: over.actorId ?? randomUUID(),
      payload: {
        taskKey: "K-1",
        commentId: randomUUID(),
        ...(over.mentionedAgentIds
          ? { mentionedAgentIds: over.mentionedAgentIds }
          : {}),
      },
    });
  }

  async function outcomeOf(scheduleId: string): Promise<Record<string, any>> {
    const rows = await pool.query(
      `SELECT "last_outcome", "last_error_code", "last_run_id" FROM "agent_schedules" WHERE "id" = $1`,
      [scheduleId],
    );

    return rows.rows[0];
  }

  async function runCount(agentId: string): Promise<number> {
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM "runs" WHERE "agent_id" = $1`,
      [agentId],
    );

    return rows.rows[0].n;
  }

  async function suppressionRows(taskId: string): Promise<any[]> {
    const rows = await pool.query(
      `SELECT "payload", "actor_type" FROM "task_activity"
       WHERE "task_id" = $1 AND "event_kind" = 'agent_summon_suppressed'`,
      [taskId],
    );

    return rows.rows;
  }

  // Row 6 — the happy path.
  it("launches a directed run carrying task_id and trigger_event_id", async () => {
    const { agentId, scheduleId } = await seedMentionAgent({ id: "m-launch" });
    const taskId = await seedTask();

    await triggers
      .buildAgentTriggersConsumer({ db })
      .handle([
        commentEvent({ id: 5001, taskId, mentionedAgentIds: [agentId] }),
      ]);

    const runs = await pool.query(
      `SELECT "task_id", "trigger_event_id", "trigger_source", "status", "agent_schedule_id", "trigger_payload"
       FROM "runs" WHERE "agent_id" = $1`,
      [agentId],
    );

    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]).toMatchObject({
      task_id: taskId,
      trigger_event_id: "5001",
      trigger_source: "domain_event",
      status: "Running",
      agent_schedule_id: scheduleId,
    });
    // runs.trigger_payload stores the INNER object; its {kind, payload} core is
    // what taskCommentTriggerContextBlock routes on, and `mentionedBy` is an
    // additive sibling that leaves that routing untouched.
    expect(runs.rows[0].trigger_payload).toMatchObject({
      kind: "task.comment_added",
      payload: { taskKey: "K-1" },
      mentionedBy: { actorType: "user" },
    });
    expect(await outcomeOf(scheduleId!)).toMatchObject({
      last_outcome: "launched",
    });
  });

  // Row 1 — defensive: comments are always task-scoped.
  it("skips the whole branch when the event carries no task id", async () => {
    const { agentId, scheduleId } = await seedMentionAgent({ id: "m-notask" });

    await triggers
      .buildAgentTriggersConsumer({ db })
      .handle([
        commentEvent({ id: 5002, taskId: null, mentionedAgentIds: [agentId] }),
      ]);

    expect(await runCount(agentId)).toBe(0);
    expect(await outcomeOf(scheduleId!)).toMatchObject({ last_outcome: null });
  });

  // Rows 2 + 4 — no eligible binding at consume time.
  it.each([
    { name: "no mention binding at all", binding: false as const },
    { name: "the mention binding is disabled", bindingEnabled: false },
    { name: "the definition lacks domain_event", triggers: ["manual"] },
  ])("does not launch when $name", async (variant) => {
    const { agentId } = await seedMentionAgent({
      id: `m-skip-${Math.trunc(Math.random() * 1e6)}`,
      ...variant,
    });
    const taskId = await seedTask();

    await triggers
      .buildAgentTriggersConsumer({ db })
      .handle([
        commentEvent({ id: 5003, taskId, mentionedAgentIds: [agentId] }),
      ]);

    expect(await runCount(agentId)).toBe(0);
    expect(await suppressionRows(taskId)).toHaveLength(0);
  });

  // Row 3 — structural loop termination.
  it("never summons an agent through its own comment", async () => {
    const { agentId, scheduleId } = await seedMentionAgent({ id: "m-self" });
    const other = await seedMentionAgent({ id: "m-other" });
    const taskId = await seedTask();

    await triggers.buildAgentTriggersConsumer({ db }).handle([
      commentEvent({
        id: 5004,
        taskId,
        mentionedAgentIds: [agentId, other.agentId],
        actorType: "agent",
        actorId: agentId,
      }),
    ]);

    expect(await runCount(agentId)).toBe(0);
    expect(await outcomeOf(scheduleId!)).toMatchObject({ last_outcome: null });
    // Mentioning a DIFFERENT agent in the same comment still works.
    expect(await runCount(other.agentId)).toBe(1);
  });

  // Rows 5 + 12 — suppression, and its structural idempotency.
  it("suppresses when the agent already has an active run and stays one row under redelivery", async () => {
    const { agentId, scheduleId } = await seedMentionAgent({ id: "m-busy" });
    const taskId = await seedTask();

    await pool.query(
      `INSERT INTO "runs" ("id", "project_id", "task_id", "agent_id", "run_kind", "status", "flow_version", "flow_revision", "started_at")
       VALUES ($1, $2, $3, $4, 'agent', 'Running', 'v1', 'manual', now())`,
      [randomUUID(), projectId, taskId, agentId],
    );

    const consumer = triggers.buildAgentTriggersConsumer({ db });
    const event = commentEvent({
      id: 5005,
      taskId,
      mentionedAgentIds: [agentId],
    });

    await consumer.handle([event]);
    await consumer.handle([event]);

    // Only the pre-seeded run exists — no summon.
    expect(await runCount(agentId)).toBe(1);

    const notes = await suppressionRows(taskId);

    expect(notes).toHaveLength(1);
    expect(notes[0].actor_type).toBe("system");
    expect(notes[0].payload).toMatchObject({
      agentId,
      triggerEventId: "5005",
    });
    expect(await outcomeOf(scheduleId!)).toMatchObject({
      last_outcome: "suppressed",
    });
  });

  // Row 5 boundary — Review and Crashed are deliberately NOT suppressing.
  it.each(["Review", "Crashed"])(
    "re-summons over a %s run — that is the rework loop",
    async (status) => {
      const { agentId } = await seedMentionAgent({
        id: `m-${status.toLowerCase()}`,
      });
      const taskId = await seedTask();

      await pool.query(
        `INSERT INTO "runs" ("id", "project_id", "task_id", "agent_id", "run_kind", "status", "flow_version", "flow_revision", "started_at")
         VALUES ($1, $2, $3, $4, 'agent', $5, 'v1', 'manual', now())`,
        [randomUUID(), projectId, taskId, agentId, status],
      );

      await triggers
        .buildAgentTriggersConsumer({ db })
        .handle([
          commentEvent({ id: 5006, taskId, mentionedAgentIds: [agentId] }),
        ]);

      expect(await runCount(agentId)).toBe(2);
      expect(await suppressionRows(taskId)).toHaveLength(0);
    },
  );

  // Row 8 — the claim is the run INSERT under runs_agent_trigger_event_uq.
  it("redelivery of the same event creates exactly one run", async () => {
    const { agentId, scheduleId } = await seedMentionAgent({ id: "m-dedup" });
    const taskId = await seedTask();
    const consumer = triggers.buildAgentTriggersConsumer({ db });
    const event = commentEvent({
      id: 5007,
      taskId,
      mentionedAgentIds: [agentId],
    });

    await consumer.handle([event]);
    await consumer.handle([event]);

    expect(await runCount(agentId)).toBe(1);
    expect(await outcomeOf(scheduleId!)).toMatchObject({
      last_outcome: "deduplicated",
    });
    // The run the FIRST delivery created must not be read as "already busy" —
    // a suppression note here would claim the summon was skipped when it ran.
    expect(await suppressionRows(taskId)).toHaveLength(0);
  });

  // Row 7 — over-cap queues; it must never be dropped or throw.
  it("queues a summon as Pending when the agent pool is at cap", async () => {
    const { agentId, scheduleId } = await seedMentionAgent({ id: "m-queued" });
    const taskId = await seedTask();
    const launch: NonNullable<
      Parameters<typeof triggers.buildAgentTriggersConsumer>[0]
    >["launch"] = async () => ({
      runId: randomUUID(),
      status: "Pending" as const,
      queuePosition: 2,
    });

    await triggers
      .buildAgentTriggersConsumer({ db, launch })
      .handle([
        commentEvent({ id: 5008, taskId, mentionedAgentIds: [agentId] }),
      ]);

    expect(await outcomeOf(scheduleId!)).toMatchObject({
      last_outcome: "queued",
    });
  });

  // Rows 9 + 10 — a refusal is recorded, never rethrown.
  it("records a refusal with its code and a crash as failed, without throwing", async () => {
    const refused = await seedMentionAgent({ id: "m-refused" });
    const crashed = await seedMentionAgent({ id: "m-crashed" });
    const taskId = await seedTask();
    let call = 0;
    const launch: NonNullable<
      Parameters<typeof triggers.buildAgentTriggersConsumer>[0]
    >["launch"] = async () => {
      call += 1;
      if (call === 1) {
        const { MaisterError } = await import("@/lib/errors");

        throw new MaisterError("PRECONDITION", "trust revoked");
      }
      throw new Error("boom");
    };

    await expect(
      triggers.buildAgentTriggersConsumer({ db, launch }).handle([
        commentEvent({
          id: 5009,
          taskId,
          mentionedAgentIds: [refused.agentId, crashed.agentId],
        }),
      ]),
    ).resolves.toBeUndefined();

    expect(await outcomeOf(refused.scheduleId!)).toMatchObject({
      last_outcome: "refused",
      last_error_code: "PRECONDITION",
    });
    // The first agent's failure must not stop the second from being evaluated.
    expect(await outcomeOf(crashed.scheduleId!)).toMatchObject({
      last_outcome: "failed",
      last_error_code: "CRASH",
    });
  });

  it("launches one run per mentioned agent and dedupes a repeated id", async () => {
    const first = await seedMentionAgent({ id: "m-two-a" });
    const second = await seedMentionAgent({ id: "m-two-b" });
    const taskId = await seedTask();

    await triggers.buildAgentTriggersConsumer({ db }).handle([
      commentEvent({
        id: 5010,
        taskId,
        mentionedAgentIds: [first.agentId, second.agentId, first.agentId],
      }),
    ]);

    expect(await runCount(first.agentId)).toBe(1);
    expect(await runCount(second.agentId)).toBe(1);
  });

  // Row 13 — additivity. The generic single-owner rule is unchanged, and the
  // (agent, event) unique makes the two paths converge on ONE run.
  it("an agent holding BOTH a mention and a generic binding gets exactly one run", async () => {
    const { agentId, scheduleId } = await seedMentionAgent({ id: "m-both" });
    const genericId = randomUUID();

    await pool.query(
      `INSERT INTO "agent_schedules" ("id", "agent_id", "project_id", "trigger_type", "event_match")
       VALUES ($1, $2, $3, 'event', '{"kinds":["task.comment_added"]}'::jsonb)`,
      [genericId, agentId, projectId],
    );

    const taskId = await seedTask();

    await triggers
      .buildAgentTriggersConsumer({ db })
      .handle([
        commentEvent({ id: 5011, taskId, mentionedAgentIds: [agentId] }),
      ]);

    expect(await runCount(agentId)).toBe(1);
    expect(await outcomeOf(scheduleId!)).toMatchObject({
      last_outcome: "launched",
    });
    // The generic binding still fired and settled — it just deduped.
    expect(await outcomeOf(genericId)).toMatchObject({
      last_outcome: "deduplicated",
    });
  });

  it("leaves a mention-free comment on the generic path untouched", async () => {
    const agentId = await seedAgent({
      id: "m-generic-only",
      triggers: ["domain_event"],
    });
    const genericId = randomUUID();

    await pool.query(
      `INSERT INTO "agent_schedules" ("id", "agent_id", "project_id", "trigger_type", "event_match")
       VALUES ($1, $2, $3, 'event', '{"kinds":["task.comment_added"]}'::jsonb)`,
      [genericId, agentId, projectId],
    );

    const taskId = await seedTask();

    await triggers
      .buildAgentTriggersConsumer({ db })
      .handle([commentEvent({ id: 5012, taskId })]);

    expect(await runCount(agentId)).toBe(1);
    expect(await outcomeOf(genericId)).toMatchObject({
      last_outcome: "launched",
    });
  });
});
