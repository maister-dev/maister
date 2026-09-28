import "server-only";

import type { DomainEventRow } from "@/lib/db/schema";
import type { DomainEventConsumer } from "@/lib/domain-events/consumers";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import {
  librarianConversations,
  librarianMessages,
  librarianUpdates,
  runs,
  users,
} from "@/lib/db/schema";
import {
  appendConversationMessage,
  lockOwnerConversation,
} from "@/lib/librarian/conversation";
import { getVisibleProjectIds } from "@/lib/queries/visible-projects";

type Db = ReturnType<typeof getDb>;

const log = pino({
  name: "librarian.followup",
  level: process.env.LOG_LEVEL ?? "info",
});

const FOLLOWUP_KINDS: ReadonlySet<string> = new Set([
  "run.done",
  "run.failed",
  "run.crashed",
  "run.abandoned",
  "run.review",
  "run.review_opened",
  "run.needs_input",
  "run.escalated",
  "run.rework_claimed",
  "run.rework_returned",
  "gate.failed",
  "task.clarification_answered",
  "task.clarification_cancelled",
]);

function deliveryErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code;

  return error instanceof Error ? error.name : "UNKNOWN";
}

async function followedConversations(
  db: Db,
  taskId: string,
): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT DISTINCT conversation_id AS id FROM librarian_task_links
    WHERE task_id = ${taskId}
    UNION
    SELECT DISTINCT conversation_id AS id FROM librarian_operations
    WHERE status = 'succeeded'
      AND (target->>'taskId' = ${taskId}
        OR result->'body'->>'taskId' = ${taskId})
  `);

  return (rows.rows as Array<{ id: string }>).map((row) => row.id);
}

async function deliver(
  db: Db,
  event: DomainEventRow,
  conversationId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [conversation] = await tx
      .select()
      .from(librarianConversations)
      .where(eq(librarianConversations.id, conversationId));

    if (!conversation) throw new Error("follow-up conversation missing");
    const locked = await lockOwnerConversation(tx, conversation.userId);
    const [update] = await tx
      .select()
      .from(librarianUpdates)
      .where(
        and(
          eq(librarianUpdates.conversationId, conversationId),
          eq(librarianUpdates.domainEventId, event.id),
        ),
      )
      .for("update");

    if (!update || update.status !== "pending") return;
    const [owner] = await tx
      .select({ role: users.role, accountStatus: users.accountStatus })
      .from(users)
      .where(eq(users.id, conversation.userId));
    const visibleIds =
      owner?.accountStatus === "active"
        ? await getVisibleProjectIds(conversation.userId, owner.role, tx)
        : [];

    if (!visibleIds.includes(event.projectId)) {
      await tx
        .update(librarianUpdates)
        .set({ status: "skipped_no_access", attempts: update.attempts + 1 })
        .where(eq(librarianUpdates.id, update.id));
      log.warn(
        { conversationId, eventId: event.id, kind: event.kind },
        "librarian follow-up skipped: no access",
      );

      return;
    }
    const message = await appendConversationMessage(tx, {
      conversationId,
      segmentId: locked.segment.id,
      authorKind: "update",
      body: event.kind,
      sourceProjectIds: [event.projectId],
    });

    await tx
      .update(librarianMessages)
      .set({ updateId: update.id })
      .where(eq(librarianMessages.id, message.id));
    await tx
      .update(librarianUpdates)
      .set({
        status: "delivered",
        attempts: update.attempts + 1,
        messageId: message.id,
        deliveredAt: new Date(),
        lastErrorCode: null,
      })
      .where(eq(librarianUpdates.id, update.id));
    log.info(
      { conversationId, eventId: event.id, kind: event.kind },
      "librarian follow-up delivered",
    );
  });
}

export function buildLibrarianFollowupConsumer(db?: Db): DomainEventConsumer {
  return {
    id: "librarian_followup",
    startFrom: "now",
    async handle(events) {
      const client = db ?? getDb();

      for (const event of events) {
        if (!FOLLOWUP_KINDS.has(event.kind)) continue;
        const taskId =
          event.taskId ??
          (event.runId
            ? (
                await client
                  .select({ taskId: runs.taskId })
                  .from(runs)
                  .where(eq(runs.id, event.runId))
              )[0]?.taskId
            : null);

        if (!taskId) continue;
        const conversations = await followedConversations(client, taskId);

        for (const conversationId of conversations) {
          await client
            .insert(librarianUpdates)
            .values({
              conversationId,
              domainEventId: event.id,
              taskId,
              runId: event.runId,
              kind: event.kind,
              status: "pending",
            })
            .onConflictDoNothing({
              target: [
                librarianUpdates.conversationId,
                librarianUpdates.domainEventId,
              ],
            });
          try {
            await deliver(client, event, conversationId);
          } catch (error) {
            const [update] = await client
              .select()
              .from(librarianUpdates)
              .where(
                and(
                  eq(librarianUpdates.conversationId, conversationId),
                  eq(librarianUpdates.domainEventId, event.id),
                ),
              );

            if (!update || update.status !== "pending") throw error;
            const attempts = update.attempts + 1;
            const errorCode = deliveryErrorCode(error);

            await client
              .update(librarianUpdates)
              .set({
                attempts,
                lastErrorCode: errorCode,
                status: attempts >= 5 ? "failed" : "pending",
              })
              .where(eq(librarianUpdates.id, update.id));
            log.warn(
              {
                conversationId,
                eventId: event.id,
                kind: event.kind,
                attempts,
                errorCode,
              },
              "librarian follow-up delivery failed",
            );
            if (attempts < 5) throw error;
          }
        }
      }
    },
  };
}

export const librarianFollowupConsumer = buildLibrarianFollowupConsumer();
