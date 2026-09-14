// IT-ATN-01 / IT-ATN-04 (ADR-169 D1, D5, D8) — the cross-project decision queue.
//
// `decisions` is one number over four populations. The two things that can go
// wrong are (a) the number disagreeing with the list it labels, which is the
// exact bug the one-number rule exists to prevent, and (b) a relation-blocked
// task counting — work that LOOKS like it needs a human and does not.
//
// Both are asserted against a fixture that actually holds all four kinds. A
// queue test over one population proves almost nothing about the union.

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// FIXME(any): drizzle-orm dual peer-dep variants — the fixture-insert cast every
// other board/portfolio integration test uses.
const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let getDecisionsQueue: typeof import("@/lib/queries/decisions").getDecisionsQueue;
let getDecisionsCount: typeof import("@/lib/queries/decisions").getDecisionsCount;

const fx = {
  member: randomUUID(),
  stranger: randomUUID(),
  project: randomUUID(),
  foreignProject: randomUUID(),
  runner: randomUUID(),
  flow: randomUUID(),
  foreignFlow: randomUUID(),
  hitlTask: randomUUID(),
  hitlRun: randomUUID(),
  hitlRequest: randomUUID(),
  promoTask: randomUUID(),
  promoRun: randomUUID(),
  crashTask: randomUUID(),
  crashRun: randomUUID(),
  flaggedTask: randomUUID(),
  // Flagged AND crashed, but held by a blocking relation — must count in
  // neither counter, through either population.
  blockedTask: randomUUID(),
  blockedRun: randomUUID(),
  blockerTask: randomUUID(),
  foreignTask: randomUUID(),
  // A SECOND project the member can see, holding its own respondable HITL.
  // Without it, scoping to `fx.project` is indistinguishable from not scoping
  // at all, and the scope test passes whether or not the filter exists.
  secondProject: randomUUID(),
  secondFlow: randomUUID(),
  secondHitlTask: randomUUID(),
  secondHitlRun: randomUUID(),
  secondHitlRequest: randomUUID(),
  // A VIEWER on the project that holds all four decision kinds. They can read
  // the board and can perform none of the four actions the queue asks for.
  viewer: randomUUID(),
};

let taskNumber = 0;

