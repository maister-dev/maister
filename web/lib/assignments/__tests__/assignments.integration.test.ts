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

import {
  claimAssignment,
  cancelAssignment,
  completeAssignment,
  completeHitlAssignmentFromCurrentActor,
  createHitlAssignment,
  ensureUserActor,
  releaseAssignment,
  syncProjectFlowRolesFromConfig,
  systemCloseActiveAssignmentsForRun,
  takeOverAssignment,
} from "../service";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { isMaisterError } from "@/lib/errors";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("assignments_test")
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

function newId(): string {
  return randomUUID();
}

function dbFailingAssignmentEvents(): NodePgDatabase {
  const wrap = (target: any): Record<string, any> =>
    new Proxy(target, {
      get(inner, prop) {
        if (prop === "insert") {
          return (table: unknown) => {
            if (table === schema.assignmentEvents) {
              throw new Error("forced assignment event insert failure");
            }

            return inner.insert(table);
          };
        }

        const value = inner[prop as keyof typeof inner];

        return typeof value === "function" ? value.bind(inner) : value;
      },
    });

  return new Proxy(db as unknown as Record<string, any>, {
    get(target, prop) {
      if (prop === "transaction") {
        return async (fn: (tx: Record<string, any>) => Promise<unknown>) =>
          target.transaction.call(db, (tx: any) => fn(wrap(tx)));
      }

      return wrap(target)[prop as keyof ReturnType<typeof wrap>];
    },
  }) as unknown as NodePgDatabase;
}

