import "server-only";

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { requireProjectActionForUser } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import {
  inboxItems,
  librarianConversations,
  librarianMessages,
  taskClarifications,
  tasks,
  users,
  type TaskClarificationRow,
} from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { MaisterError } from "@/lib/errors";
import { recordTaskActivity } from "@/lib/social/activity";
import { subscribe } from "@/lib/social/subscriptions";
import {
  MAX_CLARIFICATION_ANSWER_CHARS,
  MAX_CLARIFICATION_QUESTION_CHARS,
} from "@/lib/tasks/clarifications";

type Db = ReturnType<typeof getDb>;

const log = pino({
  name: "task-clarification-requests",
  level: process.env.LOG_LEVEL ?? "info",
});

export const clarificationRequestSchema = z
  .object({
    recipientUserId: z.string().uuid(),
    question: z.string().trim().min(1).max(MAX_CLARIFICATION_QUESTION_CHARS),
    reason: z.string().trim().min(1).max(2_000),
    answerFormat: z.enum(["text", "choice", "yes_no"]),
    blocking: z.boolean(),
  })
  .strict();

export type ClarificationRequestInput = z.infer<
  typeof clarificationRequestSchema
>;

type ClarificationReceipt = {
  clarificationId: string;
  taskId: string;
  seq: number;
  status: "open";
};

function notOpen(clarificationId: string): MaisterError {
  return new MaisterError("CONFLICT", "clarification is no longer open", {
    details: { reason: "clarification_not_open", clarificationId },
  });
}

async function requireTask(db: Db, taskId: string) {
  const [task] = await db
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      status: tasks.status,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .for("update");

  if (!task) throw new MaisterError("PRECONDITION", "task is unavailable");

  return task;
}

async function lockActiveUser(db: Db, userId: string): Promise<void> {
  const [user] = await db
    .select({ status: users.accountStatus })
    .from(users)
    .where(eq(users.id, userId))
    .for("update");

  if (user?.status !== "active") {
    throw new MaisterError(
      "ACCOUNT_INACTIVE",
      "clarification recipient is not active",
    );
  }
}

async function validateSourceMessage(
  db: Db,
  sourceMessageId: string | null,
  requesterUserId: string,
): Promise<void> {
  if (sourceMessageId === null) return;
  const [source] = await db
    .select({ id: librarianMessages.id })
    .from(librarianMessages)
    .innerJoin(
      librarianConversations,
      eq(librarianMessages.conversationId, librarianConversations.id),
    )
    .where(
      and(
        eq(librarianMessages.id, sourceMessageId),
        eq(librarianConversations.userId, requesterUserId),
      ),
    );

  if (!source)
    throw new MaisterError("PRECONDITION", "source message is unavailable");
}

async function insertRequest(
  db: Db,
  input: {
    taskId: string;
    projectId: string;
    requesterUserId: string;
    sourceMessageId: string | null;
    viaOperationId: string | null;
    request: ClarificationRequestInput;
  },
): Promise<ClarificationReceipt> {
  const [sequence] = await db
    .select({
      max: sql<number>`coalesce(max(${taskClarifications.seq}), 0)`,
    })
    .from(taskClarifications)
    .where(eq(taskClarifications.taskId, input.taskId));
  const seq = Number(sequence.max) + 1;
  const [created] = await db
    .insert(taskClarifications)
    .values({
      taskId: input.taskId,
      seq,
      originKind: "user",
      reTriggerMode: "none",
      question: input.request.question,
      requesterUserId: input.requesterUserId,
      recipientUserId: input.request.recipientUserId,
      reason: input.request.reason,
      answerFormat: input.request.answerFormat,
      blocking: input.request.blocking,
      sourceMessageId: input.sourceMessageId,
      requestedViaOperationId: input.viaOperationId,
      status: "open",
    })
    .returning({ id: taskClarifications.id });
  const actor = { type: "user" as const, id: input.requesterUserId };
  const payload = {
    clarificationId: created.id,
    originKind: "user",
    requesterUserId: input.requesterUserId,
    recipientUserId: input.request.recipientUserId,
    blocking: input.request.blocking,
  };
  const activityId = await recordTaskActivity(db, {
    taskId: input.taskId,
    projectId: input.projectId,
    actor,
    eventKind: "clarification_requested",
    payload,
  });

  await db.insert(inboxItems).values({
    recipientType: "user",
    recipientId: input.request.recipientUserId,
    projectId: input.projectId,
    taskId: input.taskId,
    eventKind: "clarification_requested",
    sourceRef: {
      kind: "clarification",
      taskId: input.taskId,
      clarificationId: created.id,
      activityId,
    },
  });
  await subscribe(db, {
    taskId: input.taskId,
    subscriber: { type: "user", id: input.requesterUserId },
    reason: "manual",
  });
  await subscribe(db, {
    taskId: input.taskId,
    subscriber: { type: "user", id: input.request.recipientUserId },
    reason: "manual",
  });
  await emitDomainEvent({
    db,
    kind: "task.clarification_requested",
    projectId: input.projectId,
    taskId: input.taskId,
    actor,
    payload,
  });

  return {
    clarificationId: created.id,
    taskId: input.taskId,
    seq,
    status: "open",
  };
}

