import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { createTask, updateTask } from "@/lib/services/tasks";
import {
  bindTaskSource,
  detachTaskSource,
  findTaskIdBySource,
  loadTaskSources,
} from "@/lib/tasks/external-source/service";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

const user = { type: "user" as const, id: "u-source" };

function github(externalId: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: "github",
    instance: "github.com",
    scope: "acme/widgets",
    externalId,
    externalKey: "#7",
    url: "https://github.com/acme/widgets/issues/7",
    ...overrides,
  };
}

async function seedProject(): Promise<string> {
  const projectId = randomUUID();
  const slug = `src-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: slug,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
    taskKey:
      `S${projectId.slice(0, 6).replace(/[^a-z0-9]/gi, "")}`.toUpperCase(),
  });

  return projectId;
}

async function tasksIn(projectId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(eq(schema.tasks.projectId, projectId));

  return rows.length;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("task external source binding (ADR-206)", () => {
  it("S1: same visible key in another instance or scope is a distinct identity", async () => {
    const projectId = await seedProject();

    await createTask(
      { title: "a", prompt: "p", source: github("I_a") },
      { projectId, actor: user },
      db,
    );
    await createTask(
      {
        title: "b",
        prompt: "p",
        source: github("I_b", { instance: "ghe.example.com" }),
      },
      { projectId, actor: user },
      db,
    );
    await createTask(
      {
        title: "c",
        prompt: "p",
        source: github("I_c", { scope: "acme/other" }),
      },
      { projectId, actor: user },
      db,
    );

    const ids = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.projectId, projectId));
    const sources = await loadTaskSources(
      db,
      ids.map((row) => row.id),
    );

    expect(
      [...sources.values()]
        .map((s) => `${s.instance}|${s.scope}|${s.externalKey}`)
        .sort(),
    ).toEqual([
      "ghe.example.com|acme/widgets|#7",
      "github.com|acme/other|#7",
      "github.com|acme/widgets|#7",
    ]);
  });

  it("S1: a duplicate identity refuses source_already_bound and leaves no task behind", async () => {
    const projectId = await seedProject();
    const first = await createTask(
      { title: "first", prompt: "p", source: github("I_dup") },
      { projectId, actor: user },
      db,
    );

    const refusal = await createTask(
      {
        title: "second",
        prompt: "p",
        source: github("I_dup", { instance: "GitHub.com", externalKey: "#8" }),
      },
      { projectId, actor: user },
      db,
    ).catch((err: unknown) => err);

    expect(refusal).toMatchObject({
      code: "CONFLICT",
      details: {
        reason: "source_already_bound",
        existingTaskId: first.taskId,
        existingTaskKey: `${first.taskKey}-${first.number}`,
      },
    });
    expect(await tasksIn(projectId)).toBe(1);
    expect(
      await findTaskIdBySource(
        projectId,
        {
          kind: "github",
          instance: "github.com",
          externalId: "I_dup",
        },
        db,
      ),
    ).toBe(first.taskId);
  });

  it("S2: a binding without URL or key round-trips with both null", async () => {
    const projectId = await seedProject();
    const created = await createTask(
      {
        title: "bare",
        prompt: "p",
        source: {
          kind: "jira",
          instance: "jira.example.com",
          scope: "PROJ",
          externalId: "10042",
        },
      },
      { projectId, actor: user },
      db,
    );

    const sources = await loadTaskSources(db, [created.taskId]);

    expect(sources.get(created.taskId)).toEqual({
      kind: "jira",
      instance: "jira.example.com",
      scope: "PROJ",
      externalId: "10042",
      externalKey: null,
      url: null,
    });
  });

  it("S3: title and prompt edits leave the binding untouched", async () => {
    const projectId = await seedProject();
    const created = await createTask(
      { title: "t", prompt: "p", source: github("I_edit") },
      { projectId, actor: user },
      db,
    );
    const before = await loadTaskSources(db, [created.taskId]);

    await updateTask(
      created.taskId,
      projectId,
      { title: "renamed", prompt: "new" },
      db,
    );

    expect(await loadTaskSources(db, [created.taskId])).toEqual(before);
  });

  it("S3: bind is a no-op for the same identity, refreshes display fields, and refuses a different one", async () => {
    const projectId = await seedProject();
    const created = await createTask(
      { title: "t", prompt: "p" },
      { projectId, actor: user },
      db,
    );

    await bindTaskSource(
      {
        projectId,
        taskId: created.taskId,
        source: github("I_bind"),
        actor: user,
      },
      db,
    );
    await bindTaskSource(
      {
        projectId,
        taskId: created.taskId,
        source: github("I_bind", {
          scope: "acme/renamed",
          externalKey: "#70",
          url: null,
        }),
        actor: user,
      },
      db,
    );

    expect(
      (await loadTaskSources(db, [created.taskId])).get(created.taskId),
    ).toMatchObject({
      scope: "acme/renamed",
      externalKey: "#70",
      url: "https://github.com/acme/widgets/issues/7",
    });
    await expect(
      bindTaskSource(
        {
          projectId,
          taskId: created.taskId,
          source: github("I_other"),
          actor: user,
        },
        db,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "source_conflict" },
    });
  });

  it("S3: binding an identity owned by another task refuses source_already_bound", async () => {
    const projectId = await seedProject();
    const owner = await createTask(
      { title: "owner", prompt: "p", source: github("I_owned") },
      { projectId, actor: user },
      db,
    );
    const other = await createTask(
      { title: "other", prompt: "p" },
      { projectId, actor: user },
      db,
    );

    await expect(
      bindTaskSource(
        {
          projectId,
          taskId: other.taskId,
          source: github("I_owned"),
          actor: user,
        },
        db,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "source_already_bound", existingTaskId: owner.taskId },
    });
  });

  it("S3: a stale expectedRevision refuses the bind", async () => {
    const projectId = await seedProject();
    const created = await createTask(
      { title: "t", prompt: "p" },
      { projectId, actor: user },
      db,
    );

    await expect(
      bindTaskSource(
        {
          projectId,
          taskId: created.taskId,
          source: github("I_stale"),
          actor: user,
          expectedRevision: 9,
        },
        db,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "stale_revision" },
    });
  });

  it("S3: detach deletes the binding, records source_detached and frees the identity", async () => {
    const projectId = await seedProject();
    const created = await createTask(
      { title: "t", prompt: "p", source: github("I_detach") },
      { projectId, actor: user },
      db,
    );

    await detachTaskSource(
      { projectId, taskId: created.taskId, actor: user },
      db,
    );

    const activity = await db
      .select({
        payload: schema.taskActivity.payload,
        actorId: schema.taskActivity.actorId,
      })
      .from(schema.taskActivity)
      .where(
        and(
          eq(schema.taskActivity.taskId, created.taskId),
          eq(schema.taskActivity.eventKind, "source_detached"),
        ),
      );

    expect(activity).toEqual([
      {
        actorId: user.id,
        payload: {
          kind: "github",
          instance: "github.com",
          externalId: "I_detach",
          externalKey: "#7",
        },
      },
    ]);
    expect((await loadTaskSources(db, [created.taskId])).size).toBe(0);
    await expect(
      detachTaskSource({ projectId, taskId: created.taskId, actor: user }, db),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "source_not_bound" },
    });
    await createTask(
      { title: "reimport", prompt: "p", source: github("I_detach") },
      { projectId, actor: user },
      db,
    );
  });
});
