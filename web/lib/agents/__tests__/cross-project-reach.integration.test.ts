// ADR-156 (D6/D6b/D7) — cross-project agent facade reach and the
// agent-chain-depth budget over REAL Postgres rows.
//
// The in-memory truth tables already live in cross-project-reach.test.ts and
// chain-depth.test.ts; this file covers only what a stub cannot reach: the
// ext-handler seam (a real mutation in the TARGET project vs the
// existence-hidden 404), the audit row's project attribution, the depth
// snapshot written by a real launch, and the depth WALK across real
// domain_events → runs rows.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

// A real launch must not spawn a supervisor session — the run ROW is what this
// file asserts on.
vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();

  return {
    ...actual,
    tryStartRun: vi.fn(async () => ({ started: false, queuePosition: 1 })),
  };
});

// The cap is pinned so `depth >= cap` boundaries are deterministic regardless of
// the shipped default.
const CAP = 2;
const AGENT_ID = "aif:worker";
const SLUG_HOME = "xreach-home";
const SLUG_TARGET = "xreach-target";

type CommentsRoute =
  typeof import("@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/comments/route");
type TriageRoute =
  typeof import("@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/triage/route");
type TasksRoute = typeof import("@/app/api/v1/ext/projects/[slug]/tasks/route");

let commentsPOST: CommentsRoute["POST"];
let triagePOST: TriageRoute["POST"];
let tasksPOST: TasksRoute["POST"];
let launchAgentRun: typeof import("@/lib/agents/launch").launchAgentRun;
let resolveAgentChainDepth: typeof import("@/lib/agents/chain-depth").resolveAgentChainDepth;

let cacheRoot: string;
let originalCap: string | undefined;

const fx = {
  home: "",
  target: "",
  taskHome: "",
  taskTarget: "",
  callingRunId: "",
  token: "",
  tokenId: "",
};

function request(method: string, token: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/ext/test", {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
  });
}

function taskParams(slug: string, taskId: string) {
  return { params: Promise.resolve({ slug, taskId }) };
}

async function seedProject(slug: string, taskKey: string): Promise<string> {
  const id = randomUUID();

  await pool.query(
    `INSERT INTO "projects"
       ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix",
        "maister_yaml_path", "task_key", "next_task_number")
     VALUES ($1, $2, $2, $3, 'main', 'maister/', $4, $5, 1)`,
    [id, slug, `/tmp/${slug}`, `/tmp/${slug}/maister.yaml`, taskKey],
  );

  return id;
}

// One launchable agent shipped by one package, attached to BOTH projects: the
// reach grant is an attachment axis, so the target-side attachment is the row
// under test everywhere below.
async function seedAgentPackage(): Promise<void> {
  const installedPath = path.join(cacheRoot, `pkg-${randomUUID().slice(0, 8)}`);

  await mkdir(path.join(installedPath, "maister-agents"), { recursive: true });
  await writeFile(
    path.join(installedPath, "maister-agents", "worker.md"),
    `---
name: Worker
description: d
workspace: none
mode: session
triggers:
  - manual
  - domain_event
risk_tier: read_only
---
Do the work.
`,
    "utf8",
  );

  const packageInstallId = randomUUID();

  await pool.query(
    `INSERT INTO "package_installs"
       ("id", "source_url", "name", "version_label", "resolved_revision",
        "manifest", "manifest_digest", "installed_path", "package_status", "trust_status")
     VALUES ($1, 'github.com/acme/aif', 'aif', 'v1.0.0', 'rev-1',
             '{}'::jsonb, 'digest', $2, 'Installed', 'trusted')`,
    [packageInstallId, installedPath],
  );

  for (const projectId of [fx.home, fx.target]) {
    await pool.query(
      `INSERT INTO "project_package_attachments"
         ("id", "project_id", "package_install_id", "package_name")
       VALUES ($1, $2, $3, 'aif')`,
      [randomUUID(), projectId, packageInstallId],
    );
  }

  await pool.query(
    `INSERT INTO "agents"
       ("id", "package_name", "version_label", "origin", "name", "description",
        "workspace", "mode", "triggers", "risk_tier", "source_path", "enabled")
     VALUES ($1, 'aif', 'v1.0.0', 'git', 'Worker', 'd', 'none', 'session',
             '["manual","domain_event"]'::jsonb, 'read_only', $2, true)`,
    [AGENT_ID, path.join(installedPath, "maister-agents", "worker.md")],
  );
}

