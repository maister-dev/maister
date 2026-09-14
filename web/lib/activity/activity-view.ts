/**
 * Pure view helpers for `/activity` (`ATN-10`, ADR-169, ADR-172).
 *
 * Everything here is a function of the query string or of already-fetched rows,
 * which is where a silently-dropped filter or an off-by-one divider hides. No
 * database, no `server-only` — the page and its tests share these.
 */

import type {
  ActivityActorType,
  ActivityFeedKind,
  ActivityFeedRow,
} from "@/lib/queries/activity-feed";

import {
  ACTIVITY_ACTOR_TYPES,
  ACTIVITY_FEED_KINDS,
  isActivityFeedKind,
} from "@/lib/queries/activity-feed";

export interface ActivityFilters {
  projectSlug: string | null;
  actorType: ActivityActorType | null;
  kind: ActivityFeedKind | null;
  mine: boolean;
}

export interface ActivitySplit {
  unread: ActivityFeedRow[];
  seen: ActivityFeedRow[];
  divider: boolean;
}

type QueryParams = Record<string, string | string[] | undefined>;

/**
 * A repeated parameter is ambiguous, so it is DROPPED rather than resolved by
 * picking one — a deep link that means two things must not silently mean one.
 */
function single(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();

  return trimmed === "" ? null : trimmed;
}

export function normalizeActivityFilters(params: QueryParams): ActivityFilters {
  const actorType = single(params.actor);
  const kind = single(params.kind);

  return {
    // Echoed verbatim: an unknown or unreachable slug intersects to nothing
    // downstream, so the filter is dropped, never refused.
    projectSlug: single(params.project),
    actorType: (ACTIVITY_ACTOR_TYPES as readonly string[]).includes(
      actorType ?? "",
    )
      ? (actorType as ActivityActorType)
      : null,
    kind: kind !== null && isActivityFeedKind(kind) ? kind : null,
    mine: single(params.mine) === "1",
  };
}

export function activityFiltersToQuery(filters: ActivityFilters): string {
  const query = new URLSearchParams();

  if (filters.projectSlug) query.set("project", filters.projectSlug);
  if (filters.actorType) query.set("actor", filters.actorType);
  if (filters.kind) query.set("kind", filters.kind);
  if (filters.mine) query.set("mine", "1");

  return query.toString();
}

/**
 * EDGE-ATN-01: with no cursor row the reader has never looked, so there is no
 * "your last visit" to draw — NOT a divider above every row, which would claim
 * everything is new when the truth is that nothing is known.
 */
export function splitAtCursor(
  rows: ActivityFeedRow[],
  seenThrough: Date | null,
): ActivitySplit {
  if (seenThrough === null) return { unread: [], seen: rows, divider: false };

  const cutoff = seenThrough.getTime();
  const unread = rows.filter((row) => row.occurredAt.getTime() > cutoff);
  const seen = rows.filter((row) => row.occurredAt.getTime() <= cutoff);

  return { unread, seen, divider: unread.length > 0 && seen.length > 0 };
}

/**
 * `run.done` is not a legal message key — next-intl reads a dot as a namespace
 * separator, so `kinds.run.done` would look for a `run` object that is not
 * there. The catalogs key on the underscored form instead.
 */
export function activityKindKey(kind: ActivityFeedKind): string {
  return kind.replace(".", "_");
}

export const ACTIVITY_KIND_KEYS = ACTIVITY_FEED_KINDS.map(activityKindKey);
