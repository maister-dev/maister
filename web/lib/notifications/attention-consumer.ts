import "server-only";

/**
 * The `attention.*` domain-event consumer (ADR-172 D5/D6, `NTF-08`,
 * `EDGE-NTF-01`).
 *
 * ONE entry in `DOMAIN_EVENT_CONSUMERS` plus its cursor row — exactly what
 * ADR-086 promised a consumer would cost. No new clock, no new outbox.
 *
 * TRIGGERS ARE DELTAS ONLY (D6). A domain event is never forwarded as a
 * notification: the consumer recomputes the reader's `decisions` count and emits
 * only when that NUMBER moved. A per-event stream is the anti-pattern that
 * trains a reader to mute the channel within a week, at which point the whole
 * delivery path is dead weight. The digest is the other trigger and is emitted
 * by the scheduler, not from here.
 *
 * IDEMPOTENCE (`EDGE-NTF-01`). Domain-event dispatch is at-least-once, so
 * `handle` must converge. It does, twice over:
 *   - the count is recomputed from current state rather than accumulated, so a
 *     redelivered window produces the same number;
 *   - that number is compared against the last one this consumer emitted for
 *     the reader (`notification_deltas`-free: the previous value is read from
 *     the reader's most recent `attention.*` event), so an unchanged count emits
 *     nothing at all.
 *
 * POISON SAFETY. The dispatcher breaks WITHOUT advancing the cursor when a
 * handler throws, so one permanently-failing reader would stall every later
 * event. Each reader is therefore wrapped: `handle` never throws.
 */

import type { DomainEventConsumer } from "@/lib/domain-events/consumers";
import type { DomainEventRow } from "@/lib/db/schema";

import { sql } from "drizzle-orm";
import pino from "pino";

import { ATTENTION_EVENT_KINDS } from "@/lib/domain-events/taxonomy";
import { computeDecisionsQueue } from "@/lib/queries/decisions";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants (matches cost-rollup-reconcile).
type Db = any;

const log = pino({
  name: "notifications-attention-consumer",
  level: process.env.LOG_LEVEL ?? "info",
});

const ATTENTION_KIND_SET: ReadonlySet<string> = new Set(ATTENTION_EVENT_KINDS);

export interface AttentionConsumerDeps {
  db?: Db;
  /** Injected so the unit test can drive the count without a database. */
  decisionsFor?: (
    userId: string,
    role: "admin" | "member" | "viewer",
  ) => Promise<number>;
}

/**
 * The readers a domain event could have changed the count for: every active
 * member of the event's project, plus every active global admin (an admin sees
 * every project, so any event can move their number).
 *
 * An event with no project — there are none in `ATTENTION_EVENT_KINDS` today,
 * but the column is nullable — resolves to admins only, which is the same answer
 * `getVisibleProjectIds` would give.
 */
async function readersOf(
  client: Db,
  projectId: string | null,
): Promise<Array<{ id: string; role: "admin" | "member" | "viewer" }>> {
  const result = await client.execute(sql`
    SELECT DISTINCT u.id, u.role
    FROM users u
    WHERE u.account_status = 'active'
      AND (
        u.role = 'admin'
        OR (
          ${projectId}::text IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM project_members pm
            WHERE pm.user_id = u.id AND pm.project_id = ${projectId}
          )
        )
      )
  `);

  return (result.rows ?? []) as Array<{
    id: string;
    role: "admin" | "member" | "viewer";
  }>;
}

/**
 * The last `decisions` value this consumer published for a reader, read back out
 * of its own emissions. Keeping the previous value in the outbox rather than in
 * a new table is what lets the consumer stay "one entry plus a cursor row": the
 * events it already writes ARE the state it needs.
 */
async function lastPublishedCount(
  client: Db,
  ownerUserId: string,
): Promise<number | null> {
  // `id DESC` is a total order over a random uuid, so the tiebreak is stable for
  // a given set of rows but says nothing about which is newer. It never decides
  // anything in practice: this consumer emits at most one event per reader per
  // pass and passes are serialized, so two rows cannot share an `occurred_at`.
  const result = await client.execute(sql`
    SELECT (data->>'decisions')::int AS decisions
    FROM webhook_events
    WHERE type IN (
            'attention.decision_opened',
            'attention.decision_closed',
            'attention.decisions_changed'
          )
      AND data->>'ownerUserId' = ${ownerUserId}
    ORDER BY occurred_at DESC, id DESC
    LIMIT 1
  `);
  const row = (result.rows ?? [])[0] as
    | { decisions: number | null }
    | undefined;

  return row?.decisions ?? null;
}

/**
 * Which of the three delta types a move is. `opened`/`closed` are the edges a
 * reader cares about most — "something started waiting on me" and "you are
 * clear" — and `decisions_changed` covers a move between two non-zero values.
 */
export function deltaTypeFor(
  previous: number,
  current: number,
):
  | "attention.decision_opened"
  | "attention.decision_closed"
  | "attention.decisions_changed"
  | null {
  if (previous === current) return null;
  if (previous === 0) return "attention.decision_opened";
  if (current === 0) return "attention.decision_closed";

  return "attention.decisions_changed";
}

export function buildAttentionConsumer(
  deps: AttentionConsumerDeps = {},
): DomainEventConsumer {
  return {
    id: "attention-notifications",
    // Forward-only: a first registration must not replay months of history into
    // somebody's phone.
    startFrom: "now",
    async handle(events: DomainEventRow[]): Promise<void> {
      const client: Db = deps.db ?? getDb();
      const decisionsFor =
        deps.decisionsFor ??
        (async (userId, role) =>
          (await computeDecisionsQueue(userId, role)).count);

      // One pass per READER, not per event: three events that move the same
      // reader's count are one notification, which is the whole point of D6.
      const readers = new Map<string, "admin" | "member" | "viewer">();
      // One lookup per distinct PROJECT, not per event: `readersOf` scans users
      // and project_members, and a batch routinely carries many events from one
      // project. The answer depends on nothing else in the event.
      const projectIds = new Set(
        events
          .filter((event) => ATTENTION_KIND_SET.has(event.kind))
          .map((event) => event.projectId),
      );

      for (const projectId of projectIds) {
        try {
          for (const reader of await readersOf(client, projectId)) {
            readers.set(reader.id, reader.role);
          }
        } catch (err) {
          log.warn(
            {
              projectId,
              err: err instanceof Error ? err.message : String(err),
            },
            "attention consumer could not resolve readers (poison-safe)",
          );
        }
      }

      for (const [userId, role] of readers) {
        try {
          const current = await decisionsFor(userId, role);
          const previous = await lastPublishedCount(client, userId);

          // A reader this consumer has never published for is seeded silently at
          // zero: their FIRST notification should be a real change, not a
          // restatement of a backlog they already know about.
          const baseline = previous ?? 0;
          const type = deltaTypeFor(baseline, current);

          if (type === null) continue;

          await emitWebhookEvent({
            db: client,
            type,
            ownerUserId: userId,
            data: { decisions: current, previous: baseline },
          });
        } catch (err) {
          log.warn(
            {
              userId,
              code: isMaisterError(err) ? err.code : "UNKNOWN",
              err: err instanceof Error ? err.message : String(err),
            },
            "attention consumer skipped reader (poison-safe — never throws)",
          );
        }
      }
    },
  };
}

export const attentionNotificationsConsumer = buildAttentionConsumer();
