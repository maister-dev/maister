import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { LibrarianSettings } from "./settings";

import { isDeepStrictEqual } from "node:util";

import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import pino from "pino";

import { librarianIndicator, loadLatestTurn } from "./view";
import { readLibrarianSettings } from "./settings";

import {
  librarianConversations,
  librarianMessages,
  librarianTurns,
  projectMembers,
  projects,
  users,
} from "@/lib/db/schema";

const log = pino({
  name: "librarian.stream",
  level: process.env.LOG_LEVEL ?? "info",
});

// librarian-stream.asyncapi.yaml: module constants, not environment variables.
export const LIBRARIAN_STREAM_TIMINGS = {
  activePollMs: 500,
  idlePollMs: 2_000,
  disabledPollMs: 30_000,
  heartbeatMs: 15_000,
  quietCloseMs: 5 * 60_000,
};

export type LibrarianStreamTimings = typeof LIBRARIAN_STREAM_TIMINGS;

type Frame = Record<string, unknown> & { type: string };

function sse(frame: Frame, id: string | null): string {
  return `${id !== null ? `id: ${id}\n` : ""}data: ${JSON.stringify(frame)}\n\n`;
}

async function readConversation(db: Db, ownerId: string) {
  const [row] = await db
    .select({
      id: librarianConversations.id,
      lastSeq: librarianConversations.lastSeq,
      readThroughSeq: librarianConversations.readThroughSeq,
      resetState: librarianConversations.resetState,
      segmentId: librarianConversations.currentSegmentId,
      generation: librarianConversations.historyGeneration,
    })
    .from(librarianConversations)
    .where(eq(librarianConversations.userId, ownerId));

  return row ?? null;
}

async function workWitness(
  db: Db,
  ownerId: string,
  conversation: Awaited<ReturnType<typeof readConversation>>,
): Promise<{ access: string; work: string }> {
  const conversationId = conversation?.id ?? null;
  const {
    rows: [row],
  } = await db.execute<{ access: string; work: string }>(sql`
    SELECT
      md5(concat_ws('|', (SELECT role FROM ${users} WHERE id = ${ownerId}),
        (SELECT string_agg(concat_ws(':', p.id, pm.role, p.archived_at), ',' ORDER BY p.id)
           FROM ${projects} p
           LEFT JOIN ${projectMembers} pm ON pm.project_id = p.id AND pm.user_id = ${ownerId}
          WHERE pm.user_id IS NOT NULL OR EXISTS (SELECT 1 FROM ${users} WHERE id = ${ownerId} AND role = 'admin'))
      )) AS access,
      md5(concat_ws('|', ${conversation?.segmentId ?? null}::text, ${conversation?.generation ?? null}::integer,
        (SELECT sum(hashtextextended(concat_ws(':', id, status, settled_at, card_id, turn_id),0))::text
           FROM librarian_operations WHERE conversation_id = ${conversationId}),
        (SELECT sum(hashtextextended(concat_ws(':', id, status, decided_at, message_id, expires_at > now()),0))::text
           FROM librarian_cards WHERE conversation_id = ${conversationId}),
        (SELECT sum(hashtextextended(concat_ws(':', id, task_id, from_message_id, to_message_id),0))::text
           FROM librarian_task_links WHERE conversation_id = ${conversationId})
      )) AS work
  `);

  return row;
}

/** ADR-185 (LCV-12): the owner's conversation stream. A server-side poll of
 * durable rows; frames are pointers the client refetches, each carrying the
 * conversation's `seq` as its SSE id. Settings pointers carry no cursor.
 * Only the caller's own conversation is
 * ever read — there is no parameter naming a user or a conversation. */
