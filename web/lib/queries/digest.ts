import "server-only";

/**
 * The Now tiles and the catch-up digest (`ATN-12`, ADR-168, ADR-171).
 *
 * One bounded window — since the reader's cursor, or the same 24 hours
 * `updates` falls back to — reduced to five numbers: promoted · crashed · new
 * decisions · new events · tokens spent. Read-only; this module writes nothing
 * and decides nothing.
 *
 * `formatDigest` is DETERMINISTIC by construction: no clock of its own, no
 * agent, no narration, no currency. Given the same window and the same labels
 * it returns the same bytes, which is what later makes it safe to send as a
 * push notification payload rather than a thing that reads differently every
 * time it is rendered.
 */

import type { GlobalRole } from "@/lib/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, count, eq, gt, gte, inArray, isNotNull } from "drizzle-orm";
import pino from "pino";

import { ATTENTION_EVENT_KINDS } from "@/lib/domain-events/taxonomy";
import { getActivityCursor } from "@/lib/queries/activity-cursor";
import { getDb } from "@/lib/db/client";
import { getDecisionsQueue } from "@/lib/queries/decisions";
import {
  getUpdatesCount,
  UPDATES_NO_CURSOR_WINDOW_MS,
} from "@/lib/queries/updates";
import { getVisibleProjectIds } from "@/lib/queries/visible-projects";
import { queryTokensSpentSince } from "@/lib/runs/cost-rollups";
import * as schema from "@/lib/db/schema";

const { domainEvents, workspaces } = schema;

const log = pino({
  name: "queries-digest",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Order is the render order, and the digest's clause order. */
export const NOW_TILE_IDS = [
  "promoted",
  "crashed",
  "decisions",
  "events",
  "tokens",
] as const;

export type NowTileId = (typeof NOW_TILE_IDS)[number];

/**
 * A tile is only useful if it goes somewhere — a number with no destination is
 * a dead end on a home screen whose whole job is routing.
 */
export const NOW_TILE_HREFS = {
  promoted: "/work?stage=Promoted",
  crashed: "/work?stage=Crashed",
  decisions: "/inbox",
  events: "/activity",
  tokens: "/observatory",
} as const satisfies Record<NowTileId, string>;

export interface NowTile {
  id: NowTileId;
  value: number;
  href: string;
}

export interface DigestWindow {
  since: Date;
  hasCursor: boolean;
  tiles: NowTile[];
}

export interface DigestUser {
  id: string;
  role: GlobalRole;
}

export type DigestLabels = Record<NowTileId | "empty", string>;

/**
 * `decisionsQueue` exists for ONE caller: the digest notification trigger, which
 * runs inside a scheduler sweep rather than a request.
 *
 * The default `getDecisionsQueue` is React-`cache`d, which is exactly right in a
 * render — the Desk's tiles and its Decisions region must be the SAME
 * computation (`ATN-05`). In a long-lived background process that memo has no
 * request to scope it, so the trigger passes the uncached `computeDecisionsQueue`
 * instead; otherwise every reader in one sweep could be notified with the first
 * reader's count.
 */
export interface NowTileOptions {
  decisionsQueue?: typeof getDecisionsQueue;
}

export async function getNowTileCounts(
  user: DigestUser,
  now: Date = new Date(),
  opts: NowTileOptions = {},
): Promise<DigestWindow> {
  const client = getDb() as NodePgDatabase<typeof schema>;
  const decisionsQueue = opts.decisionsQueue ?? getDecisionsQueue;
  const projectIds = await getVisibleProjectIds(user.id, user.role, client);
  const cursor = await getActivityCursor(user.id, client);
  const since = cursor ?? new Date(now.getTime() - UPDATES_NO_CURSOR_WINDOW_MS);

  if (projectIds.length === 0) {
    return {
      since,
      hasCursor: cursor !== null,
      tiles: NOW_TILE_IDS.map((id) => ({
        id,
        value: 0,
        href: NOW_TILE_HREFS[id],
      })),
    };
  }

  const [promotedRows, crashedRows, decisions, events, tokens] =
    await Promise.all([
      client
        .select({ n: count() })
        .from(workspaces)
        .where(
          and(
            inArray(workspaces.projectId, projectIds),
            isNotNull(workspaces.promotedAt),
            gte(workspaces.promotedAt, since),
          ),
        ),
      client
        .select({ n: count() })
        .from(domainEvents)
        .where(
          and(
            inArray(domainEvents.projectId, projectIds),
            eq(domainEvents.kind, "run.crashed"),
            gt(domainEvents.occurredAt, since),
          ),
        ),
      decisionsQueue(user.id, user.role),
      getUpdatesCount(user.id, user.role, now),
      queryTokensSpentSince(projectIds, since, { client }),
    ]);

  // "New" decisions only — a queue item that was already waiting before the
  // reader's last visit is not news, it is a backlog, and the Inbox badge
  // already carries the total.
  const newDecisions = decisions.items.filter(
    (item) => item.since !== null && item.since.getTime() > since.getTime(),
  ).length;

  const values: Record<NowTileId, number> = {
    promoted: Number(promotedRows[0]?.n ?? 0),
    crashed: Number(crashedRows[0]?.n ?? 0),
    decisions: newDecisions,
    events,
    tokens,
  };

  log.debug(
    { userId: user.id, since, hasCursor: cursor !== null, ...values },
    "now tiles",
  );

  return {
    since,
    hasCursor: cursor !== null,
    tiles: NOW_TILE_IDS.map((id) => ({
      id,
      value: values[id],
      href: NOW_TILE_HREFS[id],
    })),
  };
}

/**
 * `ATN-12`. Zero-valued tiles are dropped rather than printed as "0 crashed" —
 * a digest that lists everything that did NOT happen is unreadable — and an
 * all-zero window collapses to a single "nothing happened" clause instead of an
 * empty string, so the sentence is never blank.
 *
 * Every label carries `$count`, consumed by replacement rather than by an ICU
 * template: the same convention the client-rendered counters use, and the
 * reason a locale switch changes the digits without changing the shape.
 *
 * Clause order is taken from `NOW_TILE_IDS`, not from the array the caller
 * passed — determinism has to hold for the same ROW SET, and a caller that
 * reshuffled its tiles must not produce a different sentence out of the same
 * five numbers.
 */
export function formatDigest(
  window: DigestWindow,
  opts: { locale: string; labels: DigestLabels },
): string {
  const numberFormat = new Intl.NumberFormat(opts.locale);
  const byId = new Map(window.tiles.map((tile) => [tile.id, tile.value]));
  const clauses = NOW_TILE_IDS.flatMap((id) => {
    const value = byId.get(id) ?? 0;

    return value > 0
      ? [opts.labels[id].replace("$count", numberFormat.format(value))]
      : [];
  });

  return clauses.length === 0 ? opts.labels.empty : clauses.join(" · ");
}

/**
 * The taxonomy kinds the crashed tile could ever count. Exported so the digest
 * test can assert the tile reads a kind the attention plane still carries — a
 * taxonomy rename would otherwise leave a permanently-zero tile.
 */
export const DIGEST_CRASHED_EVENT_KIND =
  "run.crashed" as const satisfies (typeof ATTENTION_EVENT_KINDS)[number];
