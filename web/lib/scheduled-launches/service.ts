import "server-only";

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import {
  projects,
  runs,
  scheduledTaskLaunchAttempts,
  scheduledTaskLaunchEvents,
  scheduledTaskLaunches,
  tasks,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { worktreesRoot } from "@/lib/instance-config";
import { storedDeliveryPolicySchema } from "@/lib/runs/delivery-policy";
import { executionPolicySchema } from "@/lib/runs/execution-policy";
import { resolveScheduledLaunchTime } from "@/lib/scheduled-launches/time";

import type {
  LaunchRunContext,
  LaunchRunInput,
} from "@/lib/services/runs";
import type {
  ScheduledLaunchReservation,
  ScheduledLaunchRequest,
  ScheduledLaunchState,
} from "@/lib/scheduled-launches/types";
import type * as schema from "@/lib/db/schema";

const scheduledLaunchRequestSchema = z
  .object({
    flowId: z.string().min(1).max(255).optional(),
    runnerId: z.string().min(1).max(255).optional(),
    baseBranch: z.string().min(1).max(255).optional(),
    baseCommit: z.string().min(7).max(255).optional(),
    targetBranch: z.string().min(1).max(255).optional(),
    deliveryPolicy: storedDeliveryPolicySchema.optional(),
    executionPolicy: executionPolicySchema.optional(),
    packageVersions: z
      .record(z.enum(["keep", "adopt", "cut_and_adopt", "try_once"]))
      .optional(),
    brainContext: z.boolean().nullable().optional(),
    autoPromote: z.boolean().optional(),
  })
  .strict();

const stateTransitions: Readonly<
  Record<ScheduledLaunchState, readonly ScheduledLaunchState[]>
> = {
  Scheduled: ["Scheduled", "Dispatching", "Cancelled"],
  Dispatching: ["RetryWaiting", "Launched", "Failed"],
  RetryWaiting: ["Scheduled", "Dispatching", "Cancelled"],
  Launched: [],
  Failed: [],
  Cancelled: [],
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`);

    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value);
}

function sortPackageVersions(
  packageVersions: ScheduledLaunchRequest["packageVersions"],
): ScheduledLaunchRequest["packageVersions"] {
  if (!packageVersions) return undefined;

  return Object.fromEntries(
    Object.entries(packageVersions).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

export function normalizeScheduledLaunchRequest(
  input: unknown,
): ScheduledLaunchRequest {
  const parsed = scheduledLaunchRequestSchema.safeParse(input);

  if (!parsed.success) {
    throw new MaisterError("CONFIG", "scheduled launch request is invalid");
  }

  return {
    ...parsed.data,
    ...(parsed.data.packageVersions
      ? { packageVersions: sortPackageVersions(parsed.data.packageVersions) }
      : {}),
  };
}

export function hashScheduledLaunchRequest(
  request: ScheduledLaunchRequest,
): string {
  return createHash("sha256").update(stableJson(request)).digest("hex");
}

export function hashScheduledLaunchCreateRequest(input: {
  taskId: string;
  scheduledLocalTime: string;
  timezone: string;
  disambiguation?: "earlier" | "later";
  launchRequest: ScheduledLaunchRequest;
}): string {
  return createHash("sha256")
    .update(
      stableJson({
        taskId: input.taskId,
        scheduledLocalTime: input.scheduledLocalTime,
        timezone: input.timezone,
        disambiguation: input.disambiguation ?? null,
        launchRequest: input.launchRequest,
      }),
    )
    .digest("hex");
}

export function assertScheduledLaunchTransition(
  from: ScheduledLaunchState,
  to: ScheduledLaunchState,
): void {
  if (stateTransitions[from].includes(to)) return;

  throw new MaisterError(
    "PRECONDITION",
    `scheduled launch cannot transition from ${from} to ${to}`,
  );
}

type ScheduledLaunchDb = NodePgDatabase<typeof schema>;

type ClaimSource = "tick" | "run_now";

type ClaimableScheduledLaunchRow = {
  attemptCount: number;
  claimFence: number | null;
  id: string;
  maxAttempts: number;
  projectArchivedAt: Date | string | null;
  projectBranchPrefix: string;
  projectSlug: string;
  projectTaskKey: string;
  requestHash: string;
  revision: number;
  taskId: string | null;
};

function rowsOf<T>(result: { rows: unknown[] }): T[] {
  return result.rows as T[];
}

async function recordScheduledLaunchEvent(
  db: ScheduledLaunchDb,
  input: {
    scheduledLaunchId: string;
    kind: "claimed" | "failed";
    actorType: "system";
    actorId?: string;
    claimFence?: number;
    errorCode?: string;
    message?: string;
    now: Date;
  },
): Promise<void> {
  await db.insert(scheduledTaskLaunchEvents).values({
    id: randomUUID(),
    scheduledLaunchId: input.scheduledLaunchId,
    kind: input.kind,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    claimFence: input.claimFence ?? null,
    errorCode: input.errorCode ?? null,
    message: input.message ?? null,
    createdAt: input.now,
  });
}

async function failUnavailableClaim(
  db: ScheduledLaunchDb,
  input: {
    scheduledLaunchId: string;
    errorCode: "PRECONDITION";
    now: Date;
  },
): Promise<void> {
  await db
    .update(scheduledTaskLaunches)
    .set({
      state: "Failed",
      nextAttemptAt: null,
      latestOutcome: "failed",
      errorCode: input.errorCode,
      errorMessage: "Scheduled target is no longer available",
      updatedAt: input.now,
    })
    .where(eq(scheduledTaskLaunches.id, input.scheduledLaunchId));
  await recordScheduledLaunchEvent(db, {
    scheduledLaunchId: input.scheduledLaunchId,
    kind: "failed",
    actorType: "system",
    errorCode: input.errorCode,
    message: "Scheduled target is no longer available",
    now: input.now,
  });
}

export async function createScheduledLaunch(input: {
  projectId: string;
  taskId: string;
  actorUserId: string;
  idempotencyKey: string;
  scheduledLocalTime: string;
  timezone: string;
  disambiguation?: "earlier" | "later";
  launchRequest: unknown;
  now?: Date;
  db?: ScheduledLaunchDb;
}): Promise<{
  replayed: boolean;
  intent: typeof scheduledTaskLaunches.$inferSelect;
}> {
  const db = input.db ?? (getDb() as ScheduledLaunchDb);
  const now = input.now ?? new Date();
  const request = normalizeScheduledLaunchRequest(input.launchRequest);
  const requestHash = hashScheduledLaunchCreateRequest({
    taskId: input.taskId,
    scheduledLocalTime: input.scheduledLocalTime,
    timezone: input.timezone,
    disambiguation: input.disambiguation,
    launchRequest: request,
  });
  const scheduledForAt = resolveScheduledLaunchTime({
    scheduledLocalTime: input.scheduledLocalTime,
    timezone: input.timezone,
    disambiguation: input.disambiguation,
  });

  if (input.idempotencyKey.length === 0 || input.idempotencyKey.length > 128) {
    throw new MaisterError("CONFIG", "Idempotency-Key must be 1 to 128 characters");
  }
  if (scheduledForAt.getTime() <= now.getTime()) {
    throw new MaisterError("CONFIG", "scheduled time must be in the future");
  }

  return db.transaction(async (tx) => {
    const taskRows = await tx
      .select({
        id: tasks.id,
        key: projects.taskKey,
        number: tasks.number,
        projectArchivedAt: projects.archivedAt,
        title: tasks.title,
      })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(
        and(eq(tasks.id, input.taskId), eq(tasks.projectId, input.projectId)),
      );
    const task = taskRows[0];

    if (!task || task.projectArchivedAt !== null) {
      throw new MaisterError(
        "PRECONDITION",
        "scheduled launch task is not available in an active project",
      );
    }

    const [inserted] = await tx
      .insert(scheduledTaskLaunches)
      .values({
        id: randomUUID(),
        projectId: input.projectId,
        taskId: task.id,
        taskKey: task.key,
        taskNumber: task.number,
        taskTitle: task.title,
        createdByUserId: input.actorUserId,
        lastActorUserId: input.actorUserId,
        scheduledLocalTime: input.scheduledLocalTime,
        timezone: input.timezone,
        disambiguation: input.disambiguation ?? null,
        scheduledForAt,
        armedAt: now,
        launchRequest: request,
        requestHash,
        idempotencyKey: input.idempotencyKey,
        state: "Scheduled",
        revision: 1,
        nextAttemptAt: scheduledForAt,
        attemptCount: 0,
        maxAttempts: 3,
        latestOutcome: "created",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted) {
      await tx.insert(scheduledTaskLaunchEvents).values({
        id: randomUUID(),
        scheduledLaunchId: inserted.id,
        kind: "created",
        actorType: "user",
        actorId: input.actorUserId,
        createdAt: now,
      });

      return { replayed: false, intent: inserted };
    }

    const existing = await tx
      .select()
      .from(scheduledTaskLaunches)
      .where(
        and(
          eq(scheduledTaskLaunches.projectId, input.projectId),
          eq(scheduledTaskLaunches.createdByUserId, input.actorUserId),
          eq(scheduledTaskLaunches.idempotencyKey, input.idempotencyKey),
        ),
      );
    const existingIntent = existing[0];

    if (!existingIntent) {
      throw new MaisterError("CONFLICT", "scheduled launch was not created");
    }
    if (existingIntent.requestHash !== requestHash) {
      throw new MaisterError(
        "CONFLICT",
        "Idempotency-Key was already used for a different scheduled launch",
      );
    }

    return { replayed: true, intent: existingIntent };
  });
}

export async function rearmScheduledLaunch(input: {
  projectId: string;
  scheduledLaunchId: string;
  actorUserId: string;
  expectedRevision: number;
  scheduledLocalTime: string;
  timezone: string;
  disambiguation?: "earlier" | "later";
  launchRequest: unknown;
  now?: Date;
  db?: ScheduledLaunchDb;
}): Promise<typeof scheduledTaskLaunches.$inferSelect> {
  const db = input.db ?? (getDb() as ScheduledLaunchDb);
  const now = input.now ?? new Date();
  const launchRequest = normalizeScheduledLaunchRequest(input.launchRequest);
  const scheduledForAt = resolveScheduledLaunchTime({
    scheduledLocalTime: input.scheduledLocalTime,
    timezone: input.timezone,
    disambiguation: input.disambiguation,
  });

  if (scheduledForAt.getTime() <= now.getTime()) {
    throw new MaisterError("CONFIG", "scheduled time must be in the future");
  }

  const currentRows = await db
    .select({ taskId: scheduledTaskLaunches.taskId })
    .from(scheduledTaskLaunches)
    .where(
      and(
        eq(scheduledTaskLaunches.id, input.scheduledLaunchId),
        eq(scheduledTaskLaunches.projectId, input.projectId),
      ),
    );
  const taskId = currentRows[0]?.taskId;

  if (!taskId) {
    throw new MaisterError(
      "PRECONDITION",
      "scheduled launch target is no longer available",
    );
  }
  const requestHash = hashScheduledLaunchCreateRequest({
    taskId,
    scheduledLocalTime: input.scheduledLocalTime,
    timezone: input.timezone,
    disambiguation: input.disambiguation,
    launchRequest,
  });

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(scheduledTaskLaunches)
      .set({
        scheduledLocalTime: input.scheduledLocalTime,
        timezone: input.timezone,
        disambiguation: input.disambiguation ?? null,
        scheduledForAt,
        armedAt: now,
        launchRequest,
        requestHash,
        state: "Scheduled",
        revision: sql`${scheduledTaskLaunches.revision} + 1`,
        nextAttemptAt: scheduledForAt,
        attemptCount: 0,
        claimId: null,
        claimFence: null,
        claimExpiresAt: null,
        claimOrigin: null,
        latestOutcome: "rearmed",
        errorCode: null,
        errorMessage: null,
        lateByMs: null,
        lastActorUserId: input.actorUserId,
        updatedAt: now,
      })
      .where(
        and(
          eq(scheduledTaskLaunches.id, input.scheduledLaunchId),
          eq(scheduledTaskLaunches.projectId, input.projectId),
          eq(scheduledTaskLaunches.revision, input.expectedRevision),
          sql`${scheduledTaskLaunches.state} IN ('Scheduled', 'RetryWaiting')`,
        ),
      )
      .returning();
    const intent = updated[0];

    if (!intent) {
      throw new MaisterError(
        "CONFLICT",
        "scheduled launch is no longer editable at this revision",
      );
    }

    await tx.insert(scheduledTaskLaunchEvents).values({
      id: randomUUID(),
      scheduledLaunchId: intent.id,
      kind: "edited_rearmed",
      actorType: "user",
      actorId: input.actorUserId,
      createdAt: now,
    });

    return intent;
  });
}

export async function cancelScheduledLaunch(input: {
  projectId: string;
  scheduledLaunchId: string;
  actorUserId: string;
  expectedRevision: number;
  now?: Date;
  db?: ScheduledLaunchDb;
}): Promise<typeof scheduledTaskLaunches.$inferSelect> {
  const db = input.db ?? (getDb() as ScheduledLaunchDb);
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(scheduledTaskLaunches)
      .set({
        state: "Cancelled",
        revision: sql`${scheduledTaskLaunches.revision} + 1`,
        nextAttemptAt: null,
        latestOutcome: "cancelled",
        lastActorUserId: input.actorUserId,
        updatedAt: now,
      })
      .where(
        and(
          eq(scheduledTaskLaunches.id, input.scheduledLaunchId),
          eq(scheduledTaskLaunches.projectId, input.projectId),
          eq(scheduledTaskLaunches.revision, input.expectedRevision),
          sql`${scheduledTaskLaunches.state} IN ('Scheduled', 'RetryWaiting')`,
        ),
      )
      .returning();
    const intent = updated[0];

    if (!intent) {
      throw new MaisterError(
        "CONFLICT",
        "scheduled launch is no longer cancellable at this revision",
      );
    }

    await tx.insert(scheduledTaskLaunchEvents).values({
      id: randomUUID(),
      scheduledLaunchId: intent.id,
      kind: "cancelled",
      actorType: "user",
      actorId: input.actorUserId,
      createdAt: now,
    });

    return intent;
  });
}

export async function claimScheduledLaunch(input: {
  scheduledLaunchId: string;
  projectId: string;
  source: ClaimSource;
  expectedRevision?: number;
  now?: Date;
  db?: ScheduledLaunchDb;
}): Promise<{
  claimId: string;
  claimFence: number;
  reservation: ScheduledLaunchReservation;
}> {
  const db = input.db ?? (getDb() as ScheduledLaunchDb);
  const now = input.now ?? new Date();
  const claimId = randomUUID();

  return db.transaction(async (tx) => {
    const duePredicate =
      input.source === "tick"
        ? sql`${scheduledTaskLaunches.nextAttemptAt} <= ${now}`
        : sql`true`;
    const revisionPredicate =
      input.expectedRevision === undefined
        ? sql`true`
        : sql`${scheduledTaskLaunches.revision} = ${input.expectedRevision}`;
    const result = await tx.execute<ClaimableScheduledLaunchRow>(sql`
      SELECT
        l.id,
        l.task_id AS "taskId",
        l.attempt_count AS "attemptCount",
        l.max_attempts AS "maxAttempts",
        l.claim_fence AS "claimFence",
        l.request_hash AS "requestHash",
        l.revision,
        p.slug AS "projectSlug",
        p.branch_prefix AS "projectBranchPrefix",
        p.task_key AS "projectTaskKey",
        p.archived_at AS "projectArchivedAt"
      FROM scheduled_task_launches l
      INNER JOIN projects p ON p.id = l.project_id
      WHERE l.id = ${input.scheduledLaunchId}
        AND l.project_id = ${input.projectId}
        AND l.state IN ('Scheduled', 'RetryWaiting')
        AND ${duePredicate}
        AND ${revisionPredicate}
      FOR UPDATE OF l SKIP LOCKED
    `);
    const launch = rowsOf<ClaimableScheduledLaunchRow>(result)[0];

    if (!launch) {
      throw new MaisterError(
        "CONFLICT",
        "scheduled launch is no longer claimable",
      );
    }
    if (launch.projectArchivedAt !== null || launch.taskId === null) {
      await failUnavailableClaim(tx, {
        scheduledLaunchId: launch.id,
        errorCode: "PRECONDITION",
        now,
      });
      throw new MaisterError(
        "PRECONDITION",
        "scheduled launch target is no longer available",
      );
    }
    if (launch.attemptCount >= launch.maxAttempts) {
      await failUnavailableClaim(tx, {
        scheduledLaunchId: launch.id,
        errorCode: "PRECONDITION",
        now,
      });
      throw new MaisterError("PRECONDITION", "scheduled launch retry budget is exhausted");
    }

    const reservations = await tx
      .select()
      .from(scheduledTaskLaunchAttempts)
      .where(
        and(
          eq(scheduledTaskLaunchAttempts.scheduledLaunchId, launch.id),
          eq(scheduledTaskLaunchAttempts.requestHash, launch.requestHash),
        ),
      );
    const previousReservation = reservations[0];
    const claimFence = (launch.claimFence ?? 0) + 1;
    const reservation = previousReservation
      ? {
          id: previousReservation.id,
          scheduledLaunchId: previousReservation.scheduledLaunchId,
          runId: previousReservation.runId,
          taskId: launch.taskId,
          taskAttemptNumber: previousReservation.taskAttemptNumber,
          branch: previousReservation.branch,
          worktreePath: previousReservation.worktreePath,
          requestHash: previousReservation.requestHash,
          claimFence,
        }
      : await allocateScheduledLaunchReservation({
          db: tx,
          scheduledLaunchId: launch.id,
          taskId: launch.taskId,
          projectSlug: launch.projectSlug,
          projectBranchPrefix: launch.projectBranchPrefix,
          requestHash: launch.requestHash,
          claimFence,
          now,
        });

    if (previousReservation) {
      await tx
        .update(scheduledTaskLaunchAttempts)
        .set({ state: "Reserved", claimFence, updatedAt: now })
        .where(eq(scheduledTaskLaunchAttempts.id, previousReservation.id));
    }

    await tx
      .update(scheduledTaskLaunches)
      .set({
        state: "Dispatching",
        nextAttemptAt: null,
        attemptCount: launch.attemptCount + 1,
        claimId,
        claimFence,
        claimExpiresAt: new Date(now.getTime() + 5 * 60_000),
        claimOrigin: input.source,
        latestOutcome: "claimed",
        errorCode: null,
        errorMessage: null,
        lastActorUserId: null,
        updatedAt: now,
      })
      .where(eq(scheduledTaskLaunches.id, launch.id));
    await recordScheduledLaunchEvent(tx, {
      scheduledLaunchId: launch.id,
      kind: "claimed",
      actorType: "system",
      claimFence,
      now,
    });

    return { claimId, claimFence, reservation };
  });
}

async function allocateScheduledLaunchReservation(input: {
  db: ScheduledLaunchDb;
  scheduledLaunchId: string;
  taskId: string;
  projectSlug: string;
  projectBranchPrefix: string;
  requestHash: string;
  claimFence: number;
  now: Date;
}): Promise<ScheduledLaunchReservation> {
  const allocated = await input.db
    .update(tasks)
    .set({ attemptNumber: sql`${tasks.attemptNumber} + 1` })
    .where(eq(tasks.id, input.taskId))
    .returning({ attemptNumber: tasks.attemptNumber });
  const taskAttemptNumber = allocated[0]?.attemptNumber;

  if (taskAttemptNumber === undefined) {
    throw new MaisterError("PRECONDITION", "scheduled launch task no longer exists");
  }

  const runId = randomUUID();
  const id = randomUUID();
  const reservation: ScheduledLaunchReservation = {
    id,
    scheduledLaunchId: input.scheduledLaunchId,
    runId,
    taskId: input.taskId,
    taskAttemptNumber,
    branch: `${input.projectBranchPrefix}task-${input.taskId}/attempt-${taskAttemptNumber}`,
    worktreePath: path.join(worktreesRoot(), input.projectSlug, runId),
    requestHash: input.requestHash,
    claimFence: input.claimFence,
  };

  await input.db.insert(scheduledTaskLaunchAttempts).values({
    ...reservation,
    state: "Reserved",
    createdAt: input.now,
    updatedAt: input.now,
  });

  return reservation;
}

type ScheduledLaunchRunner = (
  input: LaunchRunInput,
  ctx: LaunchRunContext,
  db?: ScheduledLaunchDb,
) => Promise<{ runId: string; status: string; queuePosition?: number }>;

function isRetryableScheduledLaunchError(error: unknown): boolean {
  return (
    error instanceof MaisterError &&
    (error.code === "EXECUTOR_UNAVAILABLE" || error.code === "SPAWN")
  );
}

function retryAt(attemptCount: number, now: Date): Date {
  const delaysMs = [60_000, 5 * 60_000, 15 * 60_000] as const;
  const delayMs = delaysMs[attemptCount - 1] ?? delaysMs.at(-1)!;

  return new Date(now.getTime() + delayMs);
}

async function assertScheduledClaimOwner(input: {
  db: ScheduledLaunchDb;
  scheduledLaunchId: string;
  claimId: string;
  claimFence: number;
}): Promise<void> {
  const rows = await input.db
    .select({ id: scheduledTaskLaunches.id })
    .from(scheduledTaskLaunches)
    .where(
      and(
        eq(scheduledTaskLaunches.id, input.scheduledLaunchId),
        eq(scheduledTaskLaunches.state, "Dispatching"),
        eq(scheduledTaskLaunches.claimId, input.claimId),
        eq(scheduledTaskLaunches.claimFence, input.claimFence),
      ),
    );

  if (rows.length > 0) return;

  throw new MaisterError(
    "CONFLICT",
    "scheduled launch claim is no longer owned by this dispatcher",
  );
}

async function loadClaimedLaunch(input: {
  db: ScheduledLaunchDb;
  projectId: string;
  scheduledLaunchId: string;
  claimId: string;
  claimFence: number;
}): Promise<{
  attemptCount: number;
  launchRequest: ScheduledLaunchRequest;
  maxAttempts: number;
  scheduledForAt: Date;
  taskId: string;
}> {
  const rows = await input.db
    .select({
      attemptCount: scheduledTaskLaunches.attemptCount,
      launchRequest: scheduledTaskLaunches.launchRequest,
      maxAttempts: scheduledTaskLaunches.maxAttempts,
      scheduledForAt: scheduledTaskLaunches.scheduledForAt,
      taskId: scheduledTaskLaunches.taskId,
    })
    .from(scheduledTaskLaunches)
    .where(
      and(
        eq(scheduledTaskLaunches.id, input.scheduledLaunchId),
        eq(scheduledTaskLaunches.projectId, input.projectId),
        eq(scheduledTaskLaunches.state, "Dispatching"),
        eq(scheduledTaskLaunches.claimId, input.claimId),
        eq(scheduledTaskLaunches.claimFence, input.claimFence),
      ),
    );
  const launch = rows[0];

  if (!launch || launch.taskId === null) {
    throw new MaisterError(
      "PRECONDITION",
      "scheduled launch target is no longer available",
    );
  }

  return {
    ...launch,
    taskId: launch.taskId,
  };
}

async function loadReservation(input: {
  db: ScheduledLaunchDb;
  reservationId: string;
  scheduledLaunchId: string;
  taskId: string;
  claimFence: number;
}): Promise<ScheduledLaunchReservation> {
  const rows = await input.db
    .select()
    .from(scheduledTaskLaunchAttempts)
    .where(
      and(
        eq(scheduledTaskLaunchAttempts.id, input.reservationId),
        eq(
          scheduledTaskLaunchAttempts.scheduledLaunchId,
          input.scheduledLaunchId,
        ),
      ),
    );
  const reservation = rows[0];

  if (!reservation) {
    throw new MaisterError("PRECONDITION", "scheduled launch reservation is missing");
  }

  return {
    id: reservation.id,
    scheduledLaunchId: reservation.scheduledLaunchId,
    runId: reservation.runId,
    taskId: input.taskId,
    taskAttemptNumber: reservation.taskAttemptNumber,
    branch: reservation.branch,
    worktreePath: reservation.worktreePath,
    requestHash: reservation.requestHash,
    claimFence: input.claimFence,
  };
}

async function findLinkedScheduledRunId(input: {
  db: ScheduledLaunchDb;
  scheduledLaunchId: string;
}): Promise<string | null> {
  const rows = await input.db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.scheduledLaunchId, input.scheduledLaunchId));

  return rows[0]?.id ?? null;
}

async function finalizeScheduledLaunchRun(input: {
  db: ScheduledLaunchDb;
  scheduledLaunchId: string;
  reservationId: string;
  claimId: string;
  claimFence: number;
  runId: string;
  scheduledForAt: Date;
  now: Date;
}): Promise<void> {
  const updated = await input.db
    .update(scheduledTaskLaunches)
    .set({
      state: "Launched",
      nextAttemptAt: null,
      claimId: null,
      claimFence: null,
      claimExpiresAt: null,
      claimOrigin: null,
      latestOutcome: "launched",
      errorCode: null,
      errorMessage: null,
      lateByMs: Math.max(0, input.now.getTime() - input.scheduledForAt.getTime()),
      updatedAt: input.now,
    })
    .where(
      and(
        eq(scheduledTaskLaunches.id, input.scheduledLaunchId),
        eq(scheduledTaskLaunches.state, "Dispatching"),
        eq(scheduledTaskLaunches.claimId, input.claimId),
        eq(scheduledTaskLaunches.claimFence, input.claimFence),
      ),
    )
    .returning({ id: scheduledTaskLaunches.id });

  if (updated.length === 0) {
    const current = await input.db
      .select({ state: scheduledTaskLaunches.state })
      .from(scheduledTaskLaunches)
      .where(eq(scheduledTaskLaunches.id, input.scheduledLaunchId));

    if (current[0]?.state === "Launched") return;

    throw new MaisterError(
      "CONFLICT",
      "scheduled launch changed before its Run could be finalized",
    );
  }

  await input.db
    .update(scheduledTaskLaunchAttempts)
    .set({ state: "RunLinked", updatedAt: input.now })
    .where(eq(scheduledTaskLaunchAttempts.id, input.reservationId));
  await input.db.insert(scheduledTaskLaunchEvents).values({
    id: randomUUID(),
    scheduledLaunchId: input.scheduledLaunchId,
    kind: "launched",
    actorType: "system",
    claimFence: input.claimFence,
    metadata: { runId: input.runId },
    createdAt: input.now,
  });
}

export async function dispatchClaimedScheduledLaunch(input: {
  projectId: string;
  claimId: string;
  claimFence: number;
  reservation: ScheduledLaunchReservation;
  now?: Date;
  db?: ScheduledLaunchDb;
  launch?: ScheduledLaunchRunner;
}): Promise<{
  state: "Launched" | "RetryWaiting" | "Failed";
  runId?: string;
}> {
  const db = input.db ?? (getDb() as ScheduledLaunchDb);
  const now = input.now ?? new Date();
  const launch =
    input.launch ??
    (async (launchInput, context, launchDb) => {
      const { launchRun } = await import("@/lib/services/runs");

      return launchRun(launchInput, context, launchDb);
    });

  let claimed: Awaited<ReturnType<typeof loadClaimedLaunch>> | null = null;
  let scheduledReservation: ScheduledLaunchReservation | null = null;

  try {
    claimed = await loadClaimedLaunch({
      db,
      projectId: input.projectId,
      scheduledLaunchId: input.reservation.scheduledLaunchId,
      claimId: input.claimId,
      claimFence: input.claimFence,
    });
    const reservation = await loadReservation({
      db,
      reservationId: input.reservation.id,
      scheduledLaunchId: input.reservation.scheduledLaunchId,
      taskId: claimed.taskId,
      claimFence: input.claimFence,
    });
    scheduledReservation = reservation;
    const existingRunId = await findLinkedScheduledRunId({
      db,
      scheduledLaunchId: scheduledReservation.scheduledLaunchId,
    });

    if (existingRunId) {
      await finalizeScheduledLaunchRun({
        db,
        scheduledLaunchId: scheduledReservation.scheduledLaunchId,
        reservationId: scheduledReservation.id,
        claimId: input.claimId,
        claimFence: input.claimFence,
        runId: existingRunId,
        scheduledForAt: claimed.scheduledForAt,
        now,
      });

      return { state: "Launched", runId: existingRunId };
    }

    await db
      .update(scheduledTaskLaunchAttempts)
      .set({ state: "Materialized", updatedAt: now })
      .where(eq(scheduledTaskLaunchAttempts.id, scheduledReservation.id));

    const result = await launch(
      {
        ...claimed.launchRequest,
        taskId: claimed.taskId,
        allowConcurrent: false,
        scheduledReservation,
      },
      {
        actorUserId: null,
        authorize: async () =>
          assertScheduledClaimOwner({
            db,
            scheduledLaunchId: input.reservation.scheduledLaunchId,
            claimId: input.claimId,
            claimFence: input.claimFence,
          }),
      },
      db,
    );

    if (result.runId !== scheduledReservation.runId) {
      throw new MaisterError(
        "PRECONDITION",
        "scheduled launch did not retain its reserved Run identity",
      );
    }

    await finalizeScheduledLaunchRun({
      db,
      scheduledLaunchId: scheduledReservation.scheduledLaunchId,
      reservationId: scheduledReservation.id,
      claimId: input.claimId,
      claimFence: input.claimFence,
      runId: result.runId,
      scheduledForAt: claimed.scheduledForAt,
      now,
    });

    return { state: "Launched", runId: result.runId };
  } catch (error) {
    const linkedRunId = await findLinkedScheduledRunId({
      db,
      scheduledLaunchId: input.reservation.scheduledLaunchId,
    });
    if (linkedRunId && claimed && scheduledReservation) {
      await finalizeScheduledLaunchRun({
        db,
        scheduledLaunchId: scheduledReservation.scheduledLaunchId,
        reservationId: scheduledReservation.id,
        claimId: input.claimId,
        claimFence: input.claimFence,
        runId: linkedRunId,
        scheduledForAt: claimed.scheduledForAt,
        now,
      });

      return { state: "Launched", runId: linkedRunId };
    }

    const latest = await loadClaimedLaunch({
      db,
      projectId: input.projectId,
      scheduledLaunchId: input.reservation.scheduledLaunchId,
      claimId: input.claimId,
      claimFence: input.claimFence,
    }).catch(() => null);

    if (!latest) throw error;

    const retry =
      isRetryableScheduledLaunchError(error) &&
      latest.attemptCount < latest.maxAttempts;
    const errorCode = error instanceof MaisterError ? error.code : "SPAWN";
    const state = retry ? "RetryWaiting" : "Failed";
    const nextAttemptAt = retry ? retryAt(latest.attemptCount, now) : null;

    await db
      .update(scheduledTaskLaunches)
      .set({
        state,
        nextAttemptAt,
        claimId: null,
        claimFence: null,
        claimExpiresAt: null,
        claimOrigin: null,
        latestOutcome: retry ? "retry_scheduled" : "failed",
        errorCode,
        errorMessage: retry
          ? "Scheduled launch will retry after a temporary executor failure"
          : "Scheduled launch failed and requires attention",
        updatedAt: now,
      })
      .where(
        and(
          eq(
            scheduledTaskLaunches.id,
            input.reservation.scheduledLaunchId,
          ),
          eq(scheduledTaskLaunches.state, "Dispatching"),
          eq(scheduledTaskLaunches.claimId, input.claimId),
          eq(scheduledTaskLaunches.claimFence, input.claimFence),
        ),
      );
    await db
      .update(scheduledTaskLaunchAttempts)
      .set({ state: "Failed", updatedAt: now })
      .where(eq(scheduledTaskLaunchAttempts.id, input.reservation.id));
    await db.insert(scheduledTaskLaunchEvents).values({
      id: randomUUID(),
      scheduledLaunchId: input.reservation.scheduledLaunchId,
      kind: retry ? "retry_scheduled" : "failed",
      actorType: "system",
      claimFence: input.claimFence,
      errorCode,
      message: retry
        ? "Scheduled launch will retry after a temporary executor failure"
        : "Scheduled launch failed and requires attention",
      createdAt: now,
    });

    return { state };
  }
}

export async function runScheduledLaunchNow(input: {
  projectId: string;
  scheduledLaunchId: string;
  expectedRevision: number;
  now?: Date;
  db?: ScheduledLaunchDb;
  launch?: ScheduledLaunchRunner;
}): Promise<{
  state: "Launched" | "RetryWaiting" | "Failed";
  runId?: string;
}> {
  const db = input.db ?? (getDb() as ScheduledLaunchDb);
  const claim = await claimScheduledLaunch({
    scheduledLaunchId: input.scheduledLaunchId,
    projectId: input.projectId,
    source: "run_now",
    expectedRevision: input.expectedRevision,
    now: input.now,
    db,
  });

  return dispatchClaimedScheduledLaunch({
    projectId: input.projectId,
    claimId: claim.claimId,
    claimFence: claim.claimFence,
    reservation: claim.reservation,
    now: input.now,
    db,
    launch: input.launch,
  });
}
