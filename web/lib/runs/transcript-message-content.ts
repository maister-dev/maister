import "server-only";

import type { TranscriptMessage } from "@/components/run-transcript/transcript-view";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { authorizePeekRun } from "@/lib/runs/peek-read-model";

const messageIdSchema = z.string().min(1).max(512);
const attemptSchema = z.string().uuid();
// PostgreSQL substring counts Unicode characters, each at most four UTF-8 bytes.
const CHUNK_CHARACTERS = 16 * 1024;

type MessageMetadata = {
  id: string;
  role: TranscriptMessage["role"];
  bytes: number;
  characters: number;
  revision: string;
  attemptId: string | null;
  latestAttemptId: string | null;
};

type TranscriptMessageDownload = {
  body: ReadableStream<Uint8Array>;
  bytes: number;
  role: TranscriptMessage["role"];
};

/** Explicit downloads stream one authorized version in bounded database reads. */
export async function openTranscriptMessageContent(input: {
  userId: string;
  runId: string;
  messageId: string;
  attempt: string | undefined;
  signal: AbortSignal;
  onError: (error: unknown) => void;
}): Promise<TranscriptMessageDownload> {
  const access = await authorizePeekRun(input.userId, input.runId);

  if (!access.canReadTranscript)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Transcript requires repository read access",
    );
  if (
    !messageIdSchema.safeParse(input.messageId).success ||
    (input.attempt !== undefined &&
      !attemptSchema.safeParse(input.attempt).success)
  )
    throw new MaisterError("CONFIG", "Invalid transcript message download", {
      details: { reason: "invalid_transcript_message" },
    });

  const db = getDb();
  const { rows } = await db.execute<MessageMetadata>(sql`
    SELECT m.id,m.role,octet_length(m.content)::int AS bytes,
      char_length(m.content)::int AS characters,m.xmin::text AS revision,
      m.node_attempt_id AS "attemptId",
      (SELECT id FROM node_attempts WHERE run_id=m.run_id AND node_id=a.node_id ORDER BY attempt DESC LIMIT 1) AS "latestAttemptId"
    FROM run_messages m LEFT JOIN node_attempts a ON a.id=m.node_attempt_id
    WHERE m.run_id=${input.runId} AND m.id=${input.messageId} LIMIT 1
  `);
  const message = rows[0];

  if (!message)
    throw new MaisterError(
      "PRECONDITION",
      "Transcript message is unavailable",
      {
        details: { reason: "run_unavailable" },
      },
    );
  if (
    message.attemptId !== (input.attempt ?? null) ||
    (message.attemptId !== null &&
      message.attemptId !== message.latestAttemptId)
  )
    throw new MaisterError("CONFLICT", "Transcript attempt changed", {
      details: { reason: "transcript_attempt_changed" },
    });

  let offset = 0;
  let cancelled = false;
  let removeAbortListener = (): void => {};
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const abort = (): void => {
          cancelled = true;
          removeAbortListener();
          controller.error(
            input.signal.reason ??
              new DOMException("Download aborted", "AbortError"),
          );
        };

        removeAbortListener = () =>
          input.signal.removeEventListener("abort", abort);
        if (input.signal.aborted) abort();
        else input.signal.addEventListener("abort", abort, { once: true });
      },
      async pull(controller) {
        if (cancelled) return;
        if (offset >= message.characters) {
          removeAbortListener();
          controller.close();

          return;
        }
        try {
          const chunk = await db.execute<{ content: string }>(sql`
            SELECT substring(m.content FROM ${offset + 1}::int FOR ${CHUNK_CHARACTERS}::int) AS content
            FROM run_messages m
            WHERE m.run_id=${input.runId} AND m.id=${input.messageId}
              AND m.xmin::text=${message.revision}
              ${message.attemptId === null ? sql`` : sql`AND m.node_attempt_id=(SELECT newest.id FROM node_attempts newest JOIN node_attempts selected ON selected.id=${message.attemptId} WHERE newest.run_id=m.run_id AND newest.node_id=selected.node_id ORDER BY newest.attempt DESC LIMIT 1)`}
          `);

          if (cancelled) return;
          if (chunk.rows[0] === undefined)
            throw new MaisterError(
              "CONFLICT",
              "Transcript changed during download; retrieve the message again",
              {
                details: {
                  reason: "transcript_message_changed",
                  runId: input.runId,
                  messageId: input.messageId,
                },
              },
            );
          // A row revision fences every chunk: live coalescing cannot splice
          // content from different versions into an apparently valid file.
          offset += CHUNK_CHARACTERS;
          controller.enqueue(new TextEncoder().encode(chunk.rows[0].content));
          if (offset >= message.characters) {
            removeAbortListener();
            controller.close();
          }
        } catch (error) {
          removeAbortListener();
          if (!cancelled) {
            input.onError(error);
            controller.error(error);
          }
        }
      },
      cancel() {
        cancelled = true;
        removeAbortListener();
      },
    },
    { highWaterMark: 0 },
  );

  return { body, bytes: message.bytes, role: message.role };
}
