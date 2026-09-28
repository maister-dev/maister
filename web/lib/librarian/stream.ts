import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, asc, eq, gt, inArray } from "drizzle-orm";
import pino from "pino";

import { librarianIndicator, loadLatestTurn } from "./view";

import {
  librarianConversations,
  librarianMessages,
  librarianTurns,
  platformRuntimeSettings,
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
    })
    .from(librarianConversations)
    .where(eq(librarianConversations.userId, ownerId));

  return row ?? null;
}

/** ADR-185 (LCV-12): the owner's conversation stream. A server-side poll of
 * durable rows; frames are pointers the client refetches, each carrying the
 * conversation's `seq` as its SSE id. Only the caller's own conversation is
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
      const now = Date.now();

      if (now - lastFrameAt >= timings.quietCloseMs) {
        log.debug({ ownerId: input.ownerId }, "librarian stream quiet close");

        return;
      }
      if (now - lastHeartbeatAt >= timings.heartbeatMs) {
        lastHeartbeatAt = now;
        yield sse({ type: "librarian.heartbeat" }, null);
      }
      const [settings] = active
        ? [{ enabled: true }]
        : await input.db
            .select({ enabled: platformRuntimeSettings.librarianEnabled })
            .from(platformRuntimeSettings)
            .where(eq(platformRuntimeSettings.id, "singleton"));

      await sleep(
        active
          ? timings.activePollMs
          : settings?.enabled
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