export async function requestClarification(
  input: {
    taskId: string;
    requesterUserId: string;
    sourceMessageId?: string | null;
    viaOperationId?: string | null;
    request: ClarificationRequestInput;
    recordCreated?: (db: Db, receipt: ClarificationReceipt) => Promise<void>;
  },
  db: Db = getDb(),
): Promise<ClarificationReceipt> {
  const request = clarificationRequestSchema.parse(input.request);

  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const task = await requireTask(scoped, input.taskId);

    if (task.status !== "Backlog") {
      throw new MaisterError(
        "PRECONDITION",
        "clarifications can only be requested before task execution",
      );
    }
    await requireProjectActionForUser(
      input.requesterUserId,
      task.projectId,
      "editTask",
    );
    await lockActiveUser(scoped, request.recipientUserId);
    await requireProjectActionForUser(
      request.recipientUserId,
      task.projectId,
      "answerHitl",
    );
    await validateSourceMessage(
      scoped,
      input.sourceMessageId ?? null,
      input.requesterUserId,
    );

    const receipt = await insertRequest(scoped, {
      taskId: task.id,
      projectId: task.projectId,
      requesterUserId: input.requesterUserId,
      sourceMessageId: input.sourceMessageId ?? null,
      viaOperationId: input.viaOperationId ?? null,
      request,
    });

    await input.recordCreated?.(scoped, receipt);
    log.info(
      {
        clarificationId: receipt.clarificationId,
        taskId: task.id,
        status: "open",
      },
      "clarification requested",
    );

    return receipt;
  });
}

function validatedAnswer(
  format: TaskClarificationRow["answerFormat"],
  value: unknown,
): string | boolean {
  if (format === "yes_no") {
    if (typeof value !== "boolean")
      throw new MaisterError(
        "CONFIG",
        "yes/no clarification requires a boolean answer",
      );

    return value;
  }
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_CLARIFICATION_ANSWER_CHARS
  ) {
    throw new MaisterError(
      "CONFIG",
      "clarification answer must be non-empty text within the size limit",
    );
  }

  return value.trim();
}

