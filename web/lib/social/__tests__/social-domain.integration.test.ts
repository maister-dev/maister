// ADR-083 social-board domain semantics against real Postgres: numbering
// allocation (incl. concurrency), relations validation/idempotency/blockers,
// and the single-transaction comment pipeline (activity, subscriptions
// first-wins, inbox fanout excluding the actor, D8 mention rule).
//
// Consolidates the plan's T3.1 numbering, T3.4 relations, and T3.6 comment
// suites into one container for speed; T4.1's route tests cover authz/HTTP.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// FIXME(any): dual drizzle-orm peer-dep variants (matches schema.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";
import { createTask } from "@/lib/services/tasks";
import { addTaskComment, listTaskComments } from "@/lib/social/comments";
import {
  addTaskRelation,
  getOpenRelationBlockers,
  getTaskRelations,
  removeTaskRelation,
} from "@/lib/social/relations";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

function newId(): string {
  return randomUUID();
}

async function seedUser(): Promise<string> {
  const id = newId();

  await db.insert(schema.users).values({
    id,
    email: `social-${id.slice(0, 8)}@example.test`,
    role: "member",
    accountStatus: "active",
  });

  return id;
}

async function seedProject(taskKey: string): Promise<{
  projectId: string;
  flowId: string;
  slug: string;
}> {
  const projectId = newId();
  const flowId = newId();
  const slug = `social-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: `Social ${taskKey}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
    taskKey,
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

  return { projectId, flowId, slug };
}

async function rowsOf(table: string, where: string): Promise<any[]> {
  const result = await pool.query(`select * from ${table} where ${where}`);

  return result.rows;
}

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

