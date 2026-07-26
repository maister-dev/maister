// ADR-151 — Summonable(agent, project) against real Postgres. The predicate is
// the one place both the comment write path and the consumer read eligibility
// from, so each conjunct gets its own row in the matrix.

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  listMentionCandidateAgents,
  MENTION_SUPPRESSION_STATUSES,
} from "@/lib/agents/summonability";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;
let otherProjectId: string;

function newId(): string {
  return randomUUID();
}

async function seedProject(label: string): Promise<string> {
  const id = newId();
  const short = id.replace(/-/g, "").slice(0, 8);

  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "maister_yaml_path", "task_key")
     VALUES ($1, $2, $3, $4, '/tmp/m.yaml', $5)`,
    [
      id,
      `summon-${label}-${short}`,
      `Summon ${label}`,
      `/tmp/summon-${label}-${short}`,
      `S${short.toUpperCase()}`,
    ],
  );

  return id;
}

async function seedAgent(args: {
  stem: string;
  triggers?: string[];
  enabled?: boolean;
  quarantined?: boolean;
  packageName?: string;
}): Promise<string> {
  const pkg = args.packageName ?? "core";
  const id = `${pkg}:${args.stem}`;

  await pool.query(
    `INSERT INTO "agents"
       ("id", "package_name", "version_label", "origin", "name", "description",
        "workspace", "mode", "triggers", "risk_tier", "source_path", "enabled", "quarantined_at")
     VALUES ($1, $2, 'v1.0.0', 'git', $3, 'd', 'none', 'session', $4::jsonb,
             'read_only', '/tmp/a.md', $5, $6)`,
    [
      id,
      pkg,
      args.stem,
      JSON.stringify(args.triggers ?? ["domain_event"]),
      args.enabled ?? true,
      args.quarantined ? new Date() : null,
    ],
  );

  return id;
}

async function link(
  agentId: string,
  target: string,
  enabled = true,
): Promise<void> {
  await pool.query(
    `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id", "enabled")
     VALUES ($1, $2, $3, $4)`,
    [newId(), agentId, target, enabled],
  );
}

async function mentionBinding(
  agentId: string,
  target: string,
  enabled = true,
): Promise<void> {
  await pool.query(
    `INSERT INTO "agent_schedules" ("id", "agent_id", "project_id", "trigger_type", "enabled")
     VALUES ($1, $2, $3, 'mention', $4)`,
    [newId(), agentId, target, enabled],
  );
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "summonability_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "agent_schedules"`);
  await pool.query(`DELETE FROM "agent_project_links"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "projects"`);

  projectId = await seedProject("main");
  otherProjectId = await seedProject("other");
});

describe("listMentionCandidateAgents (ADR-151)", () => {
  it("returns a fully eligible agent as summonable", async () => {
    const id = await seedAgent({ stem: "triager" });

    await link(id, projectId);
    await mentionBinding(id, projectId);

    expect(await listMentionCandidateAgents(db, projectId)).toEqual([
      { id, stem: "triager", name: "triager", summonable: true },
    ]);
  });

  it("omits an agent with no attachment to this project", async () => {
    await seedAgent({ stem: "detached" });

    expect(await listMentionCandidateAgents(db, projectId)).toEqual([]);
  });

  // Every remaining conjunct keeps the agent VISIBLE (so the handle still
  // expands to a chip) but marks it non-summonable — that is what the
  // comment footnote reports.
  it("marks a disabled link non-summonable", async () => {
    const id = await seedAgent({ stem: "linkoff" });

    await link(id, projectId, false);
    await mentionBinding(id, projectId);

    expect(await listMentionCandidateAgents(db, projectId)).toEqual([
      { id, stem: "linkoff", name: "linkoff", summonable: false },
    ]);
  });

  it("marks a disabled agent non-summonable", async () => {
    const id = await seedAgent({ stem: "agentoff", enabled: false });

    await link(id, projectId);
    await mentionBinding(id, projectId);

    expect((await listMentionCandidateAgents(db, projectId))[0]?.summonable).toBe(
      false,
    );
  });

  it("marks a quarantined agent non-summonable", async () => {
    const id = await seedAgent({ stem: "quarantined", quarantined: true });

    await link(id, projectId);
    await mentionBinding(id, projectId);

    expect((await listMentionCandidateAgents(db, projectId))[0]?.summonable).toBe(
      false,
    );
  });

  it("marks an agent with no mention binding non-summonable", async () => {
    const id = await seedAgent({ stem: "nobinding" });

    await link(id, projectId);

    expect((await listMentionCandidateAgents(db, projectId))[0]?.summonable).toBe(
      false,
    );
  });

  it("marks an agent whose only mention binding is disabled non-summonable", async () => {
    const id = await seedAgent({ stem: "bindingoff" });

    await link(id, projectId);
    await mentionBinding(id, projectId, false);

    expect((await listMentionCandidateAgents(db, projectId))[0]?.summonable).toBe(
      false,
    );
  });

  // The launch source stays `domain_event` (D2), so a definition that does not
  // declare that trigger would be refused by the `trigger_missing` gate.
  it("marks a definition without the domain_event trigger non-summonable", async () => {
    const id = await seedAgent({ stem: "manualonly", triggers: ["manual"] });

    await link(id, projectId);
    await mentionBinding(id, projectId);

    expect((await listMentionCandidateAgents(db, projectId))[0]?.summonable).toBe(
      false,
    );
  });

  it("is scoped to the project — a sibling project's agent never appears", async () => {
    const mine = await seedAgent({ stem: "mine" });
    const theirs = await seedAgent({ stem: "theirs" });

    await link(mine, projectId);
    await mentionBinding(mine, projectId);
    await link(theirs, otherProjectId);
    await mentionBinding(theirs, otherProjectId);

    const ids = (await listMentionCandidateAgents(db, projectId)).map(
      (a) => a.id,
    );

    expect(ids).toEqual([mine]);
  });

  // A binding belonging to ANOTHER project must not make this project's
  // attachment summonable.
  it("ignores a mention binding scoped to a different project", async () => {
    const id = await seedAgent({ stem: "crossbind" });

    await link(id, projectId);
    await link(id, otherProjectId);
    await mentionBinding(id, otherProjectId);

    expect((await listMentionCandidateAgents(db, projectId))[0]?.summonable).toBe(
      false,
    );
  });

  it("returns same-stem agents from different packages so a bare handle stays ambiguous", async () => {
    const core = await seedAgent({ stem: "reviewer", packageName: "core" });
    const aif = await seedAgent({ stem: "reviewer", packageName: "aif" });

    await link(core, projectId);
    await link(aif, projectId);
    await mentionBinding(core, projectId);

    const rows = await listMentionCandidateAgents(db, projectId);

    expect(rows.map((r) => r.id).sort()).toEqual([aif, core].sort());
    expect(rows.every((r) => r.stem === "reviewer")).toBe(true);
  });
});

describe("MENTION_SUPPRESSION_STATUSES", () => {
  // A per-concern predicate, deliberately NOT ACTIVE_RUN_STATUSES: Pending is
  // included so a queued summon is not double-queued, while Review and Crashed
  // are excluded because re-mentioning after those is the rework loop.
  it("includes Pending and excludes Review and Crashed", () => {
    expect([...MENTION_SUPPRESSION_STATUSES].sort()).toEqual(
      [
        "HumanWorking",
        "NeedsInput",
        "NeedsInputIdle",
        "Pending",
        "Running",
        "WaitingOnChildren",
      ].sort(),
    );
  });
});
