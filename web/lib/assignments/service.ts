import "server-only";

import type { MaisterYamlV2 } from "@/lib/config.schema";
import type {
  ActorIdentity,
  Assignment,
  ProjectFlowRole,
} from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const {
  actorIdentities,
  assignmentEvents,
  assignments,
  projectFlowRoles,
  runs,
} =
  // FIXME(any): dual drizzle-orm peer-dep variants.
  schemaModule as unknown as Record<string, any>;

// FIXME(any): service accepts real Drizzle clients and route-test fakes.
type Db = any;
type FlowRoleConfig = MaisterYamlV2["flow_roles"][number];

const log = pino({
  name: "assignments",
  level: process.env.LOG_LEVEL ?? "info",
});

export type SyncProjectFlowRolesFromConfigArgs = {
  db?: Db;
  projectId: string;
  roles: readonly FlowRoleConfig[];
};

export type EnsureUserActorArgs = {
  db?: Db;
  projectId: string;
  userId: string;
  label?: string | null;
};

export type CreateAssignmentArgs = {
  db?: Db;
  projectId: string;
  runId: string;
  taskId?: string | null;
  nodeId?: string | null;
  stepId?: string | null;
  hitlRequestId?: string | null;
  nodeAttemptId?: string | null;
  actionKind: Assignment["actionKind"];
  roleRefs?: readonly string[];
  title: string;
  createdByActorId?: string | null;
  branch?: string | null;
  ref?: string | null;
};

export type CreateHitlAssignmentArgs = CreateAssignmentArgs & {
  hitlRequestId: string;
  actionKind: Extract<
    Assignment["actionKind"],
    "permission" | "form" | "human_review" | "infra_recovery" | "budget_breach"
  >;
};

export type CreateHitlAssignmentForRunArgs = Omit<
  CreateHitlAssignmentArgs,
  "projectId" | "taskId"
>;

export type FindActiveAssignmentForRunArgs = {
  db?: Db;
  runId: string;
  actionKinds: readonly Assignment["actionKind"][];
};

export type ClaimAssignmentArgs = {
  db?: Db;
  assignmentId: string;
  actorId: string;
};

export type AssignmentTransitionArgs = ClaimAssignmentArgs & {
  reason?: string;
};

export type CompleteAssignmentArgs = ClaimAssignmentArgs & {
  eventKind?: Extract<
    AssignmentEventKind,
    "completed" | "responded" | "returned"
  >;
  payload?: Record<string, unknown>;
};

export type CancelAssignmentArgs = ClaimAssignmentArgs & {
  eventKind?: Extract<
    AssignmentEventKind,
    "cancelled" | "superseded" | "system_closed"
  >;
  reason?: string;
};

export type CompleteHitlAssignmentFromCurrentActorArgs = {
  db?: Db;
  hitlRequestId: string;
  eventKind?: Extract<
    AssignmentEventKind,
    "completed" | "responded" | "returned"
  >;
  payload?: Record<string, unknown>;
};

export type SystemCloseActiveAssignmentsForRunArgs = {
  db?: Db;
  runId: string;
  reason: string;
};

function actorLabel(args: EnsureUserActorArgs): string {
  return args.label ?? args.userId;
}

async function runAssignmentTransaction<T>(
  db: Db,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  if (typeof (db as { transaction?: unknown }).transaction !== "function") {
    return await fn(db);
  }

  return await (db as { transaction: any }).transaction(fn);
}

async function ensureSystemActor(args: {
  db: Db;
  projectId: string;
  systemKey: string;
  label: string;
}): Promise<ActorIdentity> {
  const existing = await args.db
    .select()
    .from(actorIdentities)
    .where(
      and(
        eq(actorIdentities.projectId, args.projectId),
        eq(actorIdentities.kind, "system"),
        eq(actorIdentities.systemKey, args.systemKey),
      ),
    )
    .limit(1);

  if (existing[0]) return existing[0] as ActorIdentity;

  const [actor] = await args.db
    .insert(actorIdentities)
    .values({
      id: randomUUID(),
      projectId: args.projectId,
      kind: "system",
      label: args.label,
      systemKey: args.systemKey,
      updatedAt: new Date(),
    })
    .returning();

  return actor as ActorIdentity;
}