describe("createTask numbering (ADR-078 D1)", () => {
  it("allocates sequential numbers and returns the task key", async () => {
    const { projectId, flowId } = await seedProject("SEQ");
    const creator = await seedUser();

    const first = await createTask(
      { title: "first", prompt: "p", flowId },
      { projectId, actorUserId: creator },
      db,
    );
    const second = await createTask(
      { title: "second", prompt: "p", flowId },
      { projectId, actorUserId: creator },
      db,
    );

    expect(first).toMatchObject({ number: 1, taskKey: "SEQ" });
    expect(second).toMatchObject({ number: 2, taskKey: "SEQ" });

    const project = await rowsOf("projects", `id = '${projectId}'`);

    expect(project[0].next_task_number).toBe(3);
  });

  it("allocates N distinct sequential numbers under concurrency — zero 23505", async () => {
    const { projectId, flowId } = await seedProject("PAR");
    const creator = await seedUser();

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createTask(
          { title: `parallel ${i}`, prompt: "p", flowId },
          { projectId, actorUserId: creator },
          db,
        ),
      ),
    );

    const numbers = results.map((r) => r.number).sort((a, b) => a - b);

    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("writes task_created activity and the creator subscription in the same operation", async () => {
    const { projectId, flowId } = await seedProject("ACT");
    const creator = await seedUser();

    const { taskId } = await createTask(
      { title: "with activity", prompt: "p", flowId },
      { projectId, actorUserId: creator },
      db,
    );

    const activity = await rowsOf(
      "task_activity",
      `task_id = '${taskId}' and event_kind = 'task_created'`,
    );

    expect(activity).toHaveLength(1);
    expect(activity[0].actor_type).toBe("user");
    expect(activity[0].actor_id).toBe(creator);

    const subs = await rowsOf("task_subscribers", `task_id = '${taskId}'`);

    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      subscriber_type: "user",
      subscriber_id: creator,
      reason: "creator",
    });
  });

  it("records a system actor and no subscription for creator-less automation", async () => {
    const { projectId, flowId } = await seedProject("SYS");

    const { taskId } = await createTask(
      { title: "automation", prompt: "p", flowId },
      { projectId, actorUserId: null },
      db,
    );

    const activity = await rowsOf(
      "task_activity",
      `task_id = '${taskId}' and event_kind = 'task_created'`,
    );

    expect(activity[0].actor_type).toBe("system");
    expect(activity[0].actor_id).toBeNull();

    const subs = await rowsOf("task_subscribers", `task_id = '${taskId}'`);

    expect(subs).toHaveLength(0);
  });

  it("rejects createTask against a missing project with PRECONDITION", async () => {
    const { flowId, projectId } = await seedProject("GONE");

    // Flow validation passes for the real project; then point at a ghost.
    await expect(
      createTask(
        { title: "ghost", prompt: "p", flowId },
        { projectId: newId(), actorUserId: null },
        db,
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    // Same project, flow from elsewhere → CONFIG too.
    const other = await seedProject("GONE2");

    await expect(
      createTask(
        { title: "wrong flow", prompt: "p", flowId: other.flowId },
        { projectId, actorUserId: null },
        db,
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });
});

describe("task relations (ADR-078 D4/D5)", () => {
  async function seedPair(taskKey: string) {
    const { projectId, flowId, slug } = await seedProject(taskKey);
    const creator = await seedUser();
    const a = await createTask(
      { title: "task A", prompt: "p", flowId },
      { projectId, actorUserId: creator },
      db,
    );
    const b = await createTask(
      { title: "task B", prompt: "p", flowId },
      { projectId, actorUserId: creator },
      db,
    );

    return { projectId, flowId, slug, creator, a, b };
  }

  const userActor = (id: string) => ({ type: "user" as const, id });

  it("adds a relation with relation_added activity carrying KEY-N refs", async () => {
    const { projectId, creator, a, b } = await seedPair("REL");

    const result = await addTaskRelation(
      {
        projectId,
        fromTaskId: a.taskId,
        kind: "blocks",
        toTaskId: b.taskId,
        actor: userActor(creator),
      },
      db,
    );

    expect(result.created).toBe(true);

    const activity = await rowsOf(
      "task_activity",
      `task_id = '${a.taskId}' and event_kind = 'relation_added'`,
    );

    expect(activity).toHaveLength(1);
    expect(activity[0].payload).toMatchObject({
      kind: "blocks",
      fromRef: "REL-1",
      toRef: "REL-2",
    });
  });

  it("duplicate add is an idempotent no-op without a second activity row", async () => {
    const { projectId, creator, a, b } = await seedPair("DUP");
    const input = {
      projectId,
      fromTaskId: a.taskId,
      kind: "blocks" as const,
      toTaskId: b.taskId,
      actor: userActor(creator),
    };

    expect((await addTaskRelation(input, db)).created).toBe(true);
    expect((await addTaskRelation(input, db)).created).toBe(false);

    const activity = await rowsOf(
      "task_activity",
      `task_id = '${a.taskId}' and event_kind = 'relation_added'`,
    );

    expect(activity).toHaveLength(1);
  });

  it("rejects self-relations and cross-project relations with CONFIG", async () => {
    const first = await seedPair("XPA");
    const second = await seedPair("XPB");

    await expect(
      addTaskRelation(
        {
          projectId: first.projectId,
          fromTaskId: first.a.taskId,
          kind: "blocks",
          toTaskId: first.a.taskId,
          actor: userActor(first.creator),
        },
        db,
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    await expect(
      addTaskRelation(
        {
          projectId: first.projectId,
          fromTaskId: first.a.taskId,
          kind: "blocks",
          toTaskId: second.a.taskId,
          actor: userActor(first.creator),
        },
        db,
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });

  it("rejects a missing counterpart with PRECONDITION", async () => {
    const { projectId, creator, a } = await seedPair("MIS");

    await expect(
      addTaskRelation(
        {
          projectId,
          fromTaskId: a.taskId,
          kind: "blocks",
          toTaskId: newId(),
          actor: userActor(creator),
        },
        db,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("remove deletes the row, writes relation_removed, and is idempotent", async () => {
    const { projectId, creator, a, b } = await seedPair("REM");
    const input = {
      projectId,
      fromTaskId: a.taskId,
      kind: "blocks" as const,
      toTaskId: b.taskId,
      actor: userActor(creator),
    };

    await addTaskRelation(input, db);
    expect((await removeTaskRelation(input, db)).removed).toBe(true);
    expect((await removeTaskRelation(input, db)).removed).toBe(false);

    const removedActivity = await rowsOf(
      "task_activity",
      `task_id = '${a.taskId}' and event_kind = 'relation_removed'`,
    );

    expect(removedActivity).toHaveLength(1);
  });

  it("computes open blockers per the D5 predicate (Done AND Abandoned release)", async () => {
    const { projectId, creator, a, b } = await seedPair("BLK");

    // A blocks B → B is blocked while A is Backlog/InFlight.
    await addTaskRelation(
      {
        projectId,
        fromTaskId: a.taskId,
        kind: "blocks",
        toTaskId: b.taskId,
        actor: userActor(creator),
      },
      db,
    );

    let blockers = await getOpenRelationBlockers([b.taskId], db);

    expect(blockers.get(b.taskId)).toEqual([
      { taskId: a.taskId, key: "BLK", number: 1 },
    ]);

    // Done releases.
    await db
      .update(schema.tasks)
      .set({ status: "Done" })
      .where(eq(schema.tasks.id, a.taskId));
    blockers = await getOpenRelationBlockers([b.taskId], db);
    expect(blockers.get(b.taskId)).toBeUndefined();

    // Abandoned releases too — a discarded blocker must not deadlock.
    await db
      .update(schema.tasks)
      .set({ status: "Abandoned" })
      .where(eq(schema.tasks.id, a.taskId));
    blockers = await getOpenRelationBlockers([b.taskId], db);
    expect(blockers.get(b.taskId)).toBeUndefined();
  });

  it("depends_on gates the from-end; parent_of never gates", async () => {
    const { projectId, flowId, creator, a, b } = await seedPair("DEP");
    const c = await createTask(
      { title: "task C", prompt: "p", flowId },
      { projectId, actorUserId: creator },
      db,
    );

    await addTaskRelation(
      {
        projectId,
        fromTaskId: a.taskId,
        kind: "depends_on",
        toTaskId: b.taskId,
        actor: userActor(creator),
      },
      db,
    );
    await addTaskRelation(
      {
        projectId,
        fromTaskId: a.taskId,
        kind: "parent_of",
        toTaskId: c.taskId,
        actor: userActor(creator),
      },
      db,
    );

    const blockers = await getOpenRelationBlockers(
      [a.taskId, b.taskId, c.taskId],
      db,
    );

    // A depends_on B (B open) blocks A; parent_of never blocks anyone.
    expect(blockers.get(a.taskId)).toEqual([
      { taskId: b.taskId, key: "DEP", number: 2 },
    ]);
    expect(blockers.get(b.taskId)).toBeUndefined();
    expect(blockers.get(c.taskId)).toBeUndefined();
  });

  it("getTaskRelations returns both directions with the counterpart ref", async () => {
    const { projectId, creator, a, b } = await seedPair("DIR");

    await addTaskRelation(
      {
        projectId,
        fromTaskId: a.taskId,
        kind: "blocks",
        toTaskId: b.taskId,
        actor: userActor(creator),
      },
      db,
    );

    const ofA = await getTaskRelations(a.taskId, db);
    const ofB = await getTaskRelations(b.taskId, db);

    expect(ofA).toHaveLength(1);
    expect(ofA[0]).toMatchObject({
      direction: "out",
      kind: "blocks",
      other: { taskId: b.taskId, key: "DIR", number: 2, title: "task B" },
    });
    expect(ofB).toHaveLength(1);
    expect(ofB[0]).toMatchObject({
      direction: "in",
      kind: "blocks",
      other: { taskId: a.taskId, key: "DIR", number: 1 },
    });
  });
});

describe("comment pipeline (ADR-078 D6/D7/D8/D9)", () => {
  it("stores the body with resolvable mentions expanded; unresolved stay literal", async () => {
    const { projectId, flowId, slug } = await seedProject("EXP");
    const creator = await seedUser();
    const a = await createTask(
      { title: "commented", prompt: "p", flowId },
      { projectId, actorUserId: creator },
      db,
    );
    const b = await createTask(
      { title: "mentioned", prompt: "p", flowId },
      { projectId, actorUserId: creator },
      db,
    );

    const comment = await addTaskComment(
      {
        taskId: a.taskId,
        body: `depends on EXP-${b.number} and GHOST-99 but not \`EXP-${b.number}\``,
        actor: { type: "user", id: creator },
      },
      db,
    );

    expect(comment.body).toBe(
      `depends on [EXP-2](/projects/${slug}/tasks/2) and GHOST-99 but not \`EXP-2\``,
    );
  });

  it("writes comment_added on the task and task_mentioned on each mentioned task", async () => {
    const { projectId, flowId } = await seedProject("EVT");
    const creator = await seedUser();
    const a = await createTask(
      { title: "A", prompt: "p", flowId },
      { projectId, actorUserId: creator },
      db,
    );
    const b = await createTask(
      { title: "B", prompt: "p", flowId },
      { projectId, actorUserId: creator },
      db,
    );

    const comment = await addTaskComment(
      {
        taskId: a.taskId,
        body: `see EVT-${b.number}`,
        actor: { type: "user", id: creator },
      },
      db,
    );

    const added = await rowsOf(
      "task_activity",
      `task_id = '${a.taskId}' and event_kind = 'comment_added'`,
    );

    expect(added).toHaveLength(1);
    expect(added[0].payload).toMatchObject({ commentId: comment.id });

    const mentioned = await rowsOf(
      "task_activity",
      `task_id = '${b.taskId}' and event_kind = 'task_mentioned'`,
    );

    expect(mentioned).toHaveLength(1);
    expect(mentioned[0].payload).toMatchObject({
      fromTaskId: a.taskId,
      fromKey: "EVT-1",
      commentId: comment.id,
    });
  });

  it("auto-subscribes commenter (first reason wins) and the mentioned task's creator (D8)", async () => {
    const { projectId, flowId } = await seedProject("SUB");
    const creatorA = await seedUser();
    const creatorB = await seedUser();
    const commenter = await seedUser();
    const a = await createTask(
      { title: "A", prompt: "p", flowId },
      { projectId, actorUserId: creatorA },
      db,
    );
    const b = await createTask(
      { title: "B", prompt: "p", flowId },
      { projectId, actorUserId: creatorB },
      db,
    );

    await addTaskComment(
      {
        taskId: a.taskId,
        body: `cc SUB-${b.number}`,
        actor: { type: "user", id: commenter },
      },
      db,
    );

    const subs = await rowsOf(
      "task_subscribers",
      `task_id = '${a.taskId}' order by created_at, id`,
    );
    const byId = new Map(subs.map((s) => [s.subscriber_id, s.reason]));

    expect(byId.get(creatorA)).toBe("creator");
    expect(byId.get(commenter)).toBe("commenter");
    // D8 mention rule: B's creator joins task A's audience.
    expect(byId.get(creatorB)).toBe("mentioned");

    // First reason wins: the creator commenting later keeps reason=creator.
    await addTaskComment(
      {
        taskId: a.taskId,
        body: "follow-up",
        actor: { type: "user", id: creatorA },
      },
      db,
    );
    const after = await rowsOf(
      "task_subscribers",
      `task_id = '${a.taskId}' and subscriber_id = '${creatorA}'`,
    );

    expect(after).toHaveLength(1);
    expect(after[0].reason).toBe("creator");
  });

  it("fans out to subscribers excluding the actor, with source_ref", async () => {
    const { projectId, flowId } = await seedProject("FAN");
    const creator = await seedUser();
    const watcher1 = await seedUser();
    const watcher2 = await seedUser();
    const a = await createTask(
      { title: "A", prompt: "p", flowId },
      { projectId, actorUserId: creator },
      db,
    );

    // Manual watchers join the audience.
    for (const watcher of [watcher1, watcher2]) {
      await db.insert(schema.taskSubscribers).values({
        id: newId(),
        taskId: a.taskId,
        subscriberType: "user",
        subscriberId: watcher,
        reason: "manual",
      });
    }

    const comment = await addTaskComment(
      {
        taskId: a.taskId,
        body: "ping",
        actor: { type: "user", id: creator },
      },
      db,
    );

    const items = await rowsOf(
      "inbox_items",
      `task_id = '${a.taskId}' and event_kind = 'comment_added'`,
    );

    // creator (actor) excluded; both watchers notified.
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.recipient_id))).toEqual(
      new Set([watcher1, watcher2]),
    );
    for (const item of items) {
      expect(item.recipient_type).toBe("user");
      expect(item.read_at).toBeNull();
      expect(item.source_ref).toMatchObject({
        kind: "comment",
        taskId: a.taskId,
        commentId: comment.id,
      });
    }
  });

  it("fans task_mentioned out to the MENTIONED task's subscribers", async () => {
    const { projectId, flowId } = await seedProject("MFN");
    const creatorA = await seedUser();
    const creatorB = await seedUser();
    const a = await createTask(
      { title: "A", prompt: "p", flowId },
      { projectId, actorUserId: creatorA },
      db,
    );
    const b = await createTask(
      { title: "B", prompt: "p", flowId },
      { projectId, actorUserId: creatorB },
      db,
    );

    await addTaskComment(
      {
        taskId: a.taskId,
        body: `relates to MFN-${b.number}`,
        actor: { type: "user", id: creatorA },
      },
      db,
    );

    const items = await rowsOf(
      "inbox_items",
      `task_id = '${b.taskId}' and event_kind = 'task_mentioned'`,
    );

    // B's audience is its creator; the actor (creatorA) is excluded anyway.
    expect(items).toHaveLength(1);
    expect(items[0].recipient_id).toBe(creatorB);
    expect(items[0].source_ref).toMatchObject({
      kind: "mention",
      taskId: b.taskId,
    });
  });

  it("system actors comment without subscribing; fanout reaches every subscriber", async () => {
    const { projectId, flowId } = await seedProject("SYC");
    const creator = await seedUser();
    const a = await createTask(
      { title: "A", prompt: "p", flowId },
      { projectId, actorUserId: creator },
      db,
    );

    const comment = await addTaskComment(
      {
        taskId: a.taskId,
        body: "automated note",
        actor: { type: "system", id: null },
        activityPayloadExtra: { via: "ext", tokenId: "tok-1" },
      },
      db,
    );

    expect(comment.actorType).toBe("system");
    expect(comment.actorId).toBeNull();

    const added = await rowsOf(
      "task_activity",
      `task_id = '${a.taskId}' and event_kind = 'comment_added'`,
    );

    expect(added[0].payload).toMatchObject({ via: "ext", tokenId: "tok-1" });

    const subs = await rowsOf(
      "task_subscribers",
      `task_id = '${a.taskId}' and reason = 'commenter'`,
    );

    expect(subs).toHaveLength(0);

    const items = await rowsOf(
      "inbox_items",
      `task_id = '${a.taskId}' and event_kind = 'comment_added'`,
    );

    // The creator subscriber is notified; the system actor matches nobody.
    expect(items).toHaveLength(1);
    expect(items[0].recipient_id).toBe(creator);
  });

  it("self-mention expands the link but produces no extra activity or fanout", async () => {
    const { projectId, flowId, slug } = await seedProject("SLF");
    const creator = await seedUser();
    const a = await createTask(
      { title: "A", prompt: "p", flowId },
      { projectId, actorUserId: creator },
      db,
    );

    const comment = await addTaskComment(
      {
        taskId: a.taskId,
        body: `this is SLF-${a.number}`,
        actor: { type: "user", id: creator },
      },
      db,
    );

    expect(comment.body).toBe(`this is [SLF-1](/projects/${slug}/tasks/1)`);

    const mentioned = await rowsOf(
      "task_activity",
      `task_id = '${a.taskId}' and event_kind = 'task_mentioned'`,
    );

    expect(mentioned).toHaveLength(0);
  });

  it("rejects a comment on a missing task with PRECONDITION", async () => {
    await expect(
      addTaskComment(
        { taskId: newId(), body: "x", actor: { type: "system", id: null } },
        db,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("lists comments ascending with paging", async () => {
    const { projectId, flowId } = await seedProject("LST");
    const creator = await seedUser();
    const a = await createTask(
      { title: "A", prompt: "p", flowId },
      { projectId, actorUserId: creator },
      db,
    );

    for (let i = 1; i <= 5; i += 1) {
      await addTaskComment(
        {
          taskId: a.taskId,
          body: `comment ${i}`,
          actor: { type: "user", id: creator },
        },
        db,
      );
    }

    const all = await listTaskComments(a.taskId, undefined, db);

    expect(all.map((c) => c.body)).toEqual([
      "comment 1",
      "comment 2",
      "comment 3",
      "comment 4",
      "comment 5",
    ]);

    const page = await listTaskComments(a.taskId, { limit: 2, offset: 2 }, db);

    expect(page.map((c) => c.body)).toEqual(["comment 3", "comment 4"]);
  });

  it("runs the whole pipeline atomically — a poisoned step leaves no partial writes", async () => {
    const { projectId, flowId } = await seedProject("ATM");
    const creator = await seedUser();
    const a = await createTask(
      { title: "A", prompt: "p", flowId },
      { projectId, actorUserId: creator },
      db,
    );

    // Sabotage the fanout target inside the tx by violating the CHECK: an
    // actor pair with type system + non-null id cannot be inserted, so the
    // comment insert itself fails — assert nothing else committed.
    await expect(
      addTaskComment(
        {
          taskId: a.taskId,
          body: "poisoned",
          // FIXME(any): deliberately invalid pair to trip the DB CHECK.
          actor: { type: "system", id: "not-null" } as never,
        },
        db,
      ),
    ).rejects.toThrow();

    const comments = await rowsOf(
      "task_comments",
      `task_id = '${a.taskId}'`,
    );
    const activity = await rowsOf(
      "task_activity",
      `task_id = '${a.taskId}' and event_kind = 'comment_added'`,
    );
    const items = await rowsOf("inbox_items", `task_id = '${a.taskId}'`);

    expect(comments).toHaveLength(0);
    expect(activity).toHaveLength(0);
    expect(items).toHaveLength(0);
  });
});