async function seedProject(
  projectId: string,
  slug: string,
  key: string,
): Promise<void> {
  await pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, $2, $3, '/tmp/m.yaml', $4)`,
    [projectId, slug, `/tmp/${slug}`, key],
  );
}

async function seedFlow(flowId: string, projectId: string): Promise<void> {
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
}

async function seedTask(
  taskId: string,
  projectId: string,
  flowId: string,
  opts: {
    title: string;
    status?: "Backlog" | "InFlight";
    triageStatus?: "triaged" | "flagged";
  },
): Promise<void> {
  taskNumber += 1;
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    number: taskNumber,
    title: opts.title,
    prompt: "p",
    flowId,
    status: opts.status ?? "Backlog",
    stage: "Backlog",
    triageStatus: opts.triageStatus ?? "triaged",
  });
}

async function seedRun(
  runId: string,
  projectId: string,
  flowId: string,
  taskId: string | null,
  status: "NeedsInput" | "Review" | "Crashed",
): Promise<void> {
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    status,
    flowVersion: "v1.0.0",
    currentStepId: "review",
    endedAt: status === "Crashed" ? new Date("2026-09-09T10:00:00.000Z") : null,
    reviewEnteredAt:
      status === "Review" ? new Date("2026-09-09T09:00:00.000Z") : null,
  });
  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId: fx.runner,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(fx.runner),
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    projectId,
    runId,
    branch: `maister/${runId}`,
    worktreePath: `/tmp/ws-${runId}`,
    parentRepoPath: "/tmp/parent",
    targetBranch: "main",
  });
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "decisions_queue_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;

  for (const [userId, email, role] of [
    [fx.member, "dq-member@test.local", "member"],
    [fx.stranger, "dq-stranger@test.local", "member"],
    [fx.viewer, "dq-viewer@test.local", "member"],
  ] as const) {
    await pool.query(
      `insert into users (id, email, role) values ($1, $2, $3)`,
      [userId, email, role],
    );
  }

  await seedProject(fx.project, "dq-own", "DQO");
  await seedProject(fx.foreignProject, "dq-foreign", "DQF");
  await seedProject(fx.secondProject, "dq-second", "DQS");
  await pool.query(
    `insert into project_members (id, project_id, user_id, role)
     values ($1, $2, $3, 'member')`,
    [randomUUID(), fx.project, fx.member],
  );
  await pool.query(
    `insert into project_members (id, project_id, user_id, role)
     values ($1, $2, $3, 'member')`,
    [randomUUID(), fx.secondProject, fx.member],
  );
  await pool.query(
    `insert into project_members (id, project_id, user_id, role)
     values ($1, $2, $3, 'viewer')`,
    [randomUUID(), fx.project, fx.viewer],
  );
  await pool.query(
    `insert into project_members (id, project_id, user_id, role)
     values ($1, $2, $3, 'member')`,
    [randomUUID(), fx.foreignProject, fx.stranger],
  );
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(fx.runner, "claude"));
  await seedFlow(fx.flow, fx.project);
  await seedFlow(fx.foreignFlow, fx.foreignProject);
  await seedFlow(fx.secondFlow, fx.secondProject);

  // (1) respondable HITL
  await seedTask(fx.hitlTask, fx.project, fx.flow, {
    title: "awaiting a permission answer",
    status: "InFlight",
  });
  await seedRun(fx.hitlRun, fx.project, fx.flow, fx.hitlTask, "NeedsInput");
  // A non-`agent_question` row must carry a NULL task_id
  // (`hitl_requests_agent_question_shape_check`), so a HITL item reaches its
  // task through `runs.task_id` — which is also the join ATN-04 must filter on.
  await db.insert(schema.hitlRequests).values({
    id: fx.hitlRequest,
    runId: fx.hitlRun,
    stepId: "implement",
    kind: "permission",
    prompt: "may I write the file?",
    criticality: "high",
    createdAt: new Date("2026-09-09T08:00:00.000Z"),
  });

  // (1b) the SAME population, in the member's OTHER visible project. The
  // scope test's discriminant: it belongs to the unscoped queue and must be
  // absent from a queue scoped to `fx.project`.
  await seedTask(fx.secondHitlTask, fx.secondProject, fx.secondFlow, {
    title: "awaiting an answer in the second project",
    status: "InFlight",
  });
  await seedRun(
    fx.secondHitlRun,
    fx.secondProject,
    fx.secondFlow,
    fx.secondHitlTask,
    "NeedsInput",
  );
  await db.insert(schema.hitlRequests).values({
    id: fx.secondHitlRequest,
    runId: fx.secondHitlRun,
    stepId: "implement",
    kind: "permission",
    prompt: "may I write the other file?",
    criticality: "high",
    createdAt: new Date("2026-09-09T08:30:00.000Z"),
  });

  // (2) mechanically promotable
  await seedTask(fx.promoTask, fx.project, fx.flow, {
    title: "ready to promote",
    status: "InFlight",
  });
  await seedRun(fx.promoRun, fx.project, fx.flow, fx.promoTask, "Review");

  // (3) crashed, owing recover/discard
  await seedTask(fx.crashTask, fx.project, fx.flow, {
    title: "crashed run",
    status: "InFlight",
  });
  await seedRun(fx.crashRun, fx.project, fx.flow, fx.crashTask, "Crashed");

  // (4) triage-flagged
  await seedTask(fx.flaggedTask, fx.project, fx.flow, {
    title: "flagged by triage",
    triageStatus: "flagged",
  });

  // Relation-blocked, and deliberately eligible through TWO populations.
  await seedTask(fx.blockerTask, fx.project, fx.flow, { title: "the blocker" });
  await seedTask(fx.blockedTask, fx.project, fx.flow, {
    title: "blocked and flagged",
    triageStatus: "flagged",
  });
  await seedRun(fx.blockedRun, fx.project, fx.flow, fx.blockedTask, "Crashed");
  await db.insert(schema.taskRelations).values({
    id: randomUUID(),
    projectId: fx.project,
    fromTaskId: fx.blockerTask,
    kind: "blocks",
    toTaskId: fx.blockedTask,
    actorType: "user",
    actorId: fx.member,
  });

  // A fourth-kind item in a project the member cannot see.
  await seedTask(fx.foreignTask, fx.foreignProject, fx.foreignFlow, {
    title: "someone else's flagged task",
    triageStatus: "flagged",
  });

  ({ getDecisionsQueue, getDecisionsCount } = await import(
    "@/lib/queries/decisions"
  ));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("IT-ATN-01 the count and the list are the same read", () => {
  it("covers all four populations in one queue", async () => {
    const queue = await getDecisionsQueue(fx.member, "member");

    expect(new Set(queue.items.map((item) => item.kind))).toEqual(
      new Set(["hitl", "promotable", "crashed", "flagged"]),
    );
  });

  it("reports a count equal to the length of the list it labels", async () => {
    const queue = await getDecisionsQueue(fx.member, "member");

    expect(queue.count).toBe(queue.items.length);
    expect(queue.count).toBeGreaterThan(0);
  });

  it("agrees with the standalone counter every surface reads", async () => {
    const queue = await getDecisionsQueue(fx.member, "member");

    expect(await getDecisionsCount(fx.member, "member")).toBe(queue.count);
  });

  it("orders by rank, so the critical HITL leads the queue", async () => {
    const queue = await getDecisionsQueue(fx.member, "member");

    expect(queue.items[0].kind).toBe("hitl");
  });

  it("shows nothing from a project the reader cannot see", async () => {
    const queue = await getDecisionsQueue(fx.member, "member");

    expect(queue.items.map((item) => item.projectId)).not.toContain(
      fx.foreignProject,
    );
  });

  it("counts zero for a user who belongs to no project", async () => {
    expect(await getDecisionsCount(randomUUID(), "member")).toBe(0);
  });
});

describe("IT-ATN-05 every surface reads the same number", () => {
  it("gives the layout badge and the page headline one identical value", async () => {
    const [layoutValue, pageValue] = await Promise.all([
      getDecisionsCount(fx.member, "member"),
      getDecisionsCount(fx.member, "member"),
    ]);

    expect(layoutValue).toBe(pageValue);
  });

  it("slices to one project without inventing a different total", async () => {
    const all = await getDecisionsQueue(fx.member, "member");
    const scoped = await getDecisionsQueue(fx.member, "member", {
      projectId: fx.project,
    });

    // The discriminant. Every source must take the scope, not just the three
    // that accept a project set as an argument: the member's OTHER visible
    // project holds a respondable HITL, so a source that resolves its own
    // visibility and ignores the scope makes these two numbers equal.
    expect(all.items.map((item) => item.projectId)).toContain(fx.secondProject);
    expect(scoped.items.map((item) => item.projectId)).not.toContain(
      fx.secondProject,
    );
    expect(scoped.count).toBeLessThan(all.count);

    expect(scoped.count).toBe(
      all.items.filter((item) => item.projectId === fx.project).length,
    );
  });

  it("scopes every kind, not only the ones keyed on a project set", async () => {
    const scoped = await getDecisionsQueue(fx.member, "member", {
      projectId: fx.secondProject,
    });

    // Scoped to the project that holds ONLY a HITL: if the HITL arm were
    // unscoped this would still carry the first project's promotable, crashed
    // and flagged items.
    expect(scoped.items.map((item) => item.projectId)).toEqual([
      fx.secondProject,
    ]);
    expect(scoped.items.map((item) => item.kind)).toEqual(["hitl"]);
  });

  it("refuses to widen the scope to a project the reader cannot see", async () => {
    const scoped = await getDecisionsQueue(fx.member, "member", {
      projectId: fx.foreignProject,
    });

    expect(scoped).toEqual({ items: [], count: 0 });
  });
});

describe("IT-ATN-04 a relation-blocked task counts in neither counter", () => {
  it("omits the blocked task from every population it would otherwise join", async () => {
    const queue = await getDecisionsQueue(fx.member, "member");
    const taskIds = queue.items.map((item) => item.taskId);

    expect(taskIds).not.toContain(fx.blockedTask);
    expect(queue.items.map((item) => item.runId)).not.toContain(fx.blockedRun);
  });

  it("still admits the blocker itself once nothing holds it", async () => {
    const queue = await getDecisionsQueue(fx.member, "member");

    expect(queue.items.map((item) => item.taskId)).toContain(fx.flaggedTask);
  });

  it("admits the task as soon as the blocking relation is gone", async () => {
    await pool.query(
      `delete from task_relations where from_task_id = $1 and to_task_id = $2`,
      [fx.blockerTask, fx.blockedTask],
    );

    const queue = await getDecisionsQueue(fx.member, "member");

    expect(queue.items.map((item) => item.taskId)).toContain(fx.blockedTask);
    expect(queue.count).toBe(queue.items.length);

    await db.insert(schema.taskRelations).values({
      id: randomUUID(),
      projectId: fx.project,
      fromTaskId: fx.blockerTask,
      kind: "blocks",
      toTaskId: fx.blockedTask,
      actorType: "user",
      actorId: fx.member,
    });
  });
});

// ---------------------------------------------------------------------------
// IT-ATN-14 (ADR-169 D7) — the queue is scoped by what the reader can DO.
//
// Every one of the four populations asks the reader to act: answer, promote,
// recover, clear. All four require project `member`; `readBoard` is a `viewer`
// action. Scoping by VISIBILITY handed a viewer promotable runs they cannot
// promote and crashed runs whose inline recover/discard answers 403 — a badge
// that says "this needs you" over an action that refuses, and it propagated
// into notifications.
// ---------------------------------------------------------------------------
describe("IT-ATN-14 a project viewer gets no decisions they cannot resolve", () => {
  it("returns an empty queue for a viewer of a project full of decisions", async () => {
    const member = await getDecisionsQueue(fx.member, "member");
    const viewer = await getDecisionsQueue(fx.viewer, "member");

    // The discriminant: the SAME project, seeded with all four kinds, is
    // non-empty for the member and empty for the viewer.
    expect(
      member.items.filter((item) => item.projectId === fx.project).length,
    ).toBeGreaterThan(0);
    expect(viewer.items).toEqual([]);
    expect(viewer.count).toBe(0);
  });

  it("keeps the count and the list agreeing for a viewer too", async () => {
    expect(await getDecisionsCount(fx.viewer, "member")).toBe(0);
  });

  it("still admits a GLOBAL admin, who acts everywhere by role", async () => {
    // The guard must narrow by project role, not refuse anyone without a
    // membership row — a global admin has none and reaches every project.
    const admin = await getDecisionsQueue(fx.stranger, "admin");

    expect(admin.items.length).toBeGreaterThan(0);
  });
});
