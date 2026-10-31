import "server-only";

/** Shared attention publisher: ordinary decision deltas and newly actionable incident revisions. */

import type { DomainEventConsumer } from "@/lib/domain-events/consumers";
import type { DomainEventRow } from "@/lib/db/schema";

import { sql } from "drizzle-orm";
import pino from "pino";

import { ATTENTION_PLANE_EVENT_KINDS } from "@/lib/domain-events/taxonomy";
import {
  readAttentionDecisionSnapshot,
  lockUnpublishedAttentionEpisodes,
  recordAttentionEpisodePublications,
  type AttentionDecisionSnapshot,
} from "@/lib/notifications/attention-publication";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants (matches cost-rollup-reconcile).
type Db = any;

const log = pino({
  name: "notifications-attention-consumer",
  level: process.env.LOG_LEVEL ?? "info",
});

/**
 * The consumer wakes on the UNION: everything that can move the `decisions`
 * count. `DECISION_OPENING_EVENT_KINDS` are the two that open one directly;
 * `ATTENTION_EVENT_KINDS` are the run-terminal and triage facts that can close
 * or open one as a side effect.
 */
const ATTENTION_KIND_SET: ReadonlySet<string> = new Set<string>(
  ATTENTION_PLANE_EVENT_KINDS,
);

export interface AttentionConsumerDeps {
  db?: Db;
  /** Injected so the unit test can drive the count without a database. */
  decisionsFor?: (
    userId: string,
    role: "admin" | "member" | "viewer",
  ) => Promise<AttentionDecisionSnapshot>;
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
          readAttentionDecisionSnapshot(client, userId, role));

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
          await emitDecisionsDelta(client, userId, role, decisionsFor);
        } catch (err) {
          // Swallowed, and THAT IS THE RETRY DECISION, not an oversight.
          //
          // `dispatchDomainEvents` advances the cursor on a clean return, so a
          // swallowed failure used to lose the notification outright. It no
          // longer does: the `system_sweep` delta backstop recomputes every
          // reader who holds an enabled intent — which is exactly the
          // population that could have received anything — so a failure here
          // costs latency, not delivery.
          //
          // Rethrowing instead would stall the cursor for EVERY reader on one
          // broken one, and a deployment with a single reader cannot even tell
          // the two cases apart: "all readers failed" and "the only reader is
          // poison" are the same observation.
          log.warn(
            {
              userId,
              code: isMaisterError(err) ? err.code : "UNKNOWN",
              err: err instanceof Error ? err.message : String(err),
            },
            "attention consumer skipped reader — backstop will retry",
          );
        }
      }
    },
  };
}

/**
 * Per-OWNER, never global: two readers' deltas are independent facts, and one
 * lock over the whole pass would let a single slow decision queue hold up every
 * other reader in the batch.
 */
const DECISION_DELTA_LOCK_NAMESPACE = 0x61746e_64;

/** Owner lock precedes episode locks; publication, receipts and baseline commit atomically. */
export async function emitDecisionsDelta(
  client: Db,
  userId: string,
  role: "admin" | "member" | "viewer",
  decisionsFor: (
    userId: string,
    role: "admin" | "member" | "viewer",
  ) => Promise<AttentionDecisionSnapshot>,
): Promise<boolean> {
  return client.transaction(async (tx: Db) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${DECISION_DELTA_LOCK_NAMESPACE}::int, hashtext(${userId})::int)`,
    );
    const episodes = await lockUnpublishedAttentionEpisodes(tx, userId, role);
    const current = await decisionsFor(userId, role);
    const previousRows = await tx.execute(
      sql`SELECT decisions,ordinary_decisions FROM attention_publication_states WHERE owner_user_id=${userId}`,
    );
    const previous = previousRows.rows[0] as
      { decisions: number; ordinary_decisions: number } | undefined;
    const baseline = previous?.decisions ?? 0;
    const ordinaryChanged =
      current.ordinaryDecisions !== (previous?.ordinary_decisions ?? 0);
    const type =
      ordinaryChanged || episodes.length > 0
        ? (deltaTypeFor(baseline, current.decisions) ??
          "attention.decisions_changed")
        : null;
    const eventId =
      type === null
        ? null
        : await emitWebhookEvent({
            db: tx,
            type,
            ownerUserId: userId,
            data: { decisions: current.decisions, previous: baseline },
          });

    if (eventId !== null)
      await recordAttentionEpisodePublications(tx, userId, episodes, eventId);
    await tx.execute(sql`INSERT INTO attention_publication_states(owner_user_id,decisions,ordinary_decisions,notification_event_id)
      VALUES (${userId},${current.decisions},${current.ordinaryDecisions},${eventId})
      ON CONFLICT(owner_user_id) DO UPDATE SET decisions=excluded.decisions,
        ordinary_decisions=excluded.ordinary_decisions,
        notification_event_id=coalesce(excluded.notification_event_id,attention_publication_states.notification_event_id),updated_at=clock_timestamp()`);
    log.debug(
      {
        userId,
        decisions: current.decisions,
        ordinaryDecisions: current.ordinaryDecisions,
        newEpisodeCount: episodes.length,
        eventId,
      },
      "attention publication observed",
    );

    return eventId !== null;
  });
}

export const attentionNotificationsConsumer = buildAttentionConsumer();