async function seedWait(): Promise<{
  projectId: string;
  runId: string;
  hitlRequestId: string;
  reviewerUserId: string;
  qaUserId: string;
}> {
  const projectId = newId();
  const executorId = newId();
  const flowId = newId();
  const taskId = newId();
  const runId = newId();
  const hitlRequestId = newId();
  const reviewerUserId = newId();
  const qaUserId = newId();

  await db.insert(schema.users).values([
    {
      id: reviewerUserId,
      email: `reviewer-${reviewerUserId.slice(0, 8)}@example.test`,
      role: "member",
      accountStatus: "active",
    },
    {
      id: qaUserId,
      email: `qa-${qaUserId.slice(0, 8)}@example.test`,
      role: "member",
      accountStatus: "active",
    },
  ]);

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `assign-${projectId.slice(0, 8)}`,
    name: "Assignment Test",
    repoPath: `/tmp/assign-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

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

  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    title: "Review task",
    prompt: "review this",
    flowId,
  });

  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    status: "NeedsInput",
    flowVersion: "v1.0.0",
  });

  await db.insert(schema.hitlRequests).values({
    id: hitlRequestId,
    runId,
    stepId: "review",
    kind: "human",
    schema: {
      schemaVersion: 1,
      fields: [],
      allowedDecisions: ["approve", "rework"],
    },
    prompt: "Review the result",
  });

  return { projectId, runId, hitlRequestId, reviewerUserId, qaUserId };
}

describe("assignments service", () => {
  it("syncs flow roles with SET, CLEAR, and re-enable symmetry", async () => {
    const { projectId } = await seedWait();

    await syncProjectFlowRolesFromConfig({
      db,
      projectId,
      roles: [
        {
          ref: "reviewer",
          label: "Reviewer",
          description: "Human or service reviewer",
        },
        { ref: "qa", label: "QA" },
      ],
    });

    await syncProjectFlowRolesFromConfig({
      db,
      projectId,
      roles: [{ ref: "qa", label: "Quality Gate" }],
    });

    const afterClear = await db
      .select()
      .from(schema.projectFlowRoles)
      .where(eq(schema.projectFlowRoles.projectId, projectId));
    const reviewerAfterClear = afterClear.find(
      (role) => role.roleRef === "reviewer",
    );
    const qaAfterClear = afterClear.find((role) => role.roleRef === "qa");

    expect(reviewerAfterClear?.archivedAt).toBeInstanceOf(Date);
    expect(qaAfterClear?.archivedAt).toBeNull();
    expect(qaAfterClear?.label).toBe("Quality Gate");

    await syncProjectFlowRolesFromConfig({
      db,
      projectId,
      roles: [{ ref: "reviewer", label: "Reviewer Restored" }],
    });

    const afterRestore = await db
      .select()
      .from(schema.projectFlowRoles)
      .where(eq(schema.projectFlowRoles.projectId, projectId));
    const reviewerAfterRestore = afterRestore.find(
      (role) => role.roleRef === "reviewer",
    );
    const qaAfterRestore = afterRestore.find((role) => role.roleRef === "qa");

    expect(afterRestore).toHaveLength(2);
    expect(reviewerAfterRestore?.archivedAt).toBeNull();
    expect(reviewerAfterRestore?.label).toBe("Reviewer Restored");
    expect(qaAfterRestore?.archivedAt).toBeInstanceOf(Date);
  });

  it("creates or reuses one user actor per project and user", async () => {
    const { projectId, reviewerUserId } = await seedWait();

    const first = await ensureUserActor({
      db,
      projectId,
      userId: reviewerUserId,
      label: "Reviewer",
    });
    const second = await ensureUserActor({
      db,
      projectId,
      userId: reviewerUserId,
      label: "Renamed reviewer",
    });

    expect(second.id).toBe(first.id);
    expect(second.kind).toBe("user");
    expect(second.userId).toBe(reviewerUserId);
  });

  it("creates an open HITL assignment and appends a create event", async () => {
    const { projectId, runId, hitlRequestId, reviewerUserId } =
      await seedWait();
    const actor = await ensureUserActor({
      db,
      projectId,
      userId: reviewerUserId,
      label: "Reviewer",
    });

    const assignment = await createHitlAssignment({
      db,
      projectId,
      runId,
      hitlRequestId,
      actionKind: "human_review",
      roleRefs: ["reviewer"],
      title: "Review the result",
      createdByActorId: actor.id,
    });
    const repeated = await createHitlAssignment({
      db,
      projectId,
      runId,
      hitlRequestId,
      actionKind: "human_review",
      roleRefs: ["reviewer"],
      title: "Review the result",
      createdByActorId: actor.id,
    });

    expect(assignment.status).toBe("open");
    expect(repeated.id).toBe(assignment.id);
    expect(assignment.assigneeActorId).toBeNull();
    expect(assignment.roleRefs).toEqual(["reviewer"]);

    const events = await db
      .select()
      .from(schema.assignmentEvents)
      .where(eq(schema.assignmentEvents.assignmentId, assignment.id));

    expect(events).toHaveLength(1);
    expect(events[0].eventKind).toBe("created");
    expect(events[0].actorId).toBe(actor.id);
  });

  it("rolls back assignment creation when the created event cannot be written", async () => {
    const { projectId, runId, hitlRequestId, reviewerUserId } =
      await seedWait();
    const actor = await ensureUserActor({
      db,
      projectId,
      userId: reviewerUserId,
      label: "Reviewer",
    });

    await expect(
      createHitlAssignment({
        db: dbFailingAssignmentEvents(),
        projectId,
        runId,
        hitlRequestId,
        actionKind: "human_review",
        roleRefs: ["reviewer"],
        title: "Review the result",
        createdByActorId: actor.id,
      }),
    ).rejects.toThrow(/forced assignment event insert failure/);

    const assignments = await db
      .select()
      .from(schema.assignments)
      .where(eq(schema.assignments.hitlRequestId, hitlRequestId));

    expect(assignments).toHaveLength(0);
  });

  it("claims by CAS, is idempotent for the same actor, and conflicts for another actor", async () => {
    const { projectId, runId, hitlRequestId, reviewerUserId, qaUserId } =
      await seedWait();
    const reviewerActor = await ensureUserActor({
      db,
      projectId,
      userId: reviewerUserId,
      label: "Reviewer",
    });
    const qaActor = await ensureUserActor({
      db,
      projectId,
      userId: qaUserId,
      label: "QA",
    });
    const assignment = await createHitlAssignment({
      db,
      projectId,
      runId,
      hitlRequestId,
      actionKind: "human_review",
      roleRefs: ["reviewer"],
      title: "Review the result",
      createdByActorId: reviewerActor.id,
    });

    const claimed = await claimAssignment({
      db,
      assignmentId: assignment.id,
      actorId: reviewerActor.id,
    });
    const claimedAgain = await claimAssignment({
      db,
      assignmentId: assignment.id,
      actorId: reviewerActor.id,
    });

    expect(claimed.status).toBe("claimed");
    expect(claimed.assigneeActorId).toBe(reviewerActor.id);
    expect(claimedAgain.id).toBe(claimed.id);

    try {
      await claimAssignment({
        db,
        assignmentId: assignment.id,
        actorId: qaActor.id,
      });
      throw new Error("expected claimAssignment to throw");
    } catch (err) {
      if (!isMaisterError(err)) throw err;
      expect(err.code).toBe("CONFLICT");
    }

    const events = await db
      .select()
      .from(schema.assignmentEvents)
      .where(eq(schema.assignmentEvents.assignmentId, assignment.id));

    expect(events.map((event) => event.eventKind)).toEqual([
      "created",
      "claimed",
    ]);
  });

  it("rolls back claim state when the claimed event cannot be written", async () => {
    const { projectId, runId, hitlRequestId, reviewerUserId } =
      await seedWait();
    const reviewerActor = await ensureUserActor({
      db,
      projectId,
      userId: reviewerUserId,
      label: "Reviewer",
    });
    const assignment = await createHitlAssignment({
      db,
      projectId,
      runId,
      hitlRequestId,
      actionKind: "human_review",
      roleRefs: ["reviewer"],
      title: "Review the result",
      createdByActorId: reviewerActor.id,
    });

    await expect(
      claimAssignment({
        db: dbFailingAssignmentEvents(),
        assignmentId: assignment.id,
        actorId: reviewerActor.id,
      }),
    ).rejects.toThrow(/forced assignment event insert failure/);

    const [afterFailure] = await db
      .select()
      .from(schema.assignments)
      .where(eq(schema.assignments.id, assignment.id));
    const events = await db
      .select()
      .from(schema.assignmentEvents)
      .where(eq(schema.assignmentEvents.assignmentId, assignment.id));

    expect(afterFailure.status).toBe("open");
    expect(afterFailure.assigneeActorId).toBeNull();
    expect(events.map((event) => event.eventKind)).toEqual(["created"]);
  });

  it("releases a same-actor claim back to open and appends an event", async () => {
    const { projectId, runId, hitlRequestId, reviewerUserId } =
      await seedWait();
    const actor = await ensureUserActor({
      db,
      projectId,
      userId: reviewerUserId,
      label: "Reviewer",
    });
    const assignment = await createHitlAssignment({
      db,
      projectId,
      runId,
      hitlRequestId,
      actionKind: "human_review",
      roleRefs: ["reviewer"],
      title: "Review the result",
      createdByActorId: actor.id,
    });

    await claimAssignment({
      db,
      assignmentId: assignment.id,
      actorId: actor.id,
    });
    const released = await releaseAssignment({
      db,
      assignmentId: assignment.id,
      actorId: actor.id,
      reason: "back to queue",
    });

    expect(released.status).toBe("open");
    expect(released.assigneeActorId).toBeNull();
    expect(released.claimedAt).toBeNull();

    const events = await db
      .select()
      .from(schema.assignmentEvents)
      .where(eq(schema.assignmentEvents.assignmentId, assignment.id));

    expect(events.map((event) => event.eventKind)).toEqual([
      "created",
      "claimed",
      "released",
    ]);
    expect(events.at(-1)?.payload).toEqual({ reason: "back to queue" });
  });

  it("transfers a claim through deliberate take-over", async () => {
    const { projectId, runId, hitlRequestId, reviewerUserId, qaUserId } =
      await seedWait();
    const reviewerActor = await ensureUserActor({
      db,
      projectId,
      userId: reviewerUserId,
      label: "Reviewer",
    });
    const qaActor = await ensureUserActor({
      db,
      projectId,
      userId: qaUserId,
      label: "QA",
    });
    const assignment = await createHitlAssignment({
      db,
      projectId,
      runId,
      hitlRequestId,
      actionKind: "human_review",
      roleRefs: ["reviewer"],
      title: "Review the result",
      createdByActorId: reviewerActor.id,
    });

    await claimAssignment({
      db,
      assignmentId: assignment.id,
      actorId: reviewerActor.id,
    });
    const transferred = await takeOverAssignment({
      db,
      assignmentId: assignment.id,
      actorId: qaActor.id,
      reason: "covering review",
    });

    expect(transferred.status).toBe("claimed");
    expect(transferred.assigneeActorId).toBe(qaActor.id);

    const events = await db
      .select()
      .from(schema.assignmentEvents)
      .where(eq(schema.assignmentEvents.assignmentId, assignment.id));

    expect(events.map((event) => event.eventKind)).toEqual([
      "created",
      "claimed",
      "taken_over",
    ]);
    expect(events.at(-1)?.payload).toEqual({
      previousActorId: reviewerActor.id,
      reason: "covering review",
    });
  });

  it("completes and cancels assignments with terminal events", async () => {
    const { projectId, runId, hitlRequestId, reviewerUserId, qaUserId } =
      await seedWait();
    const reviewerActor = await ensureUserActor({
      db,
      projectId,
      userId: reviewerUserId,
      label: "Reviewer",
    });
    const qaActor = await ensureUserActor({
      db,
      projectId,
      userId: qaUserId,
      label: "QA",
    });
    const assignment = await createHitlAssignment({
      db,
      projectId,
      runId,
      hitlRequestId,
      actionKind: "human_review",
      roleRefs: ["reviewer"],
      title: "Review the result",
      createdByActorId: reviewerActor.id,
    });

    await claimAssignment({
      db,
      assignmentId: assignment.id,
      actorId: reviewerActor.id,
    });
    const completed = await completeAssignment({
      db,
      assignmentId: assignment.id,
      actorId: reviewerActor.id,
      eventKind: "responded",
      payload: { decision: "approve" },
    });

    expect(completed.status).toBe("completed");
    expect(completed.completedByActorId).toBe(reviewerActor.id);
    expect(completed.completedAt).toBeInstanceOf(Date);

    const repeatedComplete = await completeAssignment({
      db,
      assignmentId: assignment.id,
      actorId: reviewerActor.id,
      eventKind: "responded",
      payload: { decision: "approve" },
    });

    expect(repeatedComplete.id).toBe(completed.id);

    const secondHitlRequestId = newId();

    await db.insert(schema.hitlRequests).values({
      id: secondHitlRequestId,
      runId,
      stepId: "second-review",
      kind: "human",
      schema: {
        schemaVersion: 1,
        fields: [],
        allowedDecisions: ["approve", "rework"],
      },
      prompt: "Review again",
    });

    const second = await createHitlAssignment({
      db,
      projectId,
      runId,
      hitlRequestId: secondHitlRequestId,
      actionKind: "human_review",
      roleRefs: ["qa"],
      title: "Second review",
      createdByActorId: qaActor.id,
    });
    const cancelled = await cancelAssignment({
      db,
      assignmentId: second.id,
      actorId: qaActor.id,
      eventKind: "system_closed",
      reason: "run terminal",
    });

    expect(cancelled.status).toBe("cancelled");

    const allEvents = await db
      .select()
      .from(schema.assignmentEvents)
      .where(eq(schema.assignmentEvents.runId, runId));

    expect(allEvents.map((event) => event.eventKind)).toEqual([
      "created",
      "claimed",
      "responded",
      "created",
      "system_closed",
    ]);
  });

  it("completes a HITL assignment from its current actor without requiring a claim", async () => {
    const { projectId, runId, hitlRequestId, reviewerUserId } =
      await seedWait();
    const actor = await ensureUserActor({
      db,
      projectId,
      userId: reviewerUserId,
      label: "Reviewer",
    });
    const assignment = await createHitlAssignment({
      db,
      projectId,
      runId,
      hitlRequestId,
      actionKind: "human_review",
      roleRefs: ["reviewer"],
      title: "Review the result",
      createdByActorId: actor.id,
    });

    const completed = await completeHitlAssignmentFromCurrentActor({
      db,
      hitlRequestId,
      eventKind: "responded",
      payload: { decision: "approve" },
    });
    const repeated = await completeHitlAssignmentFromCurrentActor({
      db,
      hitlRequestId,
      eventKind: "responded",
      payload: { decision: "approve" },
    });

    expect(completed).toMatchObject({
      id: assignment.id,
      status: "completed",
      completedByActorId: actor.id,
    });
    expect(repeated?.id).toBe(assignment.id);

    const events = await db
      .select()
      .from(schema.assignmentEvents)
      .where(eq(schema.assignmentEvents.assignmentId, assignment.id));

    expect(events.map((event) => event.eventKind)).toEqual([
      "created",
      "responded",
    ]);
  });

  it("system-closes active assignments for a terminal run with a system actor", async () => {
    const { projectId, runId, hitlRequestId, reviewerUserId, qaUserId } =
      await seedWait();
    const reviewerActor = await ensureUserActor({
      db,
      projectId,
      userId: reviewerUserId,
      label: "Reviewer",
    });
    const qaActor = await ensureUserActor({
      db,
      projectId,
      userId: qaUserId,
      label: "QA",
    });
    const first = await createHitlAssignment({
      db,
      projectId,
      runId,
      hitlRequestId,
      actionKind: "human_review",
      roleRefs: ["reviewer"],
      title: "Review the result",
      createdByActorId: reviewerActor.id,
    });
    const secondHitlRequestId = newId();

    await db.insert(schema.hitlRequests).values({
      id: secondHitlRequestId,
      runId,
      stepId: "second-review",
      kind: "human",
      schema: {
        schemaVersion: 1,
        fields: [],
        allowedDecisions: ["approve", "rework"],
      },
      prompt: "Review again",
    });
    const second = await createHitlAssignment({
      db,
      projectId,
      runId,
      hitlRequestId: secondHitlRequestId,
      actionKind: "human_review",
      roleRefs: ["qa"],
      title: "Second review",
      createdByActorId: qaActor.id,
    });

    await claimAssignment({
      db,
      assignmentId: second.id,
      actorId: qaActor.id,
    });
    const closed = await systemCloseActiveAssignmentsForRun({
      db,
      runId,
      reason: "run terminal",
    });

    expect(closed.map((assignment) => assignment.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(
      closed.every((assignment) => assignment.status === "cancelled"),
    ).toBe(true);

    const systemActors = await db
      .select()
      .from(schema.actorIdentities)
      .where(eq(schema.actorIdentities.kind, "system"));
    const events = await db
      .select()
      .from(schema.assignmentEvents)
      .where(eq(schema.assignmentEvents.runId, runId));

    expect(systemActors[0]).toMatchObject({
      projectId,
      systemKey: "assignment-lifecycle",
    });
    expect(
      events
        .filter((event) => event.eventKind === "system_closed")
        .map((event) => event.actorId),
    ).toEqual([systemActors[0].id, systemActors[0].id]);
  });
});