export async function answerClarification(
  input: {
    taskId: string;
    clarificationId: string;
    recipientUserId: string;
    answer: unknown;
    recordAnswered?: (
      db: Db,
      receipt: { clarificationId: string; status: "answered" },
    ) => Promise<void>;
  },
  db: Db = getDb(),
): Promise<{ clarificationId: string; status: "answered" }> {
  return db.transaction(async (tx) => {
    await lockActiveUser(tx as unknown as Db, input.recipientUserId);
    const [row] = await tx
      .select()
      .from(taskClarifications)
      .where(
        and(
          eq(taskClarifications.id, input.clarificationId),
          eq(taskClarifications.taskId, input.taskId),
        ),
      )
      .for("update");

    if (!row || row.originKind !== "user")
      throw new MaisterError("PRECONDITION", "clarification is unavailable");
    if (row.recipientUserId !== input.recipientUserId)
      throw new MaisterError(
        "UNAUTHORIZED",
        "only the addressed recipient can answer this clarification",
      );
    if (row.status !== "open") throw notOpen(row.id);
    const [task] = await tx
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, row.taskId));

    if (!task) throw new MaisterError("PRECONDITION", "task is unavailable");
    await requireProjectActionForUser(
      input.recipientUserId,
      task.projectId,
      "answerHitl",
    );
    const answer = validatedAnswer(row.answerFormat, input.answer);
    const [updated] = await tx
      .update(taskClarifications)
      .set({
        answer,
        answeredByUserId: input.recipientUserId,
        answeredAt: new Date(),
        status: "answered",
      })
      .where(
        and(
          eq(taskClarifications.id, row.id),
          eq(taskClarifications.status, "open"),
        ),
      )
      .returning({ id: taskClarifications.id });

    if (!updated) throw notOpen(row.id);
    const actor = { type: "user" as const, id: input.recipientUserId };
    const payload = {
      clarificationId: row.id,
      originKind: "user",
      requesterUserId: row.requesterUserId,
      recipientUserId: input.recipientUserId,
      blocking: row.blocking,
    };

    await recordTaskActivity(tx, {
      taskId: row.taskId,
      projectId: task.projectId,
      actor,
      eventKind: "clarification_answered",
      payload,
    });
    await emitDomainEvent({
      db: tx,
      kind: "task.clarification_answered",
      projectId: task.projectId,
      taskId: row.taskId,
      actor,
      payload,
    });
    const receipt = { clarificationId: row.id, status: "answered" as const };

    await input.recordAnswered?.(tx as unknown as Db, receipt);
    log.info(
      { clarificationId: row.id, taskId: row.taskId, status: "answered" },
      "clarification answered",
    );

    return receipt;
  });
}

export async function cancelClarification(
  input: {
    taskId: string;
    clarificationId: string;
    actorUserId: string;
    recordCancelled?: (
      db: Db,
      receipt: { clarificationId: string; status: "cancelled" },
    ) => Promise<void>;
  },
  db: Db = getDb(),
): Promise<{ clarificationId: string; status: "cancelled" }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(taskClarifications)
      .where(
        and(
          eq(taskClarifications.id, input.clarificationId),
          eq(taskClarifications.taskId, input.taskId),
        ),
      )
      .for("update");

    if (!row || row.originKind !== "user")
      throw new MaisterError("PRECONDITION", "clarification is unavailable");
    if (row.status !== "open") throw notOpen(row.id);
    const [task] = await tx
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, row.taskId));

    if (!task) throw new MaisterError("PRECONDITION", "task is unavailable");
    await requireProjectActionForUser(
      input.actorUserId,
      task.projectId,
      row.requesterUserId === input.actorUserId ? "readBoard" : "manageMembers",
    );
    await tx
      .update(taskClarifications)
      .set({
        status: "cancelled",
        cancelReason: "requester_cancelled",
      })
      .where(eq(taskClarifications.id, row.id));
    const actor = { type: "user" as const, id: input.actorUserId };
    const payload = {
      clarificationId: row.id,
      originKind: "user",
      cause: "requester_cancelled",
    };

    await recordTaskActivity(tx, {
      taskId: row.taskId,
      projectId: task.projectId,
      actor,
      eventKind: "clarification_cancelled",
      payload,
    });
    await emitDomainEvent({
      db: tx,
      kind: "task.clarification_cancelled",
      projectId: task.projectId,
      taskId: row.taskId,
      actor,
      payload,
    });
    const receipt = { clarificationId: row.id, status: "cancelled" as const };

    await input.recordCancelled?.(tx as unknown as Db, receipt);
    log.info(
      { clarificationId: row.id, taskId: row.taskId, status: "cancelled" },
      "clarification cancelled",
    );

    return receipt;
  });
}