// The attachment IS the grant (D6), so every reach case is a different shape of
// this row — including its absence.
async function setLink(
  projectId: string,
  state: { enabled: boolean; reach: boolean } | null,
): Promise<void> {
  await pool.query(
    `DELETE FROM "agent_project_links" WHERE "agent_id" = $1 AND "project_id" = $2`,
    [AGENT_ID, projectId],
  );

  if (state === null) return;

  await pool.query(
    `INSERT INTO "agent_project_links"
       ("id", "agent_id", "project_id", "enabled", "cross_project_reach")
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), AGENT_ID, projectId, state.enabled, state.reach],
  );
}

async function seedAgentRun(projectId: string, depth: number): Promise<string> {
  const id = randomUUID();

  await pool.query(
    `INSERT INTO "runs"
       ("id", "run_kind", "agent_id", "trigger_source", "project_id",
        "flow_version", "flow_revision", "status", "agent_chain_depth")
     VALUES ($1, 'agent', $2, 'manual', $3, 'agent', 'manual', 'Running', $4)`,
    [id, AGENT_ID, projectId, depth],
  );

  return id;
}

async function setCallingDepth(depth: number): Promise<void> {
  await pool.query(
    `UPDATE "runs" SET "agent_chain_depth" = $1 WHERE "id" = $2`,
    [depth, fx.callingRunId],
  );
}

// An agent-authored event carrying its producing run — the exact row shape the
// D7 walk resolves a parent depth from.
async function insertAgentEvent(input: {
  kind: string;
  projectId: string;
  taskId: string | null;
  runId: string;
}): Promise<number> {
  const inserted = await pool.query(
    `INSERT INTO "domain_events"
       ("kind", "project_id", "task_id", "run_id", "actor_type", "actor_id",
        "payload", "occurred_at")
     VALUES ($1, $2, $3, $4, 'agent', $5, '{}'::jsonb, now())
     RETURNING "id"`,
    [input.kind, input.projectId, input.taskId, input.runId, AGENT_ID],
  );

  return Number(inserted.rows[0].id);
}

async function runDepth(runId: string): Promise<number> {
  const res = await pool.query(
    `SELECT "agent_chain_depth" FROM "runs" WHERE "id" = $1`,
    [runId],
  );

  return res.rows[0].agent_chain_depth as number;
}

async function commentCount(taskId: string): Promise<number> {
  const res = await pool.query(
    `SELECT count(*)::int AS n FROM "task_comments" WHERE "task_id" = $1`,
    [taskId],
  );

  return res.rows[0].n as number;
}

async function launchedRunId(input: {
  projectId: string;
  eventId?: number;
}): Promise<string> {
  const result = await launchAgentRun({
    agentId: AGENT_ID,
    projectId: input.projectId,
    trigger:
      input.eventId === undefined
        ? { source: "manual" }
        : { source: "domain_event", eventId: input.eventId },
    db,
  });

  if ("deduped" in result) {
    throw new Error(
      "unexpected trigger dedup — the fixture reused an event id",
    );
  }

  return result.runId;
}

beforeAll(async () => {
  cacheRoot = await mkdtemp(path.join(os.tmpdir(), "maister-xreach-cache-"));
  originalCap = process.env.MAISTER_MAX_AGENT_CHAIN_DEPTH;
  process.env.MAISTER_MAX_AGENT_CHAIN_DEPTH = String(CAP);

  testDatabase = await startMainPostgresTestDb({
    databaseName: "cross_project_reach_test",
  });

  pool = testDatabase.pool;
  db = testDatabase.db;
  // ADR-165: every launch places the run on the local execution host.
  await fakeExecutionHosts(db);

  fx.home = await seedProject(SLUG_HOME, "XRH");
  fx.target = await seedProject(SLUG_TARGET, "XRT");

  const runnerId = randomUUID();

  await (db as any)
    .insert((await import("@/lib/db/schema")).platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));
  await pool.query(
    `INSERT INTO "platform_runtime_settings" ("id", "default_runner_id")
     VALUES ('singleton', $1)
     ON CONFLICT (id) DO UPDATE SET "default_runner_id" = $1`,
    [runnerId],
  );

  await seedAgentPackage();
  await setLink(fx.home, { enabled: true, reach: false });

  ({ launchAgentRun } = await import("@/lib/agents/launch"));
  ({ resolveAgentChainDepth } = await import("@/lib/agents/chain-depth"));

  const { createTask } = await import("@/lib/services/tasks");

  fx.taskHome = (
    await createTask(
      { title: "home task", prompt: "p" },
      { projectId: fx.home, actorUserId: null },
      db,
    )
  ).taskId;
  fx.taskTarget = (
    await createTask(
      { title: "target task", prompt: "p" },
      { projectId: fx.target, actorUserId: null },
      db,
    )
  ).taskId;

  fx.callingRunId = await seedAgentRun(fx.home, 0);

  const { issueAgentRunToken } = await import("@/lib/agents/tokens");
  const issued = await issueAgentRunToken({
    agentId: AGENT_ID,
    projectId: fx.home,
    runId: fx.callingRunId,
    db,
  });

  fx.token = issued.secret;
  fx.tokenId = issued.tokenId;

  ({ POST: commentsPOST } = await import(
    "@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/comments/route"
  ));
  ({ POST: triagePOST } = await import(
    "@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/triage/route"
  ));
  ({ POST: tasksPOST } = await import(
    "@/app/api/v1/ext/projects/[slug]/tasks/route"
  ));
}, 240_000);

afterAll(async () => {
  await testDatabase?.stop();
  await rm(cacheRoot, { recursive: true, force: true });
  if (originalCap === undefined) {
    delete process.env.MAISTER_MAX_AGENT_CHAIN_DEPTH;
  } else {
    process.env.MAISTER_MAX_AGENT_CHAIN_DEPTH = originalCap;
  }
});

// Every case drives `POST .../comments` (scope `comments:create`, in the D6
// subset) with a token minted for the HOME project against a task in the TARGET
// project — the shortest end-to-end mutation across the reach seam.
describe("ADR-156 cross-project reach through the ext-handler seam", () => {
  it("lets a reach-granted agent token comment on the TARGET project's task", async () => {
    await setLink(fx.target, { enabled: true, reach: true });
    await setCallingDepth(0);

    const before = await commentCount(fx.taskTarget);
    const res = await commentsPOST(
      request("POST", fx.token, { body: "reached across" }),
      taskParams(SLUG_TARGET, fx.taskTarget),
    );

    expect(res.status).toBe(201);
    expect(await commentCount(fx.taskTarget)).toBe(before + 1);

    const authored = await pool.query(
      `SELECT "actor_type", "actor_id" FROM "task_comments"
       WHERE "task_id" = $1 ORDER BY "created_at" DESC LIMIT 1`,
      [fx.taskTarget],
    );

    // The mutation lands as the AGENT in the target project, not as a system row.
    expect(authored.rows[0]).toMatchObject({
      actor_type: "agent",
      actor_id: AGENT_ID,
    });
  });

  it("404s (never 403) when the target attachment carries no reach grant", async () => {
    await setLink(fx.target, { enabled: true, reach: false });
    await setCallingDepth(0);

    const before = await commentCount(fx.taskTarget);
    const res = await commentsPOST(
      request("POST", fx.token, { body: "reach off" }),
      taskParams(SLUG_TARGET, fx.taskTarget),
    );

    // Deny-by-default, and existence-hidden: a 403 would confirm the project
    // exists and let an agent enumerate the platform.
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
    expect(await commentCount(fx.taskTarget)).toBe(before);
  });

  it("404s when the target attachment is disabled despite the reach grant", async () => {
    await setLink(fx.target, { enabled: false, reach: true });
    await setCallingDepth(0);

    const res = await commentsPOST(
      request("POST", fx.token, { body: "link disabled" }),
      taskParams(SLUG_TARGET, fx.taskTarget),
    );

    expect(res.status).toBe(404);
  });

  it("404s when the agent has no attachment in the target project at all", async () => {
    await setLink(fx.target, null);
    await setCallingDepth(0);

    const res = await commentsPOST(
      request("POST", fx.token, { body: "no link" }),
      taskParams(SLUG_TARGET, fx.taskTarget),
    );

    expect(res.status).toBe(404);
  });

  it("404s when the calling run has already spent the chain budget", async () => {
    await setLink(fx.target, { enabled: true, reach: true });
    await setCallingDepth(CAP);

    const before = await commentCount(fx.taskTarget);
    const res = await commentsPOST(
      request("POST", fx.token, { body: "depth exhausted" }),
      taskParams(SLUG_TARGET, fx.taskTarget),
    );

    // Same grant that succeeded above — only runs.agent_chain_depth differs, so
    // this pins the budget arm and nothing else.
    expect(res.status).toBe(404);
    expect(await commentCount(fx.taskTarget)).toBe(before);
  });

  it("404s a scope OUTSIDE the subset even with a fully granted reach link", async () => {
    await setLink(fx.target, { enabled: true, reach: true });
    await setCallingDepth(0);

    // `tasks:triage` is granted to every agent token but deliberately excluded
    // from CROSS_PROJECT_AGENT_SCOPES. With the identical link state that let
    // `comments:create` through, the refusal can only come from the allow-list
    // being enforced at the seam.
    const res = await triagePOST(
      request("POST", fx.token, { flag: true }),
      taskParams(SLUG_TARGET, fx.taskTarget),
    );

    expect(res.status).toBe(404);

    const triaged = await pool.query(
      `SELECT "triage_status" FROM "tasks" WHERE "id" = $1`,
      [fx.taskTarget],
    );

    expect(triaged.rows[0].triage_status).not.toBe("flagged");
  });

  it("audits a granted cross-project call against the TARGET project as agent:<id>", async () => {
    await setLink(fx.target, { enabled: true, reach: true });
    await setCallingDepth(0);

    const before = await pool.query(
      `SELECT count(*)::int AS n FROM "token_audit_log"
       WHERE "token_id" = $1 AND "project_id" = $2 AND "result" = 'ok'`,
      [fx.tokenId, fx.target],
    );
    const res = await commentsPOST(
      request("POST", fx.token, { body: "audited" }),
      taskParams(SLUG_TARGET, fx.taskTarget),
    );

    expect(res.status).toBe(201);

    // The trail must show WHERE the agent acted (the target), under the agent's
    // own identity — not the token's home project, and not `token:<name>`.
    const after = await pool.query(
      `SELECT "actor_label" FROM "token_audit_log"
       WHERE "token_id" = $1 AND "project_id" = $2 AND "result" = 'ok'
       ORDER BY "created_at" DESC`,
      [fx.tokenId, fx.target],
    );

    expect(after.rows.length).toBe(before.rows[0].n + 1);
    expect(after.rows[0].actor_label).toBe(`agent:${AGENT_ID}`);
  });
});

describe("ADR-156 D7 runs.agent_chain_depth is snapshotted at launch", () => {
  it("seeds 0 on the run row for a manual launch — a fresh chain", async () => {
    await setLink(fx.home, { enabled: true, reach: false });

    const runId = await launchedRunId({ projectId: fx.home });

    expect(await runDepth(runId)).toBe(0);
  });
});

// Both arms of D7. The mechanism is one counter, but the paths differ: (a) the
// hop is a facade call into another project, (b) the hop never leaves the
// project. Half-A tested + half-B tested is not A∘B tested.
describe("ADR-156 D7 arm (a) — the cross-project chain", () => {
  it("carries the reaching run's depth onto the launch the target-side event triggers", async () => {
    await setLink(fx.target, { enabled: true, reach: true });
    await setCallingDepth(1);

    const res = await commentsPOST(
      request("POST", fx.token, { body: "hop into the target" }),
      taskParams(SLUG_TARGET, fx.taskTarget),
    );

    expect(res.status).toBe(201);

    // The event the reach produced lives in the TARGET project but is attributed
    // to the HOME run — that attribution is the whole basis of the walk.
    const event = await pool.query(
      `SELECT "id", "actor_type" FROM "domain_events"
       WHERE "kind" = 'task.comment_added' AND "project_id" = $1 AND "run_id" = $2
       ORDER BY "id" DESC LIMIT 1`,
      [fx.target, fx.callingRunId],
    );

    expect(event.rows[0].actor_type).toBe("agent");

    const triggered = await launchedRunId({
      projectId: fx.target,
      eventId: Number(event.rows[0].id),
    });

    expect(await runDepth(triggered)).toBe(2);
  });

  it("refuses the return hop once the target-side run is itself at the budget", async () => {
    const targetRun = await seedAgentRun(fx.target, CAP);
    const eventId = await insertAgentEvent({
      kind: "task.comment_added",
      projectId: fx.home,
      taskId: fx.taskHome,
      runId: targetRun,
    });

    const chain = await resolveAgentChainDepth({
      trigger: { source: "domain_event", eventId },
      db,
    });

    expect(chain).toEqual({ depth: CAP + 1, atCap: true });

    await setLink(fx.home, { enabled: true, reach: false });
    await expect(
      launchAgentRun({
        agentId: AGENT_ID,
        projectId: fx.home,
        trigger: { source: "domain_event", eventId },
        db,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });
});

describe("ADR-156 D7 arm (b) — the same-project chain tasks:create opened", () => {
  it("terminates an in-project agent→agent chain at the cap", async () => {
    await setLink(fx.home, { enabled: true, reach: false });

    const first = await seedAgentRun(fx.home, 1);
    const firstEvent = await insertAgentEvent({
      kind: "task.created",
      projectId: fx.home,
      taskId: fx.taskHome,
      runId: first,
    });
    // The launch SNAPSHOT is what the next walk reads, so this hop must go
    // through the real launch path, not a hand-written run row.
    const second = await launchedRunId({
      projectId: fx.home,
      eventId: firstEvent,
    });

    expect(await runDepth(second)).toBe(2);

    const secondEvent = await insertAgentEvent({
      kind: "task.created",
      projectId: fx.home,
      taskId: fx.taskHome,
      runId: second,
    });

    // Strictly increasing depth against a finite cap → the A↔B ping-pong that
    // self-exclusion cannot see runs out of budget instead of forever.
    await expect(
      resolveAgentChainDepth({
        trigger: { source: "domain_event", eventId: secondEvent },
        db,
      }),
    ).resolves.toEqual({ depth: 3, atCap: true });
  });

  it("stamps domain_events.run_id on an agent-authored task.comment_added", async () => {
    const res = await commentsPOST(
      request("POST", fx.token, { body: "same-project provenance" }),
      taskParams(SLUG_HOME, fx.taskHome),
    );

    expect(res.status).toBe(201);

    // Without this the walk above has nothing to resolve and every hop seeds 0 —
    // the fail-open that reopens the loop (T21a).
    const event = await pool.query(
      `SELECT "run_id", "actor_type" FROM "domain_events"
       WHERE "kind" = 'task.comment_added' AND "project_id" = $1
       ORDER BY "id" DESC LIMIT 1`,
      [fx.home],
    );

    expect(event.rows[0]).toMatchObject({
      run_id: fx.callingRunId,
      actor_type: "agent",
    });
  });

  it("stamps domain_events.run_id on a task created by an agent token", async () => {
    const res = await tasksPOST(
      request("POST", fx.token, { title: "agent-made", prompt: "p" }),
      { params: Promise.resolve({ slug: SLUG_HOME }) },
    );

    expect(res.status).toBe(201);

    const { taskId } = (await res.json()) as { taskId: string };
    const event = await pool.query(
      `SELECT "run_id", "actor_type", "actor_id" FROM "domain_events"
       WHERE "kind" = 'task.created' AND "task_id" = $1`,
      [taskId],
    );

    // BOTH halves of the provenance the chain walk needs. `actor_type` matters
    // as much as `run_id`: `createTask` used to derive its actor from a user id
    // alone, which an agent token does not have, so every agent-created task
    // emitted `actor_type='system'`. That silently disarmed the chain-depth cap
    // AND the trigger self-exclusion — the loop `tasks:create` opens was
    // unbounded. Both must hold for arm (b) to be closed end-to-end.
    expect(event.rows[0].run_id).toBe(fx.callingRunId);
    expect(event.rows[0].actor_type).toBe("agent");
    expect(event.rows[0].actor_id).toBe(AGENT_ID);
  });
});

// ADR-156 narrowing: the reach grant is justified by "an agent may remove the
// edge it CREATED". Without a self-authored constraint the same grant lets an
// outside agent drop ANY edge in the target project — and a dropped
// `blocks`/`requires` silently un-gates that project's launches. The constraint
// rides the DELETE's own WHERE, so a blocked delete is indistinguishable from
// "no such relation" (200 `removed:false`), keeping the existence-hidden shape.
describe("ADR-156 cross-project relations:delete is limited to self-authored edges", () => {
  // `task_relations_actor_pair_check` enforces `(actor_type='system') =
  // (actor_id is null)`, so a human-authored fixture edge needs a REAL user row.
  const rel = {
    targetB: "",
    targetBNumber: 0,
    homeB: "",
    homeBNumber: 0,
    humanId: "",
  };

  let relationsDELETE: typeof import("@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/relations/route").DELETE;

  async function taskNumber(taskId: string): Promise<number> {
    const r = await pool.query(`SELECT "number" FROM "tasks" WHERE "id" = $1`, [
      taskId,
    ]);

    return r.rows[0].number as number;
  }

  async function seedRelation(
    projectId: string,
    fromTaskId: string,
    toTaskId: string,
    kind: string,
    actorType: "agent" | "user",
    actorId: string | null,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO "task_relations"
         ("id", "project_id", "from_task_id", "kind", "to_task_id",
          "actor_type", "actor_id")
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [randomUUID(), projectId, fromTaskId, kind, toTaskId, actorType, actorId],
    );
  }

  async function relationExists(
    fromTaskId: string,
    kind: string,
  ): Promise<boolean> {
    const r = await pool.query(
      `SELECT 1 FROM "task_relations"
       WHERE "from_task_id" = $1 AND "kind" = $2`,
      [fromTaskId, kind],
    );

    return r.rows.length > 0;
  }

  beforeAll(async () => {
    const { createTask } = await import("@/lib/services/tasks");

    rel.humanId = randomUUID();
    await pool.query(
      `INSERT INTO "users" ("id", "email", "name", "role", "account_status")
       VALUES ($1, $2, 'Relation Author', 'member', 'active')`,
      [rel.humanId, `rel-${rel.humanId.slice(0, 8)}@example.test`],
    );

    rel.targetB = (
      await createTask(
        { title: "target B", prompt: "p" },
        { projectId: fx.target, actorUserId: null },
        db,
      )
    ).taskId;
    rel.homeB = (
      await createTask(
        { title: "home B", prompt: "p" },
        { projectId: fx.home, actorUserId: null },
        db,
      )
    ).taskId;
    rel.targetBNumber = await taskNumber(rel.targetB);
    rel.homeBNumber = await taskNumber(rel.homeB);

    ({ DELETE: relationsDELETE } = await import(
      "@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/relations/route"
    ));
  }, 60_000);

  it("lets the reaching agent delete an edge IT authored in the target project", async () => {
    await setLink(fx.target, { enabled: true, reach: true });
    await setCallingDepth(0);
    await seedRelation(
      fx.target,
      fx.taskTarget,
      rel.targetB,
      "blocks",
      "agent",
      AGENT_ID,
    );

    const res = await relationsDELETE(
      request("DELETE", fx.token, {
        kind: "blocks",
        toNumber: rel.targetBNumber,
      }),
      taskParams(SLUG_TARGET, fx.taskTarget),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ removed: true });
    expect(await relationExists(fx.taskTarget, "blocks")).toBe(false);
  });

  it("refuses to delete a HUMAN-authored edge, and leaves the row intact", async () => {
    await setLink(fx.target, { enabled: true, reach: true });
    await setCallingDepth(0);
    await seedRelation(
      fx.target,
      fx.taskTarget,
      rel.targetB,
      "requires",
      "user",
      rel.humanId,
    );

    const res = await relationsDELETE(
      request("DELETE", fx.token, {
        kind: "requires",
        toNumber: rel.targetBNumber,
      }),
      taskParams(SLUG_TARGET, fx.taskTarget),
    );

    // Existence-hidden: the same 200 `removed:false` a missing edge produces.
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ removed: false });
    // The gating edge survives — this is the un-gating the narrowing prevents.
    expect(await relationExists(fx.taskTarget, "requires")).toBe(true);
  });

  it("refuses an edge authored by a DIFFERENT agent", async () => {
    await setLink(fx.target, { enabled: true, reach: true });
    await setCallingDepth(0);
    await seedRelation(
      fx.target,
      fx.taskTarget,
      rel.targetB,
      "depends_on",
      "agent",
      "aif:someone-else",
    );

    const res = await relationsDELETE(
      request("DELETE", fx.token, {
        kind: "depends_on",
        toNumber: rel.targetBNumber,
      }),
      taskParams(SLUG_TARGET, fx.taskTarget),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ removed: false });
    expect(await relationExists(fx.taskTarget, "depends_on")).toBe(true);
  });

  // The narrowing must be REACH-specific. An agent acting in its OWN project
  // holds `manageTaskRelations` there and keeps the unrestricted behaviour —
  // over-restricting would be a silent capability regression for every
  // same-project agent.
  it("does NOT restrict a same-project agent token deleting a human-authored edge", async () => {
    await seedRelation(
      fx.home,
      fx.taskHome,
      rel.homeB,
      "requires",
      "user",
      rel.humanId,
    );

    const res = await relationsDELETE(
      request("DELETE", fx.token, {
        kind: "requires",
        toNumber: rel.homeBNumber,
      }),
      taskParams(SLUG_HOME, fx.taskHome),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ removed: true });
    expect(await relationExists(fx.taskHome, "requires")).toBe(false);
  });
});
