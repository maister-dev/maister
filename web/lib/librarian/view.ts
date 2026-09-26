import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { LibrarianMessageRow, LibrarianTurnRow } from "@/lib/db/schema";
import type { LibrarianSubject } from "./types";

import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";

import { librarianTurnRef } from "./admission";
import { lockOwnerConversation } from "./conversation";
import {
  readLibrarianSettings,
  type LibrarianAvailabilityState,
} from "./settings";

import {
  librarianConversations,
  librarianMessages,
  librarianTurns,
  runs,
  tasks,
  users,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { getVisibleProjects } from "@/lib/queries/visible-projects";

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
  update: null;
  taskChips: never[];
  usedMemoryItemIds: string[];
  createdAt: string;
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
): LibrarianMessageDto {
  return {
    id: row.id,
    seq: row.seq.toString(),
    segmentId: row.segmentId,
    authorKind: row.authorKind,
    body: row.body,
    masked: false,
    deliveryState: row.deliveryState,
    subject: (row.subject ?? null) as LibrarianSubject | null,
    turnId: row.turnId ?? null,
    card: null,
    update: null,
    taskChips: [],
    usedMemoryItemIds: [],
    createdAt: row.createdAt.toISOString(),
  };
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

/** ADR-189 D2: precedence `action_required > running > unread`. Owner cards
 * arrive with the operation ledger; until then nothing is action-required. */
export async function librarianIndicator(
  db: Db,
  conversation: { id: string; readThroughSeq: bigint | string },
): Promise<LibrarianIndicatorState> {
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
  pendingCards: never[];
  queuedMessages: LibrarianMessageDto[];
  activeTurn: LibrarianTurnDto | null;
  pendingOperations: never[];
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
    pendingCards: [],
    queuedMessages: queued.map(librarianMessageDto),
    activeTurn: active
      ? librarianTurnDto(active, activeRef?.queuePosition ?? null)
      : null,
    pendingOperations: [],
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
