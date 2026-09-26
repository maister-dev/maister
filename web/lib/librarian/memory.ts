import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { LibrarianMemoryItemRow } from "@/lib/db/schema";

import { createHash } from "node:crypto";

import { and, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import {
  librarianContextSnapshots,
  librarianConversations,
  librarianMemoryItemRevisions,
  librarianMemoryItems,
  librarianMemoryTombstones,
  librarianSegmentSummaries,
  librarianSegments,
  librarianTurns,
  projects,
  users,
  tokenAuditLog,
} from "@/lib/db/schema";
import { lockOwnerConversation } from "@/lib/librarian/conversation";
import { MaisterError } from "@/lib/errors";
import { getVisibleProjectIds } from "@/lib/queries/visible-projects";

const log = pino({
  name: "librarian.memory",
  level: process.env.LOG_LEVEL ?? "info",
});

export const memoryDraftSchema = z
  .object({
    kind: z.enum(["preference", "goal", "commitment", "fact"]),
    content: z.string().trim().min(1).max(2000),
    scope: z.enum(["general", "project"]),
    projectSlug: z.string().min(1).optional(),
    validUntil: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.scope === "project") !== !!value.projectSlug)
      context.addIssue({
        code: "custom",
        path: ["projectSlug"],
        message: "projectSlug is required only for project scope",
      });
  });

export const memoryPatchSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    kind: z.enum(["preference", "goal", "commitment", "fact"]).optional(),
    content: z.string().trim().min(1).max(2000).optional(),
    validUntil: z.string().datetime().nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.kind !== undefined ||
      value.content !== undefined ||
      value.validUntil !== undefined,
    {
      message: "at least one memory field must change",
    },
  );

export type MemoryDraft = z.infer<typeof memoryDraftSchema>;
export type MemoryPatch = z.infer<typeof memoryPatchSchema>;

export type MemoryItemView = {
  id: string;
  kind: LibrarianMemoryItemRow["kind"];
  content: string;
  scope: LibrarianMemoryItemRow["scope"];
  projectSlug: string | null;
  origin: LibrarianMemoryItemRow["origin"];
  validUntil: string | null;
  revision: number;
  excludedReason: "expired" | "source_unavailable" | null;
  createdAt: string;
  updatedAt: string;
};

export function memoryContentDigest(content: string): string {
  const normalized = content
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ");

  return createHash("sha256").update(normalized).digest("hex");
}

function unavailable(): MaisterError {
  return new MaisterError("PRECONDITION", "memory item not found", {
    details: { reason: "not_found" },
  });
}

async function visibleProjectIds(tx: Db, ownerId: string): Promise<string[]> {
  const [owner] = await tx
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, ownerId));

  return owner ? getVisibleProjectIds(ownerId, owner.role, tx) : [];
}

export async function projectForDraft(
  tx: Db,
  ownerId: string,
  draft: MemoryDraft,
): Promise<string | null> {
  if (draft.scope === "general") return null;
  const [project] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, draft.projectSlug!));
  const visible = await visibleProjectIds(tx, ownerId);

  if (!project || !visible.includes(project.id)) throw unavailable();

  return project.id;
}

export async function assertMemorySuggestionNotForgotten(
  tx: Db,
  ownerId: string,
  content: string,
): Promise<void> {
  const [tombstone] = await tx
    .select({ contentDigest: librarianMemoryTombstones.contentDigest })
    .from(librarianMemoryTombstones)
    .where(
      and(
        eq(librarianMemoryTombstones.userId, ownerId),
        eq(
          librarianMemoryTombstones.contentDigest,
          memoryContentDigest(content),
        ),
      ),
    );

  if (tombstone)
    throw new MaisterError(
      "CONFLICT",
      "a forgotten memory cannot be suggested again",
      {
        details: { reason: "forgotten_memory" },
      },
    );
}

