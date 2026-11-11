import "server-only";

import type { Db } from "../db";

import { and, eq, sql } from "drizzle-orm";

import { executionEvents } from "@/lib/db/schema";

/** TRC-09. A resolved prompt can inject artifact bodies through
 * `{{ artifacts.<id>.content }}` (ADR-120) and reach megabytes; storing that
 * unbounded would reintroduce the row bloat this work removes. */
export const PROMPT_BODY_MAX_BYTES = 256 * 1024;

export const PROMPT_TRUNCATION_MARKER =
  "\n\n[truncated at 256 KiB — the unabridged prompt for this attempt's" +
  " first dispatch is node_attempts.resolved_prompt]";

/** TRC-09 / EDGE-TRC-05. The bound is in BYTES, so the cut is taken on a
 * character boundary — a split multi-byte sequence would otherwise store
 * replacement characters in place of the text it truncated. */
export function boundPromptBody(body: string): {
  content: string;
  truncated: boolean;
} {
  if (Buffer.byteLength(body, "utf8") <= PROMPT_BODY_MAX_BYTES) {
    return { content: body, truncated: false };
  }
  const budget =
    PROMPT_BODY_MAX_BYTES - Buffer.byteLength(PROMPT_TRUNCATION_MARKER, "utf8");
  const head = new TextDecoder("utf-8")
    .decode(Buffer.from(body, "utf8").subarray(0, budget))
    // A cut inside a multi-byte sequence decodes to U+FFFD; drop the tail.
    .replace(/\uFFFD+$/, "");

  return { content: head + PROMPT_TRUNCATION_MARKER, truncated: true };
}

/** EDGE-TRC-08. The run's last INGESTED event, independent of whether it has
 * been projected yet — that independence is the whole point. `-1` for a run
 * with no events keeps a first prompt ahead of event `0`. Only `accepted`
 * events count: a duplicate or skipped one never becomes a transcript row, so
 * anchoring past it would push the prompt beyond replies that follow. */
export async function eventHorizon(
  db: Pick<Db, "select">,
  runId: string,
): Promise<string> {
  const [row] = await db
    .select({
      horizon: sql<string | null>`max(${executionEvents.runSequence})`,
    })
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.runId, runId),
        eq(executionEvents.ingestDisposition, "accepted"),
      ),
    );

  return row?.horizon ?? "-1";
}