export async function syncProjectFlowRolesFromConfig(
  args: SyncProjectFlowRolesFromConfigArgs,
): Promise<ProjectFlowRole[]> {
  const db = args.db ?? getDb();
  const now = new Date();
  const activeRefs = new Set(args.roles.map((role) => role.ref));

  const result = await (db as { transaction: any }).transaction(
    async (tx: Db) => {
      const existingBefore: Array<{
        id: string;
        roleRef: string;
        archivedAt: Date | null;
      }> = await tx
        .select({
          id: projectFlowRoles.id,
          roleRef: projectFlowRoles.roleRef,
          archivedAt: projectFlowRoles.archivedAt,
        })
        .from(projectFlowRoles)
        .where(eq(projectFlowRoles.projectId, args.projectId));
      const existingByRef = new Map(
        existingBefore.map((role) => [role.roleRef, role]),
      );
      let addedCount = 0;
      let updatedCount = 0;
      let archivedCount = 0;

      for (const role of args.roles) {
        const existing = existingByRef.get(role.ref);

        if (!existing) {
          addedCount += 1;
        } else {
          updatedCount += 1;
        }

        await tx
          .insert(projectFlowRoles)
          .values({
            id: randomUUID(),
            projectId: args.projectId,
            roleRef: role.ref,
            label: role.label ?? role.ref,
            description: role.description ?? null,
            source: "config",
            archivedAt: null,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [projectFlowRoles.projectId, projectFlowRoles.roleRef],
            set: {
              label: role.label ?? role.ref,
              description: role.description ?? null,
              source: "config",
              archivedAt: null,
              updatedAt: now,
            },
          });
      }

      for (const role of existingBefore) {
        if (activeRefs.has(role.roleRef)) continue;

        if (role.archivedAt === null) {
          archivedCount += 1;
        }

        await tx
          .update(projectFlowRoles)
          .set({ archivedAt: now, updatedAt: now })
          .where(eq(projectFlowRoles.id, role.id));
      }

      const rows = await tx
        .select()
        .from(projectFlowRoles)
        .where(eq(projectFlowRoles.projectId, args.projectId));

      return {
        rows: rows as ProjectFlowRole[],
        addedCount,
        updatedCount,
        archivedCount,
      };
    },
  );

  log.info(
    {
      projectId: args.projectId,
      addedCount: result.addedCount,
      updatedCount: result.updatedCount,
      archivedCount: result.archivedCount,
      activeCount: args.roles.length,
    },
    "project flow roles synced",
  );

  return result.rows;
}

export async function ensureUserActor(
  args: EnsureUserActorArgs,
): Promise<ActorIdentity> {
  const db = args.db ?? getDb();
  const now = new Date();
  const [actor] = await db
    .insert(actorIdentities)
    .values({
      id: randomUUID(),
      projectId: args.projectId,
      kind: "user",
      label: actorLabel(args),
      userId: args.userId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [actorIdentities.projectId, actorIdentities.userId],
      targetWhere: sql`${actorIdentities.kind} = 'user'`,
      set: {
        label: actorLabel(args),
        updatedAt: now,
      },
    })
    .returning();

  log.debug(
    { projectId: args.projectId, userId: args.userId, actorId: actor.id },
    "[FIX:token-actor-uniqueness] user actor ensured",
  );

  return actor as ActorIdentity;
}

export type EnsureApiTokenActorArgs = {
  db?: Db;
  projectId: string;
  tokenId: string;
  ownerUserId?: string | null;
  label?: string | null;
};