export async function assertMemoryTurnFence(
  tx: Db,
  ownerId: string,
  turnId: string,
): Promise<{
  conversationId: string;
  segmentId: string;
  messageId: string | null;
}> {
  const { conversation } = await lockOwnerConversation(tx, ownerId);
  const [turn] = await tx
    .select()
    .from(librarianTurns)
    .where(
      and(
        eq(librarianTurns.id, turnId),
        eq(librarianTurns.conversationId, conversation.id),
      ),
    );
  const [snapshot] = turn?.contextSnapshotId
    ? await tx
        .select({ contextEpoch: librarianContextSnapshots.contextEpoch })
        .from(librarianContextSnapshots)
        .where(eq(librarianContextSnapshots.id, turn.contextSnapshotId))
    : [];

  if (turn?.variant !== "owner_message" || turn.status !== "running")
    throw new MaisterError(
      "UNAUTHORIZED",
      "only an owner-message turn can write memory",
    );
  if (
    conversation.resetState !== "none" ||
    conversation.currentSegmentId !== turn.segmentId ||
    snapshot?.contextEpoch !== conversation.contextEpoch
  ) {
    log.warn({ turnId, ownerId }, "librarian memory write fenced");
    throw new MaisterError(
      "CONFLICT",
      "memory write lost its generation fence",
      {
        details: { reason: "generation_changed" },
      },
    );
  }

  return {
    conversationId: conversation.id,
    segmentId: turn.segmentId,
    messageId: turn.messageId,
  };
}

async function insertMemory(
  tx: Db,
  ownerId: string,
  draft: MemoryDraft,
  input: {
    origin: LibrarianMemoryItemRow["origin"];
    sourceMessageId: string | null;
    sourceProjectIds: string[];
  },
): Promise<string> {
  const projectId = await projectForDraft(tx, ownerId, draft);
  const [item] = await tx
    .insert(librarianMemoryItems)
    .values({
      userId: ownerId,
      kind: draft.kind,
      content: draft.content,
      scope: draft.scope,
      projectId,
      sourceRefs: input.sourceMessageId
        ? [{ messageId: input.sourceMessageId, projectId }]
        : [],
      sourceProjectIds: [
        ...new Set([
          ...input.sourceProjectIds,
          ...(projectId ? [projectId] : []),
        ]),
      ],
      origin: input.origin,
      validUntil: draft.validUntil ? new Date(draft.validUntil) : null,
    })
    .returning({ id: librarianMemoryItems.id });

  await tx.insert(librarianMemoryItemRevisions).values({
    itemId: item.id,
    revision: 1,
    content: draft.content,
  });
  log.info({ itemId: item.id, action: "remember" }, "librarian memory changed");

  return item.id;
}

/** Owner UI explicit memory write; the transaction itself is the generation boundary. */
export async function rememberPersonalMemory(
  ownerId: string,
  raw: MemoryDraft,
  db: Db = getDb() as unknown as Db,
): Promise<string> {
  const draft = memoryDraftSchema.parse(raw);

  return db.transaction(async (tx) => {
    const { conversation } = await lockOwnerConversation(tx, ownerId);

    if (conversation.resetState !== "none")
      throw new MaisterError("CONFLICT", "conversation is being reset", {
        details: { reason: "reset_in_progress" },
      });

    return insertMemory(tx, ownerId, draft, {
      origin: "explicit",
      sourceMessageId: null,
      sourceProjectIds: [],
    });
  });
}

/** A tool write must still be from the owner-message turn and the epoch it started under. */
export async function rememberFromLibrarianTurn(
  ownerId: string,
  turnId: string,
  raw: MemoryDraft,
  recordCreated: (tx: Db, itemId: string) => Promise<void>,
  db: Db = getDb() as unknown as Db,
): Promise<string> {
  const draft = memoryDraftSchema.parse(raw);

  return db.transaction(async (tx) => {
    const fence = await assertMemoryTurnFence(tx, ownerId, turnId);

    const sources = await tx
      .selectDistinct({ projectId: tokenAuditLog.project_id })
      .from(tokenAuditLog)
      .where(
        and(
          eq(tokenAuditLog.librarian_turn_id, turnId),
          isNotNull(tokenAuditLog.project_id),
        ),
      );
    const itemId = await insertMemory(tx, ownerId, draft, {
      origin: "explicit",
      sourceMessageId: fence.messageId,
      sourceProjectIds: sources
        .map((source) => source.projectId)
        .filter((id): id is string => id !== null),
    });

    await recordCreated(tx, itemId);

    return itemId;
  });
}

