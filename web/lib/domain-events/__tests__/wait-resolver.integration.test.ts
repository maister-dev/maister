import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, onTestFinished } from "vitest";

import { dispatchDomainEvents } from "@/lib/domain-events/dispatch";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { isRunTerminalEventKind } from "@/lib/domain-events/taxonomy";
import { addTaskComment } from "@/lib/social/comments";
import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import { fakeGraphHosts } from "@/test-support/fake-execution-host";
import { seedGraphRun } from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "wait_resolver" });
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

it.each(["deleted", "cross-project"] as const)(
  "W04 refuses a related run when its task relation is %s",
  async (kind) => {
    const { runFlow } = await import("@/lib/flows/runner");
    const { buildWaitResolver } =
      await import("@/lib/domain-events/wait-resolver");
    const db = database.db as unknown as Db;
    const targetId = randomUUID();
    const relationId = randomUUID();
    const { runId, projectId, taskId, runtimeRoot, worktreePath } =
      await seedGraphRun(database.db, {
        schemaVersion: 1,
        name: "Task relation wait",
        compat: { engine_min: "3.14.0" },
        nodes: [
          {
            type: "wait",
            id: "related",
            on: { kind: "run", run_id: targetId, relation_id: relationId },
            timeout: 600,
            transitions: {
              done: "done",
              failed: "done",
              review: "done",
              crashed: "done",
              abandoned: "done",
              timeout: "done",
              cancelled: "done",
            },
          },
        ],
      });

    onTestFinished(async () => {
      await Promise.all(
        [runtimeRoot, worktreePath].map((path) =>
          rm(path, { recursive: true, force: true }),
        ),
      );
    });
    const targetProjectId =
      kind === "cross-project"
        ? (await seedProjectRow(database.db)).id
        : projectId;
    const targetTaskId = randomUUID();

    await database.pool.query(
      "INSERT INTO tasks (id,project_id,number,title,prompt) VALUES ($1,$2,1,'Related task','')",
      [targetTaskId, targetProjectId],
    );
    await seedRun(database.db, { projectId: targetProjectId, id: targetId });
    await database.pool.query("UPDATE runs SET task_id=$2 WHERE id=$1", [
      targetId,
      targetTaskId,
    ]);
    await database.pool.query(
      `INSERT INTO task_relations (id,project_id,kind,from_task_id,to_task_id,actor_type)
    VALUES ($1,$2,'requires',$3,$4,'system')`,
      [relationId, projectId, taskId, targetTaskId],
    );
    const { hosts } = await fakeGraphHosts(database.db, runId);

    await runFlow(runId, {
      db: database.db,
      runtimeRoot,
      executionHosts: hosts,
    });

    if (kind === "deleted")
      await database.pool.query("DELETE FROM task_relations WHERE id=$1", [
        relationId,
      ]);
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE runs SET status='Done' WHERE id=${targetId}`);
      await emitDomainEvent({
        db: tx,
        projectId: targetProjectId,
        runId: targetId,
        taskId: targetTaskId,
        kind: "run.done",
        parentRunId: null,
        payload: {},
      });
    });
    expect(
      (
        await dispatchDomainEvents({
          db: database.db,
          consumers: [buildWaitResolver(() => database.db)],
        })
      ).failures,
    ).toBe(0);
    expect(
      (
        await database.pool.query(
          "SELECT r.status,w.state,w.result FROM runs r LEFT JOIN run_waits w ON r.id=w.run_id WHERE r.id=$1",
          [runId],
        )
      ).rows,
    ).toEqual([
      {
        status: kind === "deleted" ? "Waiting" : "Failed",
        state: kind === "deleted" ? "open" : null,
        result: null,
      },
    ]);
  },
);

it.each([
  ["run.done", "Done", "done"],
  ["run.failed", "Failed", "failed"],
  ["run.crashed", "Crashed", "crashed"],
  ["run.abandoned", "Abandoned", "abandoned"],
  ["run.review", "Review", "review"],
  ["run.review_opened", "Review", "review"],
] as const)(
  "W04 routes the exact related-run fact %s",
  async (kind, status, outcome) => {
    const { runFlow } = await import("@/lib/flows/runner");
    const { buildWaitResolver } =
      await import("@/lib/domain-events/wait-resolver");
    const db = database.db as unknown as Db;
    const relatedRunId = randomUUID();
    const topLevel = kind === "run.review_opened";
    const { runId, projectId, runtimeRoot, worktreePath } = await seedGraphRun(
      database.db,
      {
        schemaVersion: 1,
        name: "Related run wait",
        compat: { engine_min: "3.14.0" },
        nodes: [
          {
            type: "wait",
            id: "related",
            on: {
              kind: "run",
              run_id: relatedRunId,
              relation: topLevel ? "parent" : "child",
            },
            timeout: 120,
            transitions: {
              done: "done",
              failed: "done",
              review: "done",
              crashed: "done",
              abandoned: "done",
              timeout: "done",
              cancelled: "done",
            },
          },
        ],
      },
    );

    onTestFinished(async () => {
      await Promise.all(
        [runtimeRoot, worktreePath].map((path) =>
          rm(path, { recursive: true, force: true }),
        ),
      );
    });
    await seedRun(database.db, { projectId, id: relatedRunId });
    const decoy = await seedRun(database.db, { projectId });

    if (topLevel)
      await database.pool.query(
        "UPDATE runs SET parent_run_id=$2 WHERE id=$1",
        [runId, relatedRunId],
      );
    else
      await database.pool.query(
        "UPDATE runs SET parent_run_id=$2 WHERE id IN ($1,$3)",
        [relatedRunId, runId, decoy],
      );
    const fact = async (sourceRunId: string, eventKind: typeof kind) =>
      db.transaction(async (tx) => {
        const input = {
          db: tx,
          projectId,
          runId: sourceRunId,
          actor: { type: "system" as const, id: null },
          payload: {},
        };
        const parentRunId = topLevel ? null : runId;

        await tx.execute(
          sql`UPDATE runs SET status=${eventKind === "run.done" ? "Done" : status} WHERE id=${sourceRunId}`,
        );

        if (eventKind === "run.review_opened")
          return emitDomainEvent({ ...input, kind: eventKind });
        if (eventKind === "run.done" || eventKind === "run.review")
          return emitDomainEvent({ ...input, kind: eventKind, parentRunId });
        if (isRunTerminalEventKind(eventKind))
          return emitDomainEvent({
            ...input,
            kind: eventKind,
            parentRunId,
            cause: { code: "PRECONDITION", source: "graph" },
          });
      });
    const consumer = buildWaitResolver(() => database.db);
    const dispatch = () =>
      dispatchDomainEvents({ db: database.db, consumers: [consumer] });
    const state = async () =>
      (
        await database.pool.query(
          "SELECT state,result FROM run_waits WHERE run_id=$1",
          [runId],
        )
      ).rows[0];
    const { hosts, fake } = await fakeGraphHosts(database.db, runId);
    let settledWhileParking = false;

    if (kind === "run.failed") {
      const inventory = fake.transport.listSessionsForRun;

      fake.transport.listSessionsForRun = async (inventoryRunId) => {
        if (
          !settledWhileParking &&
          inventoryRunId === runId &&
          (await state())?.state === "parking"
        ) {
          settledWhileParking = true;
          await fact(relatedRunId, kind);
          expect((await dispatch()).failures).toBe(0);
          expect(await state()).toEqual({ state: "parking", result: null });
        }

        return inventory(inventoryRunId);
      };
    }

    if (kind === "run.abandoned")
      await database.pool.query(
        "UPDATE runs SET status='Abandoned' WHERE id=$1",
        [relatedRunId],
      );
    if (kind === "run.crashed") {
      await fact(relatedRunId, "run.review");
      await database.pool.query(
        "UPDATE runs SET status='Running' WHERE id=$1",
        [relatedRunId],
      );
    }
    if (kind === "run.done") {
      await fact(relatedRunId, "run.review");
      await fact(relatedRunId, kind);
    }
    await runFlow(runId, {
      db: database.db,
      runtimeRoot,
      executionHosts: hosts,
    });

    if (kind === "run.failed") expect(settledWhileParking).toBe(true);
    if (
      kind !== "run.done" &&
      kind !== "run.failed" &&
      kind !== "run.abandoned"
    ) {
      await fact(decoy, kind);
      expect((await dispatch()).failures).toBe(0);
      expect(await state()).toEqual({ state: "open", result: null });
      await fact(relatedRunId, kind);
      if (outcome === "review") await fact(relatedRunId, "run.done");
    }
    expect((await dispatch()).failures).toBe(0);
    expect(await state()).toMatchObject({
      state: "resolved",
      result: { source: "run", outcome, data: { runId: relatedRunId } },
    });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM domain_events WHERE run_id=$1 AND kind='run.wait_resolved'",
          [runId],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  },
);

it("W04 resolves only a newly visible comment from the bound task and actor", async () => {
  const { runFlow } = await import("@/lib/flows/runner");
  const { buildWaitResolver } =
    await import("@/lib/domain-events/wait-resolver");
  const consumer = buildWaitResolver(() => database.db);
  const { runId, runtimeRoot, worktreePath, taskId } = await seedGraphRun(
    database.db,
    {
      schemaVersion: 1,
      name: "Comment wait",
      compat: { engine_min: "3.14.0" },
      nodes: [
        {
          type: "wait",
          id: "comment",
          on: { kind: "comment", actor: { type: "user", id: "expected" } },
          timeout: 120,
          transitions: {
            commented: "done",
            timeout: "done",
            cancelled: "done",
          },
        },
      ],
    },
  );

  onTestFinished(async () => {
    await Promise.all(
      [runtimeRoot, worktreePath].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
  });

  const comment = (actorId: string, body: string) =>
    addTaskComment(
      {
        taskId,
        body,
        actor: { type: "user", id: actorId },
      },
      database.db,
    );
  const dispatch = () =>
    dispatchDomainEvents({ db: database.db, consumers: [consumer] });
  const wait = async () =>
    (
      await database.pool.query(
        "SELECT state, result FROM run_waits WHERE run_id=$1",
        [runId],
      )
    ).rows[0];

  await dispatch();
  await comment("expected", "An older comment");

  const { hosts } = await fakeGraphHosts(database.db, runId);

  await runFlow(runId, { db: database.db, runtimeRoot, executionHosts: hosts });
  await comment("unexpected", "Comment from another actor");
  expect((await dispatch()).failures).toBe(0);
  expect(await wait()).toEqual({ state: "open", result: null });

  const { comment: accepted } = await comment(
    "expected",
    "{{steps.injected.vars.text}}",
  );

  expect((await dispatch()).failures).toBe(0);
  expect(await wait()).toMatchObject({
    state: "resolved",
    result: {
      outcome: "commented",
      source: "comment",
      data: { commentId: accepted.id },
    },
  });
});