export async function* librarianStreamFrames(input: {
  db: Db;
  ownerId: string;
  cursor: bigint | null;
  signal: AbortSignal;
  timings?: LibrarianStreamTimings;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): AsyncGenerator<string> {
  const timings = input.timings ?? LIBRARIAN_STREAM_TIMINGS;
  const sleep =
    input.sleep ??
    ((ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);

        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }));
  let cursor = input.cursor;
  let lastTurnKey: string | null = null;
  let lastIndicator: string | null = null;
  let lastReset: string | null = null;
  let lastSettings: LibrarianSettings | null = null;
  let lastWork: Awaited<ReturnType<typeof workWitness>> | null = null;
  let lastFrameAt = Date.now();
  let lastHeartbeatAt = Date.now();

  log.debug(
    { ownerId: input.ownerId, lastEventId: cursor?.toString() ?? null },
    "librarian stream open",
  );
  try {
    while (!input.signal.aborted) {
      const conversation = await readConversation(input.db, input.ownerId);
      let active = false;

      if (conversation) {
        const seq = conversation.lastSeq.toString();

        // A null cursor (first connect, or a non-canonical one) opens with the
        // state frames only: history loads through GET /messages.
        if (cursor === null) cursor = BigInt(conversation.lastSeq);
        const messages = await input.db
          .select({ id: librarianMessages.id, seq: librarianMessages.seq })
          .from(librarianMessages)
          .where(
            and(
              eq(librarianMessages.conversationId, conversation.id),
              gt(librarianMessages.seq, cursor),
            ),
          )
          .orderBy(asc(librarianMessages.seq))
          .limit(200);

        for (const message of messages) {
          const messageSeq = message.seq.toString();

          yield sse(
            {
              type: "librarian.message",
              id: messageSeq,
              seq: messageSeq,
              messageId: message.id,
            },
            messageSeq,
          );
          cursor = BigInt(message.seq);
          lastFrameAt = Date.now();
        }
        const turn = await loadLatestTurn(input.db, conversation.id);
        const turnKey = turn ? `${turn.id}:${turn.status}` : null;

        if (turn && turnKey !== lastTurnKey) {
          lastTurnKey = turnKey;
          yield sse(
            {
              type: "librarian.turn",
              id: seq,
              seq,
              turnId: turn.id,
              status: turn.status,
              ...(turn.status === "failed" && turn.failureReason
                ? { reason: turn.failureReason }
                : {}),
            },
            seq,
          );
          lastFrameAt = Date.now();
        }
        const [activeTurn] = await input.db
          .select({ id: librarianTurns.id })
          .from(librarianTurns)
          .where(
            and(
              eq(librarianTurns.conversationId, conversation.id),
              inArray(librarianTurns.status, ["admitted", "running"]),
            ),
          )
          .limit(1);

        active = activeTurn !== undefined;
        const indicator = await librarianIndicator(input.db, conversation);

        if (indicator !== lastIndicator) {
          lastIndicator = indicator;
          yield sse(
            { type: "librarian.indicator", id: seq, seq, state: indicator },
            seq,
          );
          lastFrameAt = Date.now();
        }
        const resetKey = `${conversation.resetState}:${conversation.segmentId}`;

        if (resetKey !== lastReset) {
          const first = lastReset === null;

          lastReset = resetKey;
          if (!first || conversation.resetState !== "none") {
            yield sse(
              {
                type: "librarian.reset",
                id: seq,
                seq,
                resetState:
                  conversation.resetState === "none" ? "none" : "resetting",
                ...(conversation.resetState === "none" && conversation.segmentId
                  ? { segmentId: conversation.segmentId }
                  : {}),
              },
              seq,
            );
            lastFrameAt = Date.now();
          }
        }
      }
      const settings = await readLibrarianSettings(input.db);

      // Settings have no message seq; reconnects must refresh even when the
      // conversation cursor has not moved (or no conversation exists yet).
      if (!isDeepStrictEqual(settings, lastSettings)) {
        lastSettings = settings;
        yield sse({ type: "librarian.settings" }, null);
        lastFrameAt = Date.now();
        log.debug(
          { ownerId: input.ownerId, availability: settings.availability },
          "[FIX:librarian-runner] settings change notified",
        );
      }
      const witness = await workWitness(input.db, input.ownerId, conversation);
      const change =
        lastWork === null
          ? "sync"
          : lastWork.access !== witness.access
            ? "access"
            : lastWork.work !== witness.work
              ? "work"
              : null;

      lastWork = witness;
      if (change) {
        yield sse({ type: "librarian.work", reason: change }, null);
        lastFrameAt = Date.now();
      }
      const now = Date.now();

      if (now - lastFrameAt >= timings.quietCloseMs) {
        log.debug({ ownerId: input.ownerId }, "librarian stream quiet close");

        return;
      }
      if (now - lastHeartbeatAt >= timings.heartbeatMs) {
        lastHeartbeatAt = now;
        yield sse({ type: "librarian.heartbeat" }, null);
      }
      await sleep(
        active
          ? timings.activePollMs
          : settings.enabled
            ? timings.idlePollMs
            : timings.disabledPollMs,
        input.signal,
      );
    }
  } finally {
    log.debug(
      { ownerId: input.ownerId, lastEventId: cursor?.toString() ?? null },
      "librarian stream close",
    );
  }
}