export async function rememberAcceptedSuggestion(
  tx: Db,
  ownerId: string,
  raw: MemoryDraft,
  expectedEpoch: number,
): Promise<string> {
  const draft = memoryDraftSchema.parse(raw);
  const { conversation } = await lockOwnerConversation(tx, ownerId);

  if (
    conversation.resetState !== "none" ||
    conversation.contextEpoch !== expectedEpoch
  )
    throw new MaisterError(
      "CONFLICT",
      "memory suggestion lost its generation fence",
      {
        details: { reason: "generation_changed" },
      },
    );
  await assertMemorySuggestionNotForgotten(tx, ownerId, draft.content);

  return insertMemory(tx, ownerId, draft, {
    origin: "accepted_suggestion",
    sourceMessageId: null,
    sourceProjectIds: [],
  });
}

async function currentContent(
  tx: Db,
  item: LibrarianMemoryItemRow,
): Promise<string> {
  const [revision] = await tx
    .select({ content: librarianMemoryItemRevisions.content })
    .from(librarianMemoryItemRevisions)
    .where(
      and(
        eq(librarianMemoryItemRevisions.itemId, item.id),
        eq(librarianMemoryItemRevisions.revision, item.revision),
      ),
    );

  if (!revision)
    throw new Error(`memory revision ${item.id}:${item.revision} missing`);

  return revision.content;
}

export async function listPersonalMemory(
  ownerId: string,
  db: Db = getDb() as unknown as Db,
): Promise<{ items: MemoryItemView[]; memoryEnabledNextSegment: boolean }> {
  const { conversation } = await db.transaction((tx) =>
    lockOwnerConversation(tx, ownerId),
  );
  const visible = new Set(await visibleProjectIds(db, ownerId));
  const items = await db
    .select()
    .from(librarianMemoryItems)
    .where(
      and(
        eq(librarianMemoryItems.userId, ownerId),
        isNull(librarianMemoryItems.forgottenAt),
      ),
    );
  const projectIds = items
    .map((item) => item.projectId)
    .filter((id): id is string => !!id);
  const projectRows =
    projectIds.length > 0
      ? await db
          .select({ id: projects.id, slug: projects.slug })
          .from(projects)
          .where(inArray(projects.id, projectIds))
      : [];
  const slugById = new Map(
    projectRows.map((project) => [project.id, project.slug]),
  );
  const revisionRows =
    items.length > 0
      ? await db
          .select()
          .from(librarianMemoryItemRevisions)
          .where(
            inArray(
              librarianMemoryItemRevisions.itemId,
              items.map((item) => item.id),
            ),
          )
      : [];
  const revisionContent = new Map(
    revisionRows.map((revision) => [
      `${revision.itemId}:${revision.revision}`,
      revision.content,
    ]),
  );
  const now = new Date();

  return {
    memoryEnabledNextSegment: conversation.memoryEnabledNextSegment,
    items: items.map((item) => {
      const unavailableSource = item.sourceProjectIds.some(
        (id) => !visible.has(id),
      );
      const expired = item.validUntil !== null && item.validUntil <= now;
      const content = revisionContent.get(`${item.id}:${item.revision}`);

      if (content === undefined)
        throw new Error(`memory revision ${item.id}:${item.revision} missing`);

      return {
        id: item.id,
        kind: item.kind,
        content: unavailableSource ? "" : content,
        scope: item.scope,
        projectSlug:
          item.projectId && !unavailableSource
            ? (slugById.get(item.projectId) ?? null)
            : null,
        origin: item.origin,
        validUntil: item.validUntil?.toISOString() ?? null,
        revision: item.revision,
        excludedReason: unavailableSource
          ? "source_unavailable"
          : expired
            ? "expired"
            : null,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      };
    }),
  };
}

