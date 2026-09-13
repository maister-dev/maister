import "server-only";

/**
 * The digest notification trigger (ADR-172 D6, `NTF-08`).
 *
 * One of exactly TWO triggers. The other is a `decisions` delta
 * (`attention-consumer.ts`); there is deliberately no third, and no per-event
 * stream — that is the anti-pattern that gets a channel muted within a week.
 *
 * It rides the EXISTING `system_sweep` bundle rather than a new scheduler job
 * kind, because a new kind is a `scheduler_jobs.job_kind` enum value and
 * therefore a migration, for a pass that needs no independent cadence: the
 * window, not the tick, is what bounds how often a reader hears from it.
 *
 * THE PAYLOAD IS T5.4's DETERMINISTIC SENTENCE. `formatDigest` has no clock and
 * no narration: the same window and the same rows produce byte-identical output.
 * That is what makes it safe to send under at-least-once delivery — a redelivery
 * reads as the same notification rather than as a second, subtly different one.
 */

import type { GlobalRole } from "@/lib/db/schema";

import { sql } from "drizzle-orm";
import pino from "pino";

import {
  formatDigest,
  getNowTileCounts,
  NOW_TILE_IDS,
  type DigestLabels,
} from "@/lib/queries/digest";
import { computeDecisionsQueue } from "@/lib/queries/decisions";
import { emitDecisionsDelta } from "@/lib/notifications/attention-consumer";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants (matches the other consumers).
type Db = any;

const log = pino({
  name: "notifications-digest",
  level: process.env.LOG_LEVEL ?? "info",
});

/**
 * The floor between two digests for one reader. A digest is a catch-up, not a
 * feed: more often than this and it stops being one.
 */
export const DIGEST_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;

export interface DigestTriggerSummary {
  candidates: number;
  emitted: number;
  skippedTooSoon: number;
  skippedEmpty: number;
  errors: string[];
}

/**
 * Copy kept in the SENDER rather than in the message catalogs, because a push
 * payload is built by the server with no request and therefore no locale
 * cookie. EN only, deliberately: inventing a locale for a background job is
 * worse than one honest language, and the in-app sentence — which DOES know the
 * reader's locale — is the localized surface.
 */
const DIGEST_LABELS: DigestLabels = {
  promoted: "$count promoted",
  crashed: "$count crashed",
  decisions: "$count new decisions",
  events: "$count new events",
  tokens: "$count tokens",
  empty: "Nothing happened since your last visit.",
};

interface DigestCandidate {
  id: string;
  role: GlobalRole;
  last_digest_at: Date | null;
}

/**
 * Readers who asked for a digest: an active account with an ENABLED
 * notification intent naming `attention.digest`, over any transport. The
 * transport decides HOW it is delivered; this decides whether there is anything
 * to deliver.
 */
async function digestCandidates(client: Db): Promise<DigestCandidate[]> {
  const result = await client.execute(sql`
    SELECT
      u.id,
      u.role,
      (
        SELECT max(we.occurred_at)
        FROM webhook_events we
        WHERE we.type = 'attention.digest'
          AND we.data->>'ownerUserId' = u.id
      ) AS last_digest_at
    FROM users u
    WHERE u.account_status = 'active'
      AND EXISTS (
        SELECT 1 FROM notification_subscriptions ns
        WHERE ns.owner_user_id = u.id
          AND ns.enabled = true
          AND ns.event_types ? 'attention.digest'
      )
  `);

  return (result.rows ?? []) as DigestCandidate[];
}

export interface DeltaBackstopSummary {
  candidates: number;
  emitted: number;
  errors: string[];
}

/**
 * The `decisions` delta BACKSTOP (`NTF-08`), on the `system_sweep` beat beside
 * the digest.
 *
 * ADR-172 D5 makes the domain-event consumer the delta trigger, and that
 * assumed the taxonomy covers decision transitions. It does not: there is no
 * `DOMAIN_EVENT_KINDS` member for a HITL opening or a run entering
 * `NeedsInput`, and `run.review` is emitted only for runs WITH a parent
 * (`emitDelegatedReviewIfChild` returns early on `!parentRunId`). So the two
 * commonest ways a decision opens — an ACP permission request, and a top-level
 * run reaching Review — wake the consumer never, and a reader could sit on an
 * unnotified queue indefinitely.
 *
 * Re-deriving the count per tick closes that without a migration on the
 * CHECK-constrained `domain_events.kind`, without new emitters in the run
 * state machine's hot paths, and without a new clock. It uses the SAME
 * `emitDecisionsDelta` the consumer uses, so a tick that follows a consumer
 * pass over unchanged state emits nothing. It also doubles as the retry for a
 * single reader the consumer skipped.
 */