export async function supersedeClarification(
  input: {
    taskId: string;
    clarificationId: string;
    requesterUserId: string;
    request: ClarificationRequestInput;
  },
  db: Db = getDb(),
): Promise<ClarificationReceipt> {
  const request = clarificationRequestSchema.parse(input.request);

  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const task = await requireTask(scoped, input.taskId);

    if (task.status !== "Backlog") {
      throw new MaisterError(
        "PRECONDITION",
        "clarification correction requires a Backlog task",
      );
    }
    const [prior] = await tx
      .select()
      .from(taskClarifications)
      .where(
        and(
          eq(taskClarifications.id, input.clarificationId),
          eq(taskClarifications.taskId, task.id),
        ),
      )
      .for("update");

    if (!prior || prior.originKind !== "user") {
      throw new MaisterError("PRECONDITION", "clarification is unavailable");
    }
    if (prior.requesterUserId !== input.requesterUserId) {
      throw new MaisterError(
        "UNAUTHORIZED",
        "only the requester can correct this clarification",
      );
    }
    if (prior.status !== "open" && prior.status !== "answered")
      throw notOpen(prior.id);
    await requireProjectActionForUser(
      input.requesterUserId,
      task.projectId,
      "editTask",
    );
    await lockActiveUser(scoped, request.recipientUserId);
    await requireProjectActionForUser(
      request.recipientUserId,
      task.projectId,
      "answerHitl",
    );
    const successor = await insertRequest(scoped, {
      taskId: task.id,
      projectId: task.projectId,
      requesterUserId: input.requesterUserId,
      sourceMessageId: prior.sourceMessageId,
      viaOperationId: null,
      request,
    });

    await tx
      .update(taskClarifications)
      .set({
        status: "superseded",
        supersededAt: new Date(),
        supersededByClarificationId: successor.clarificationId,
      })
      .where(eq(taskClarifications.id, prior.id));
    log.info(
      { clarificationId: prior.id, taskId: task.id, status: "superseded" },
      "clarification corrected",
    );

    return successor;
  });
}

async function cancelMatchingOpenClarifications(
  db: Db,
  selector: SQL,
  cause:
    | "recipient_deactivated"
    | "recipient_access_removed"
    | "task_abandoned",
): Promise<number> {
  const rows = await db
    .select({
      id: taskClarifications.id,
      taskId: taskClarifications.taskId,
      projectId: tasks.projectId,
      blocking: taskClarifications.blocking,
    })
    .from(taskClarifications)
    .innerJoin(tasks, eq(tasks.id, taskClarifications.taskId))
    .where(
      and(
        eq(taskClarifications.originKind, "user"),
        eq(taskClarifications.status, "open"),
        selector,
      ),
    )
    .for("update", { of: taskClarifications });

  for (const row of rows) {
    const [updated] = await db
      .update(taskClarifications)
      .set({
        status: "cancelled",
        cancelReason: cause,
      })
      .where(
        and(
          eq(taskClarifications.id, row.id),
          eq(taskClarifications.status, "open"),
        ),
      )
      .returning({ id: taskClarifications.id });

    if (!updated) continue;
    const actor = { type: "system" as const, id: null };
    const payload = {
      clarificationId: row.id,
      originKind: "user",
      cause,
      blocking: row.blocking,
    };

    await recordTaskActivity(db, {
      taskId: row.taskId,
      projectId: row.projectId,
      actor,
      eventKind: "clarification_cancelled",
      payload,
    });
    await emitDomainEvent({
      db,
      kind: "task.clarification_cancelled",
      projectId: row.projectId,
      taskId: row.taskId,
      actor,
      payload,
    });
    log.info(
      { clarificationId: row.id, cause },
      "clarification cancelled by cascade",
    );
  }

  return rows.length;
}

export function cancelClarificationsForDeactivatedRecipient(
  db: Db,
  recipientUserId: string,
): Promise<number> {
  return cancelMatchingOpenClarifications(
    db,
    eq(taskClarifications.recipientUserId, recipientUserId),
    "recipient_deactivated",
  );
}

export function cancelClarificationsForRecipientWithoutProjectAccess(
  db: Db,
  recipientUserId: string,
  projectId: string,
): Promise<number> {
  return cancelMatchingOpenClarifications(
    db,
    and(
      eq(taskClarifications.recipientUserId, recipientUserId),
      eq(tasks.projectId, projectId),
    )!,
    "recipient_access_removed",
  );
}

export function cancelClarificationsForAbandonedTasks(
  db: Db,
  taskIds: string[],
): Promise<number> {
  if (taskIds.length === 0) return Promise.resolve(0);

  return cancelMatchingOpenClarifications(
    db,
    inArray(taskClarifications.taskId, taskIds),
    "task_abandoned",
  );
}