export async function editPersonalMemory(
  ownerId: string,
  itemId: string,
  raw: MemoryPatch,
  db: Db = getDb() as unknown as Db,
): Promise<void> {
  const patch = memoryPatchSchema.parse(raw);

  await db.transaction(async (tx) => {
    await lockOwnerConversation(tx, ownerId);
    const [item] = await tx
      .select()
      .from(librarianMemoryItems)
      .where(
        and(
          eq(librarianMemoryItems.id, itemId),
          eq(librarianMemoryItems.userId, ownerId),
          isNull(librarianMemoryItems.forgottenAt),
        ),
      )
      .for("update");

    if (!item) throw unavailable();
    if (item.revision !== patch.expectedRevision)
      throw new MaisterError("CONFLICT", "memory revision changed", {
        details: { reason: "stale_revision" },
      });
    const content = patch.content ?? (await currentContent(tx, item));
    const revision = item.revision + 1;

    await tx
      .insert(librarianMemoryItemRevisions)
      .values({ itemId, revision, content });
    await tx
      .update(librarianMemoryItems)
      .set({
        revision,
        kind: patch.kind ?? item.kind,
        validUntil:
          patch.validUntil === undefined
            ? item.validUntil
            : patch.validUntil === null
              ? null
              : new Date(patch.validUntil),
        updatedAt: new Date(),
      })
      .where(eq(librarianMemoryItems.id, itemId));
    log.info({ itemId, action: "edit" }, "librarian memory changed");
  });
}

export async function forgetPersonalMemory(
  ownerId: string,
  itemId: string,
  db: Db = getDb() as unknown as Db,
): Promise<void> {
  await db.transaction(async (tx) => {
    const { conversation } = await lockOwnerConversation(tx, ownerId);
    const [item] = await tx
      .select()
      .from(librarianMemoryItems)
      .where(
        and(
          eq(librarianMemoryItems.id, itemId),
          eq(librarianMemoryItems.userId, ownerId),
          isNull(librarianMemoryItems.forgottenAt),
        ),
      )
      .for("update");

    if (!item) throw unavailable();
    const revisions = await tx.select({ content: librarianMemoryItemRevisions.content })
      .from(librarianMemoryItemRevisions).where(eq(librarianMemoryItemRevisions.itemId, itemId));

    await tx.insert(librarianMemoryTombstones).values(revisions.map((revision) => ({
      userId: ownerId,
      contentDigest: memoryContentDigest(revision.content),
    }))).onConflictDoNothing();
    await tx
      .update(librarianMemoryItems)
      .set({ forgottenAt: new Date(), updatedAt: new Date() })
      .where(eq(librarianMemoryItems.id, itemId));
    await tx
      .update(librarianConversations)
      .set({
        forgetGeneration: conversation.forgetGeneration + 1,
        contextEpoch: conversation.contextEpoch + 1,
        updatedAt: new Date(),
      })
      .where(eq(librarianConversations.id, conversation.id));
    await tx
      .update(librarianSegmentSummaries)
      .set({ invalidatedAt: new Date() })
      .where(
        and(
          inArray(
            librarianSegmentSummaries.segmentId,
            tx
              .select({ id: librarianSegments.id })
              .from(librarianSegments)
              .where(eq(librarianSegments.conversationId, conversation.id)),
          ),
          isNull(librarianSegmentSummaries.invalidatedAt),
          lt(
            librarianSegmentSummaries.forgetGeneration,
            conversation.forgetGeneration + 1,
          ),
        ),
      );
    log.info({ itemId, action: "forget" }, "librarian memory changed");
  });
}