// M17 (ADR-055): the api_token actor for external HITL responses. Upserts on the
// partial unique (project_id, token_id) WHERE kind='api_token' so repeated
// answers from the same token attribute to one actor row.
export async function ensureApiTokenActor(
  args: EnsureApiTokenActorArgs,
): Promise<ActorIdentity> {
  const db = args.db ?? getDb();
  const now = new Date();
  const label = args.label ?? `token:${args.tokenId}`;
  const [actor] = await db
    .insert(actorIdentities)
    .values({
      id: randomUUID(),
      projectId: args.projectId,
      kind: "api_token",
      label,
      userId: args.ownerUserId ?? null,
      tokenId: args.tokenId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [actorIdentities.projectId, actorIdentities.tokenId],
      targetWhere: sql`${actorIdentities.kind} = 'api_token'`,
      set: { label, userId: args.ownerUserId ?? null, updatedAt: now },
    })
    .returning();

  log.debug(
    {
      projectId: args.projectId,
      tokenId: args.tokenId,
      ownerUserId: args.ownerUserId ?? null,
      actorId: actor.id,
    },
    "[FIX:token-actor-uniqueness] api-token actor ensured",
  );

  return actor as ActorIdentity;
}

async function insertAssignmentEvent(args: {
  db: Db;
  assignmentId: string;
  projectId: string;
  runId: string;
  eventKind: AssignmentEventKind;
  actorId?: string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await args.db.insert(assignmentEvents).values({
    id: randomUUID(),
    assignmentId: args.assignmentId,
    projectId: args.projectId,
    runId: args.runId,
    eventKind: args.eventKind,
    actorId: args.actorId ?? null,
    fromStatus: args.fromStatus ?? null,
    toStatus: args.toStatus ?? null,
    payload: args.payload ?? {},
  });
}

type AssignmentEventKind =
  | "created"
  | "claimed"
  | "released"
  | "taken_over"
  | "responded"
  | "returned"
  | "completed"
  | "cancelled"
  | "superseded"
  | "system_closed";

async function createAssignmentInDb(
  db: Db,
  args: CreateAssignmentArgs,
): Promise<Assignment> {
  const [assignment] = await db
    .insert(assignments)
    .values({
      id: randomUUID(),
      projectId: args.projectId,
      runId: args.runId,
      taskId: args.taskId ?? null,
      nodeId: args.nodeId ?? null,
      stepId: args.stepId ?? null,
      hitlRequestId: args.hitlRequestId ?? null,
      nodeAttemptId: args.nodeAttemptId ?? null,
      actionKind: args.actionKind,
      status: "open",
      roleRefs: [...(args.roleRefs ?? [])],
      title: args.title,
      assigneeActorId: null,
      createdByActorId: args.createdByActorId ?? null,
      completedByActorId: null,
      branch: args.branch ?? null,
      ref: args.ref ?? null,
      claimedAt: null,
      completedAt: null,
    })
    .onConflictDoUpdate({
      target: assignments.hitlRequestId,
      set: { updatedAt: new Date() },
    })
    .returning();

  const existingEvents = await db
    .select()
    .from(assignmentEvents)
    .where(eq(assignmentEvents.assignmentId, assignment.id));

  if (existingEvents.length === 0) {
    await insertAssignmentEvent({
      db,
      assignmentId: assignment.id,
      projectId: assignment.projectId,
      runId: assignment.runId,
      eventKind: "created",
      actorId: args.createdByActorId ?? null,
      toStatus: "open",
    });
  }

  return assignment as Assignment;
}

export async function createAssignment(
  args: CreateAssignmentArgs,
): Promise<Assignment> {
  const db = args.db ?? getDb();

  return await runAssignmentTransaction(db, async (tx) =>
    createAssignmentInDb(tx, args),
  );
}

export async function createHitlAssignment(
  args: CreateHitlAssignmentArgs,
): Promise<Assignment> {
  return await createAssignment(args);
}

export async function createHitlAssignmentForRun(
  args: CreateHitlAssignmentForRunArgs,
): Promise<Assignment> {
  const db = args.db ?? getDb();
  const [run] = await db
    .select({ projectId: runs.projectId, taskId: runs.taskId })
    .from(runs)
    .where(eq(runs.id, args.runId));

  if (!run) {
    throw new MaisterError(
      "PRECONDITION",
      `Run not found for assignment: runId=${args.runId}`,
    );
  }

  return createHitlAssignment({
    ...args,
    db,
    projectId: run.projectId,
    taskId: run.taskId,
  });
}

export async function findActiveAssignmentForRun(
  args: FindActiveAssignmentForRunArgs,
): Promise<Assignment | null> {
  const db = args.db ?? getDb();
  const rows = await db
    .select()
    .from(assignments)
    .where(eq(assignments.runId, args.runId));
  const actionKinds = new Set(args.actionKinds);
  const activeStatuses = new Set(["open", "claimed"]);
  const active = (rows as Assignment[]).find(
    (assignment) =>
      actionKinds.has(assignment.actionKind) &&
      activeStatuses.has(assignment.status),
  );

  return active ?? null;
}

async function findAssignmentById(
  db: Db,
  assignmentId: string,
): Promise<Assignment> {
  const [assignment] = await db
    .select()
    .from(assignments)
    .where(eq(assignments.id, assignmentId));

  if (!assignment) {
    throw new MaisterError(
      "PRECONDITION",
      `Assignment not found: assignmentId=${assignmentId}`,
    );
  }

  return assignment as Assignment;
}

export async function claimAssignment(
  args: ClaimAssignmentArgs,
): Promise<Assignment> {
  const db = args.db ?? getDb();

  return await runAssignmentTransaction(db, async (tx: Db) => {
    const existing = await findAssignmentById(tx, args.assignmentId);

    if (
      existing.status === "claimed" &&
      existing.assigneeActorId === args.actorId
    ) {
      return existing;
    }

    if (existing.status !== "open" || existing.assigneeActorId !== null) {
      throw new MaisterError(
        "CONFLICT",
        `Assignment already claimed: assignmentId=${args.assignmentId}`,
      );
    }

    const now = new Date();
    const [claimed] = await tx
      .update(assignments)
      .set({
        status: "claimed",
        assigneeActorId: args.actorId,
        claimedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(assignments.id, args.assignmentId),
          eq(assignments.status, "open"),
          isNull(assignments.assigneeActorId),
        ),
      )
      .returning();

    if (!claimed) {
      const latest = await findAssignmentById(tx, args.assignmentId);

      if (
        latest.status === "claimed" &&
        latest.assigneeActorId === args.actorId
      ) {
        return latest;
      }

      throw new MaisterError(
        "CONFLICT",
        `Assignment claim lost: assignmentId=${args.assignmentId}`,
      );
    }

    await insertAssignmentEvent({
      db: tx,
      assignmentId: claimed.id,
      projectId: claimed.projectId,
      runId: claimed.runId,
      eventKind: "claimed",
      actorId: args.actorId,
      fromStatus: "open",
      toStatus: "claimed",
    });

    return claimed as Assignment;
  });
}

export async function releaseAssignment(
  args: AssignmentTransitionArgs,
): Promise<Assignment> {
  const db = args.db ?? getDb();

  return await runAssignmentTransaction(db, async (tx: Db) => {
    const existing = await findAssignmentById(tx, args.assignmentId);

    if (existing.status === "open" && existing.assigneeActorId === null) {
      return existing;
    }

    if (
      existing.status !== "claimed" ||
      existing.assigneeActorId !== args.actorId
    ) {
      throw new MaisterError(
        "CONFLICT",
        `Assignment cannot be released by actor: assignmentId=${args.assignmentId}`,
      );
    }

    const now = new Date();
    const [released] = await tx
      .update(assignments)
      .set({
        status: "open",
        assigneeActorId: null,
        claimedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(assignments.id, args.assignmentId),
          eq(assignments.status, "claimed"),
          eq(assignments.assigneeActorId, args.actorId),
        ),
      )
      .returning();

    if (!released) {
      throw new MaisterError(
        "CONFLICT",
        `Assignment release lost: assignmentId=${args.assignmentId}`,
      );
    }

    await insertAssignmentEvent({
      db: tx,
      assignmentId: released.id,
      projectId: released.projectId,
      runId: released.runId,
      eventKind: "released",
      actorId: args.actorId,
      fromStatus: "claimed",
      toStatus: "open",
      payload: args.reason ? { reason: args.reason } : {},
    });

    return released as Assignment;
  });
}

export async function takeOverAssignment(
  args: AssignmentTransitionArgs,
): Promise<Assignment> {
  const db = args.db ?? getDb();

  return await runAssignmentTransaction(db, async (tx: Db) => {
    const existing = await findAssignmentById(tx, args.assignmentId);

    if (
      existing.status === "claimed" &&
      existing.assigneeActorId === args.actorId
    ) {
      return existing;
    }

    if (existing.status !== "claimed" || existing.assigneeActorId === null) {
      throw new MaisterError(
        "PRECONDITION",
        `Assignment is not claimed by another actor: assignmentId=${args.assignmentId}`,
      );
    }

    const previousActorId = existing.assigneeActorId;
    const now = new Date();
    const [transferred] = await tx
      .update(assignments)
      .set({
        status: "claimed",
        assigneeActorId: args.actorId,
        claimedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(assignments.id, args.assignmentId),
          eq(assignments.status, "claimed"),
          eq(assignments.assigneeActorId, previousActorId),
        ),
      )
      .returning();

    if (!transferred) {
      throw new MaisterError(
        "CONFLICT",
        `Assignment take-over lost: assignmentId=${args.assignmentId}`,
      );
    }

    await insertAssignmentEvent({
      db: tx,
      assignmentId: transferred.id,
      projectId: transferred.projectId,
      runId: transferred.runId,
      eventKind: "taken_over",
      actorId: args.actorId,
      fromStatus: "claimed",
      toStatus: "claimed",
      payload: {
        previousActorId,
        ...(args.reason ? { reason: args.reason } : {}),
      },
    });

    return transferred as Assignment;
  });
}

export async function completeAssignment(
  args: CompleteAssignmentArgs,
): Promise<Assignment> {
  const db = args.db ?? getDb();
  const eventKind = args.eventKind ?? "completed";

  return await runAssignmentTransaction(db, async (tx: Db) => {
    const existing = await findAssignmentById(tx, args.assignmentId);

    if (
      existing.status === "completed" &&
      existing.completedByActorId === args.actorId
    ) {
      return existing;
    }

    if (existing.status === "completed") {
      throw new MaisterError(
        "PRECONDITION",
        `Assignment is already completed: assignmentId=${args.assignmentId}`,
      );
    }

    if (
      existing.assigneeActorId !== null &&
      existing.assigneeActorId !== args.actorId
    ) {
      throw new MaisterError(
        "CONFLICT",
        `Assignment claimed by another actor: assignmentId=${args.assignmentId}`,
      );
    }

    if (existing.status === "cancelled") {
      throw new MaisterError(
        "PRECONDITION",
        `Assignment is terminal: assignmentId=${args.assignmentId}`,
      );
    }

    const now = new Date();
    const [completed] = await tx
      .update(assignments)
      .set({
        status: "completed",
        completedByActorId: args.actorId,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(assignments.id, args.assignmentId))
      .returning();

    await insertAssignmentEvent({
      db: tx,
      assignmentId: completed.id,
      projectId: completed.projectId,
      runId: completed.runId,
      eventKind,
      actorId: args.actorId,
      fromStatus: existing.status,
      toStatus: "completed",
      payload: args.payload ?? {},
    });

    return completed as Assignment;
  });
}

export async function completeHitlAssignmentFromCurrentActor(
  args: CompleteHitlAssignmentFromCurrentActorArgs,
): Promise<Assignment | null> {
  const db = args.db ?? getDb();
  const eventKind = args.eventKind ?? "completed";

  return await runAssignmentTransaction(db, async (tx: Db) => {
    const [existing] = await tx
      .select()
      .from(assignments)
      .where(eq(assignments.hitlRequestId, args.hitlRequestId));

    if (!existing) return null;
    const assignment = existing as Assignment;

    if (
      assignment.status === "completed" ||
      assignment.status === "cancelled"
    ) {
      return assignment;
    }

    const actorId = assignment.assigneeActorId ?? assignment.createdByActorId;
    const now = new Date();
    const [completed] = await tx
      .update(assignments)
      .set({
        status: "completed",
        completedByActorId: actorId ?? null,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(assignments.id, assignment.id),
          inArray(assignments.status, ["open", "claimed"]),
        ),
      )
      .returning();

    if (!completed) {
      const [latest] = await tx
        .select()
        .from(assignments)
        .where(eq(assignments.id, assignment.id));

      return (latest as Assignment | undefined) ?? assignment;
    }

    await insertAssignmentEvent({
      db: tx,
      assignmentId: completed.id,
      projectId: completed.projectId,
      runId: completed.runId,
      eventKind,
      actorId,
      fromStatus: assignment.status,
      toStatus: "completed",
      payload: args.payload ?? {},
    });

    return completed as Assignment;
  });
}

export async function cancelAssignment(
  args: CancelAssignmentArgs,
): Promise<Assignment> {
  const db = args.db ?? getDb();
  const eventKind = args.eventKind ?? "cancelled";

  return await runAssignmentTransaction(db, async (tx: Db) => {
    const existing = await findAssignmentById(tx, args.assignmentId);

    if (existing.status === "cancelled") {
      return existing;
    }

    if (existing.status === "completed") {
      throw new MaisterError(
        "PRECONDITION",
        `Completed assignment cannot be cancelled: assignmentId=${args.assignmentId}`,
      );
    }

    const now = new Date();
    const [cancelled] = await tx
      .update(assignments)
      .set({
        status: "cancelled",
        updatedAt: now,
      })
      .where(eq(assignments.id, args.assignmentId))
      .returning();

    await insertAssignmentEvent({
      db: tx,
      assignmentId: cancelled.id,
      projectId: cancelled.projectId,
      runId: cancelled.runId,
      eventKind,
      actorId: args.actorId,
      fromStatus: existing.status,
      toStatus: "cancelled",
      payload: args.reason ? { reason: args.reason } : {},
    });

    return cancelled as Assignment;
  });
}

export async function getOpenAssignmentsForRun(args: {
  db?: Db;
  runId: string;
}): Promise<Assignment[]> {
  const db = args.db ?? getDb();
  const rows = await db
    .select()
    .from(assignments)
    .where(
      and(
        eq(assignments.runId, args.runId),
        inArray(assignments.status, ["open", "claimed"]),
      ),
    );

  return rows as Assignment[];
}

export async function cancelActiveAssignmentsForRun(args: {
  db?: Db;
  runId: string;
  actorId: string;
  eventKind?: Extract<
    AssignmentEventKind,
    "cancelled" | "superseded" | "system_closed"
  >;
  reason?: string;
}): Promise<Assignment[]> {
  const db = args.db ?? getDb();

  return await runAssignmentTransaction(db, async (tx: Db) => {
    const active = await getOpenAssignmentsForRun({
      db: tx,
      runId: args.runId,
    });
    const cancelled: Assignment[] = [];

    for (const assignment of active) {
      cancelled.push(
        await cancelAssignment({
          db: tx,
          assignmentId: assignment.id,
          actorId: args.actorId,
          eventKind: args.eventKind ?? "system_closed",
          reason: args.reason,
        }),
      );
    }

    return cancelled;
  });
}

export async function systemCloseActiveAssignmentsForRun(
  args: SystemCloseActiveAssignmentsForRunArgs,
): Promise<Assignment[]> {
  const db = args.db ?? getDb();

  return await runAssignmentTransaction(db, async (tx: Db) => {
    const active = await getOpenAssignmentsForRun({
      db: tx,
      runId: args.runId,
    });

    if (active.length === 0) return [];

    const [run] = await tx
      .select({ projectId: runs.projectId })
      .from(runs)
      .where(eq(runs.id, args.runId));

    if (!run) {
      throw new MaisterError(
        "PRECONDITION",
        `Run not found for assignment cleanup: runId=${args.runId}`,
      );
    }

    const actor = await ensureSystemActor({
      db: tx,
      projectId: run.projectId,
      systemKey: "assignment-lifecycle",
      label: "MAIster lifecycle",
    });
    const closed: Assignment[] = [];

    for (const assignment of active) {
      closed.push(
        await cancelAssignment({
          db: tx,
          assignmentId: assignment.id,
          actorId: actor.id,
          eventKind: "system_closed",
          reason: args.reason,
        }),
      );
    }

    log.info(
      {
        runId: args.runId,
        actorId: actor.id,
        closedCount: closed.length,
        reason: args.reason,
      },
      "[FIX:M13] active assignments system-closed for terminal run",
    );

    return closed;
  });
}
