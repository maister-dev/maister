import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { LibrarianMessageRow, LibrarianTurnRow } from "@/lib/db/schema";
import type { LibrarianSubject } from "./types";

import { and, asc, desc, eq, gt, inArray, or } from "drizzle-orm";

import { librarianTurnRef } from "./admission";
import { lockOwnerConversation } from "./conversation";
import {
  readLibrarianSettings,
  type LibrarianAvailabilityState,
} from "./settings";
import {
  getLinkedWork,
  type LibrarianCardView,
  type LibrarianOperationView,
  type LibrarianRelatedTaskView,
} from "./read-models";

import {
  librarianConversations,
  librarianCards,
  librarianContextSnapshots,
  librarianMemoryItems,
  librarianMessages,
  librarianUpdates,
  librarianTurns,
  domainEvents,
  projects,
  runs,
  tasks,
  users,
  workspaces,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { getVisibleProjects } from "@/lib/queries/visible-projects";
import {
  deriveWorkStage,
  type WorkStage,
  type PromotedKind,
} from "@/lib/work/stage";

// ADR-183 / web.openapi.yaml: explicit DTO projections — never a row.

export type LibrarianIndicatorState =
  | "none"
  | "running"
  | "unread"
  | "action_required";

export type LibrarianMessageDto = {
  id: string;
  seq: string;
  segmentId: string;
  authorKind: LibrarianMessageRow["authorKind"];
  body: string | null;
  masked: boolean;
  deliveryState: LibrarianMessageRow["deliveryState"];
  subject: LibrarianSubject | null;
  turnId: string | null;
  card: null;
  update: LibrarianUpdateDto | null;
  taskChips: never[];
  usedMemoryItemIds: string[];
  createdAt: string;
};

export type LibrarianUpdateDto = {
  updateId: string;
  eventKind: string;
  task: {
    taskId: string;
    available: boolean;
    taskKey: string | null;
    title: string | null;
    projectSlug: string | null;
    status: string | null;
    workStage: WorkStage | null;
  } | null;
  runId: string | null;
  runStatus: string | null;
  workStage: WorkStage | null;
  promotedKind: PromotedKind | null;
  occurredAt: string;
};

export type LibrarianTurnDto = {
  id: string;
  variant: LibrarianTurnRow["variant"];
  status: LibrarianTurnRow["status"];
  failureReason: string | null;
  queuePosition: number | null;
  messageId: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  deadlineAt: string | null;
};

export function librarianMessageDto(
  row: LibrarianMessageRow,
  options: {
    masked?: boolean;
    update?: LibrarianUpdateDto | null;
    usedMemoryItemIds?: string[];
  } = {},
): LibrarianMessageDto {
  return {
    id: row.id,
    seq: row.seq.toString(),
    segmentId: row.segmentId,
    authorKind: row.authorKind,
    body: options.masked ? null : row.body,
    masked: options.masked ?? false,
    deliveryState: row.deliveryState,
    subject: (row.subject ?? null) as LibrarianSubject | null,
    turnId: row.turnId ?? null,
    card: null,
    update: options.masked ? null : (options.update ?? null),
    taskChips: [],
    usedMemoryItemIds: options.masked ? [] : (options.usedMemoryItemIds ?? []),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Re-checks project visibility on every page read, including old updates. */
export async function librarianMessageDtos(
  rows: LibrarianMessageRow[],
  ownerId: string,
  db: Db,
): Promise<LibrarianMessageDto[]> {
  const [owner] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, ownerId));
  const visible = owner
    ? await getVisibleProjects(ownerId, owner.role, db)
    : [];
  const visibleIds = new Set(visible.map((project) => project.id));
  const visibleSlugs = new Map(
    visible.map((project) => [project.id, project.slug]),
  );
  const replyTurnIds = rows
    .filter((row) => row.authorKind === "librarian" && row.turnId)
    .map((row) => row.turnId!);
  const snapshots =
    replyTurnIds.length > 0
      ? await db
          .select({
            turnId: librarianContextSnapshots.turnId,
            memoryItemRevisions: librarianContextSnapshots.memoryItemRevisions,
          })
          .from(librarianContextSnapshots)
          .where(inArray(librarianContextSnapshots.turnId, replyTurnIds))
      : [];
  const snapshotByTurnId = new Map(
    snapshots.map((snapshot) => [snapshot.turnId, snapshot]),
  );
  const referencedMemoryIds = [
    ...new Set(
      snapshots.flatMap((snapshot) =>
        Object.keys(snapshot.memoryItemRevisions),
      ),
    ),
  ];
  const memoryRows =
    referencedMemoryIds.length > 0
      ? await db
          .select({
            id: librarianMemoryItems.id,
            forgottenAt: librarianMemoryItems.forgottenAt,
            sourceProjectIds: librarianMemoryItems.sourceProjectIds,
          })
          .from(librarianMemoryItems)
          .where(inArray(librarianMemoryItems.id, referencedMemoryIds))
      : [];
  const visibleMemoryIds = new Set(
    memoryRows
      .filter(
        (item) =>
          item.forgottenAt === null &&
          item.sourceProjectIds.every((id) => visibleIds.has(id)),
      )
      .map((item) => item.id),
  );
  const updateIds = rows
    .map((row) => row.updateId)
    .filter((id): id is string => !!id);
  const updates =
    updateIds.length > 0
      ? await db
          .select()
          .from(librarianUpdates)
          .where(inArray(librarianUpdates.id, updateIds))
      : [];
  const updateById = new Map(updates.map((update) => [update.id, update]));
  const taskIds = updates
    .map((update) => update.taskId)
    .filter((id): id is string => !!id);
  const runIds = updates
    .map((update) => update.runId)
    .filter((id): id is string => !!id);
  const [taskRows, runRows, projectRows, eventRows] = await Promise.all([
    taskIds.length > 0
      ? db
          .select({
            id: tasks.id,
            projectId: tasks.projectId,
            number: tasks.number,
            title: tasks.title,
            status: tasks.status,
            stage: tasks.stage,
            triageStatus: tasks.triageStatus,
          })
          .from(tasks)
          .where(inArray(tasks.id, taskIds))
      : Promise.resolve([]),
    runIds.length > 0 || taskIds.length > 0
      ? db
          .select({
            id: runs.id,
            taskId: runs.taskId,
            status: runs.status,
            runKind: runs.runKind,
            startedAt: runs.startedAt,
          })
          .from(runs)
          .where(or(inArray(runs.taskId, taskIds), inArray(runs.id, runIds)))
          .orderBy(desc(runs.startedAt))
      : Promise.resolve([]),
    visible.length > 0
      ? db
          .select({ id: projects.id, taskKey: projects.taskKey })
          .from(projects)
          .where(
            inArray(
              projects.id,
              visible.map((project) => project.id),
            ),
          )
      : Promise.resolve([]),
    updates.length > 0
      ? db
          .select({ id: domainEvents.id, occurredAt: domainEvents.occurredAt })
          .from(domainEvents)
          .where(
            inArray(
              domainEvents.id,
              updates.map((update) => update.domainEventId),
            ),
          )
      : Promise.resolve([]),
  ]);
  const taskById = new Map(taskRows.map((task) => [task.id, task]));
  const runById = new Map(runRows.map((run) => [run.id, run]));
  const latestRunByTaskId = new Map<string, (typeof runRows)[number]>();

  for (const run of runRows) {
    if (run.taskId && !latestRunByTaskId.has(run.taskId))
      latestRunByTaskId.set(run.taskId, run);
  }
  const runIdsForWorkspace = runRows.map((run) => run.id);
  const workspaceRows =
    runIdsForWorkspace.length > 0
      ? await db
          .select({
            runId: workspaces.runId,
            promotionState: workspaces.promotionState,
            removedAt: workspaces.removedAt,
          })
          .from(workspaces)
          .where(inArray(workspaces.runId, runIdsForWorkspace))
      : [];
  const workspaceByRunId = new Map(
    workspaceRows.map((workspace) => [workspace.runId, workspace]),
  );
  const keyByProjectId = new Map(
    projectRows.map((project) => [project.id, project.taskKey]),
  );
  const occurredAtByEventId = new Map(
    eventRows.map((event) => [event.id, event.occurredAt]),
  );

  return rows.map((row) => {
    const masked =
      row.authorKind !== "owner" &&
      row.sourceProjectIds.some((projectId) => !visibleIds.has(projectId));
    const update = row.updateId ? updateById.get(row.updateId) : null;
    const task = update?.taskId ? taskById.get(update.taskId) : null;
    const slug = task ? visibleSlugs.get(task.projectId) : null;
    const run = update?.runId
      ? runById.get(update.runId)
      : task
        ? latestRunByTaskId.get(task.id)
        : null;
    const workspace = run ? workspaceByRunId.get(run.id) : null;
    const stage = task
      ? deriveWorkStage({
          taskStatus: task.status,
          taskStage: task.stage,
          triageStatus: task.triageStatus,
          runStatus: run?.status ?? null,
          runKind: run?.runKind ?? null,
          promotionState: workspace?.promotionState ?? null,
          workspaceRemoved: !!workspace?.removedAt,
          blockingRelationCount: 0,
          openBlockingClarificationCount: 0,
          progress: null,
        })
      : null;
    const projectKey = task ? keyByProjectId.get(task.projectId) : null;

    return librarianMessageDto(row, {
      masked,
      usedMemoryItemIds: row.turnId
        ? Object.keys(
            snapshotByTurnId.get(row.turnId)?.memoryItemRevisions ?? {},
          ).filter((id) => visibleMemoryIds.has(id))
        : [],
      update:
        update && !masked
          ? {
              updateId: update.id,
              eventKind: update.kind,
              task: task
                ? {
                    taskId: task.id,
                    available: !!slug,
                    taskKey: projectKey ? `${projectKey}-${task.number}` : null,
                    title: slug ? task.title : null,
                    projectSlug: slug ?? null,
                    status: slug ? task.status : null,
                    workStage: slug ? (stage?.stage ?? null) : null,
                  }
                : null,
              runId: run?.id ?? null,
              runStatus: run?.status ?? null,
              workStage: stage?.stage ?? null,
              promotedKind: stage?.promotedKind ?? null,
              occurredAt:
                occurredAtByEventId.get(update.domainEventId)?.toISOString() ??
                update.createdAt.toISOString(),
            }
          : null,
    });
  });
}

export function librarianTurnDto(
  row: LibrarianTurnRow,
  queuePosition: number | null,
): LibrarianTurnDto {
  return {
    id: row.id,
    variant: row.variant,
    status: row.status,
    failureReason: row.failureReason ?? null,
    queuePosition,
    messageId: row.messageId ?? null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    deadlineAt: row.deadlineAt?.toISOString() ?? null,
  };
}

/** ADR-189 D2: pending owner confirmations precede running and unread state. */
export async function librarianIndicator(
  db: Db,
  conversation: { id: string; readThroughSeq: bigint | string },
): Promise<LibrarianIndicatorState> {
  const [pendingCard] = await db
    .select({ id: librarianCards.id })
    .from(librarianCards)
    .where(
      and(
        eq(librarianCards.conversationId, conversation.id),
        eq(librarianCards.status, "pending"),
        gt(librarianCards.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (pendingCard) return "action_required";
  const [active] = await db
    .select({ id: librarianTurns.id })
    .from(librarianTurns)
    .where(
      and(
        eq(librarianTurns.conversationId, conversation.id),
        inArray(librarianTurns.status, ["admitted", "running"]),
      ),
    )
    .limit(1);

  if (active) return "running";
  const [unread] = await db
    .select({ id: librarianMessages.id })
    .from(librarianMessages)
    .where(
      and(
        eq(librarianMessages.conversationId, conversation.id),
        gt(librarianMessages.seq, BigInt(conversation.readThroughSeq)),
        inArray(librarianMessages.authorKind, [
          "librarian",
          "update",
          "system",
        ]),
      ),
    )
    .limit(1);

  return unread ? "unread" : "none";
}

/** ADR-189 D2: the layout's read. It never creates a conversation — a user
 * who has not opened the librarian simply has no indicator. */
export async function readLibrarianIndicator(
  ownerId: string,
  db: Db,
): Promise<LibrarianIndicatorState> {
  const [conversation] = await db
    .select({
      id: librarianConversations.id,
      readThroughSeq: librarianConversations.readThroughSeq,
    })
    .from(librarianConversations)
    .where(eq(librarianConversations.userId, ownerId))
    .limit(1);

  return conversation ? librarianIndicator(db, conversation) : "none";
}

export type LibrarianConversationView = {
  conversation: {
    id: string;
    runId: string | null;
    resetState: string;
    readThroughSeq: string;
    lastSeq: string;
    memoryEnabledNextSegment: boolean;
    createdAt: string;
  };
  segment: { id: string; ordinal: number; startedAt: string };
  indicator: { state: LibrarianIndicatorState };
  availability: { state: LibrarianAvailabilityState };
  pendingCards: LibrarianCardView[];
  cards: LibrarianCardView[];
  operationReceipts: LibrarianOperationView[];
  relatedWork: LibrarianRelatedTaskView[];
  queuedMessages: LibrarianMessageDto[];
  activeTurn: LibrarianTurnDto | null;
  pendingOperations: LibrarianOperationView[];
};

/** One read that lets the panel resume after navigation or a reload. The
 * conversation is created by the first call; the owner is the caller. */
export async function getLibrarianConversationView(
  ownerId: string,
  db: Db,
): Promise<LibrarianConversationView> {
  const { conversation, segment } = await db.transaction((tx) =>
    lockOwnerConversation(tx, ownerId),
  );
  const settings = await readLibrarianSettings(db);
  const queued = await db
    .select()
    .from(librarianMessages)
    .where(
      and(
        eq(librarianMessages.conversationId, conversation.id),
        eq(librarianMessages.deliveryState, "queued"),
      ),
    )
    .orderBy(asc(librarianMessages.seq));
  const [active] = await db
    .select()
    .from(librarianTurns)
    .where(
      and(
        eq(librarianTurns.conversationId, conversation.id),
        inArray(librarianTurns.status, ["admitted", "running"]),
      ),
    )
    .limit(1);
  const activeRef = active ? await librarianTurnRef(db, active) : null;
  const linkedWork = await getLinkedWork(
    ownerId,
    db as unknown as ReturnType<typeof import("@/lib/db/client").getDb>,
  );

  return {
    conversation: {
      id: conversation.id,
      runId: conversation.runId ?? null,
      resetState: conversation.resetState,
      readThroughSeq: conversation.readThroughSeq.toString(),
      lastSeq: conversation.lastSeq.toString(),
      memoryEnabledNextSegment: conversation.memoryEnabledNextSegment,
      createdAt: conversation.createdAt.toISOString(),
    },
    segment: {
      id: segment.id,
      ordinal: segment.ordinal,
      startedAt: segment.startedAt.toISOString(),
    },
    indicator: { state: await librarianIndicator(db, conversation) },
    availability: { state: settings.availability },
    pendingCards: linkedWork.cards.filter((card) => card.status === "pending"),
    cards: linkedWork.cards,
    operationReceipts: linkedWork.operations,
    relatedWork: linkedWork.tasks,
    queuedMessages: queued.map((row) => librarianMessageDto(row)),
    activeTurn: active
      ? librarianTurnDto(active, activeRef?.queuePosition ?? null)
      : null,
    pendingOperations: linkedWork.operations.filter(
      (operation) =>
        operation.status === "admitted" || operation.status === "unknown",
    ),
  };
}

export async function setMemoryEnabledNextSegment(
  ownerId: string,
  enabled: boolean,
  db: Db,
): Promise<void> {
  await db.transaction(async (tx) => {
    const { conversation } = await lockOwnerConversation(tx, ownerId);

    await tx
      .update(librarianConversations)
      .set({ memoryEnabledNextSegment: enabled, updatedAt: new Date() })
      .where(eq(librarianConversations.id, conversation.id));
  });
}

/** D16: every id in a subject is visibility-checked against the owner; a
 * foreign or unknown one is refused as not found. */
export async function assertSubjectVisible(
  ownerId: string,
  subject: LibrarianSubject | null,
  db: Db,
): Promise<void> {
  if (!subject) return;
  const [owner] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, ownerId));
  const visible = owner
    ? await getVisibleProjects(ownerId, owner.role, db as never)
    : [];
  const visibleIds = new Set(visible.map((project) => project.id));
  const notFound = () =>
    new MaisterError("PRECONDITION", "Subject not found", {
      details: { reason: "not_found" },
    });

  if (
    subject.projectSlug &&
    !visible.some((project) => project.slug === subject.projectSlug)
  )
    throw notFound();
  if (subject.taskIds?.length) {
    const found = await db
      .select({ id: tasks.id, projectId: tasks.projectId })
      .from(tasks)
      .where(inArray(tasks.id, subject.taskIds));

    if (
      found.length !== new Set(subject.taskIds).size ||
      found.some((task) => !visibleIds.has(task.projectId))
    )
      throw notFound();
  }
  if (subject.runId) {
    const [run] = await db
      .select({ projectId: runs.projectId })
      .from(runs)
      .where(eq(runs.id, subject.runId));

    if (!run?.projectId || !visibleIds.has(run.projectId)) throw notFound();
  }
}

export async function loadLatestTurn(
  db: Db,
  conversationId: string,
): Promise<LibrarianTurnRow | null> {
  const [row] = await db
    .select()
    .from(librarianTurns)
    .where(eq(librarianTurns.conversationId, conversationId))
    .orderBy(desc(librarianTurns.createdAt))
    .limit(1);

  return row ?? null;
}