export async function runDecisionsDeltaBackstop(
  opts: { db?: Db } = {},
): Promise<DeltaBackstopSummary> {
  const client: Db = opts.db ?? getDb();
  const summary: DeltaBackstopSummary = {
    candidates: 0,
    emitted: 0,
    errors: [],
  };

  let readers: DigestCandidate[];

  try {
    // The same population the digest serves: an active account with an enabled
    // intent. A reader who asked for no notifications is not woken to be told
    // nothing changed.
    readers = await deltaCandidates(client);
  } catch (err) {
    summary.errors.push(
      `delta candidates failed: ${err instanceof Error ? err.message : String(err)}`,
    );

    return summary;
  }

  summary.candidates = readers.length;

  for (const reader of readers) {
    try {
      const sent = await emitDecisionsDelta(
        client,
        reader.id,
        reader.role,
        // UNCACHED, as in the consumer: a long-lived sweep has no request to
        // scope the React memo, and a cached queue would hand every reader in
        // one pass the first reader's count.
        async (userId, role) =>
          (await computeDecisionsQueue(userId, role)).count,
      );

      if (sent) summary.emitted += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      summary.errors.push(`delta for ${reader.id} failed: ${message}`);
      log.warn(
        { userId: reader.id, err: message },
        "delta backstop skipped reader",
      );
    }
  }

  log.info(summary, "[notifications.delta_backstop] summary");

  return summary;
}

/**
 * Readers with ANY enabled notification intent naming a decision delta. Unlike
 * the digest's population this does not care about transport — the fan-out
 * decides that — only that the reader asked to hear about decisions at all.
 */
async function deltaCandidates(client: Db): Promise<DigestCandidate[]> {
  const result = await client.execute(sql`
    SELECT u.id, u.role, NULL::timestamptz AS last_digest_at
    FROM users u
    WHERE u.account_status = 'active'
      AND EXISTS (
        SELECT 1 FROM notification_subscriptions ns
        WHERE ns.owner_user_id = u.id
          AND ns.enabled = true
          AND (
            ns.event_types ? 'attention.decision_opened'
            OR ns.event_types ? 'attention.decision_closed'
            OR ns.event_types ? 'attention.decisions_changed'
          )
      )
  `);

  return (result.rows ?? []) as DigestCandidate[];
}

export async function runDigestTrigger(
  opts: { db?: Db; now?: Date } = {},
): Promise<DigestTriggerSummary> {
  const client: Db = opts.db ?? getDb();
  const now = opts.now ?? new Date();
  const summary: DigestTriggerSummary = {
    candidates: 0,
    emitted: 0,
    skippedTooSoon: 0,
    skippedEmpty: 0,
    errors: [],
  };

  let candidates: DigestCandidate[];

  try {
    candidates = await digestCandidates(client);
  } catch (err) {
    summary.errors.push(
      `digest candidates failed: ${err instanceof Error ? err.message : String(err)}`,
    );

    return summary;
  }

  summary.candidates = candidates.length;

  for (const candidate of candidates) {
    try {
      // The interval is read from the reader's own last emission, so a repeated
      // sweep finds the fresh digest and skips. Note what enforces that: the
      // `system_sweep` job is a scheduler SINGLETON, so sweeps are serialized.
      // There is no CAS here — two genuinely concurrent sweeps would both read
      // the pre-emission watermark and both emit.
      if (
        candidate.last_digest_at !== null &&
        now.getTime() - new Date(candidate.last_digest_at).getTime() <
          DIGEST_MIN_INTERVAL_MS
      ) {
        summary.skippedTooSoon += 1;
        continue;
      }

      const window = await getNowTileCounts(
        { id: candidate.id, role: candidate.role },
        now,
        // The UNCACHED queue: a React-`cache`d read in a long-lived process has
        // no request to scope it and could hand every reader in one sweep the
        // first reader's count.
        { decisionsQueue: computeDecisionsQueue },
      );

      // Nothing happened: no notification. A digest that says "nothing happened"
      // is exactly the notification a reader mutes the channel over.
      if (window.tiles.every((tile) => tile.value === 0)) {
        summary.skippedEmpty += 1;
        continue;
      }

      const sentence = formatDigest(window, {
        locale: "en",
        labels: DIGEST_LABELS,
      });

      await emitWebhookEvent({
        db: client,
        type: "attention.digest",
        ownerUserId: candidate.id,
        data: {
          title: "Since your last visit",
          sentence,
          url: "/",
          since: window.since.toISOString(),
          ...Object.fromEntries(
            NOW_TILE_IDS.map((id) => [
              id,
              window.tiles.find((tile) => tile.id === id)?.value ?? 0,
            ]),
          ),
        },
        occurredAt: now,
      });
      summary.emitted += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Never throws per reader: the sweep bundle must not fail because one
      // reader's queue is momentarily unreadable.
      summary.errors.push(`digest for ${candidate.id} failed: ${message}`);
      log.warn(
        {
          userId: candidate.id,
          code: isMaisterError(err) ? err.code : "UNKNOWN",
          err: message,
        },
        "digest skipped reader",
      );
    }
  }

  log.info(summary, "[notifications.digest] summary");

  return summary;
}
