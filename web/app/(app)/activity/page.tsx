import type { ActivityFeedLabels } from "@/components/activity/activity-feed";
import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getLocale, getTranslations } from "next-intl/server";

import { ActivityFeed } from "@/components/activity/activity-feed";
import { AttentionLiveRefresh } from "@/components/attention/attention-live-refresh";
import {
  ACTIVITY_ACTOR_TYPES,
  ACTIVITY_FEED_DEFAULT_LIMIT,
  ACTIVITY_FEED_KINDS,
  getCrossProjectActivityFeed,
} from "@/lib/queries/activity-feed";
import {
  activityKindKey,
  normalizeActivityFilters,
  splitAtCursor,
} from "@/lib/activity/activity-view";
import { getActivityCursor } from "@/lib/queries/activity-cursor";
import { getVisibleProjects } from "@/lib/queries/visible-projects";
import { requireActiveSession } from "@/lib/authz";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("activityFeed");

  return { title: t("title") };
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<ReactElement> {
  const user = await requireActiveSession();
  const [params, t, tRun, locale] = await Promise.all([
    searchParams,
    getTranslations("activityFeed"),
    getTranslations("run"),
    getLocale(),
  ]);
  const filters = normalizeActivityFilters(params);
  const projects = await getVisibleProjects(user.id, user.role);
  // The dropdown names only projects the reader can already reach, and an
  // unknown slug resolves to no id at all — so the filter drops the feed to
  // empty rather than revealing that the project exists.
  const projectId =
    projects.find((project) => project.slug === filters.projectSlug)?.id ??
    null;
  const [feed, seenThrough] = await Promise.all([
    getCrossProjectActivityFeed(
      { id: user.id, role: user.role },
      {
        projectId: filters.projectSlug === null ? null : projectId,
        actorType: filters.actorType,
        kind: filters.kind,
        mine: filters.mine,
      },
    ),
    getActivityCursor(user.id),
  ]);
  // A named-but-unreachable project must not fall back to "everything".
  const rows =
    filters.projectSlug !== null && projectId === null ? [] : feed.rows;
  const split = splitAtCursor(rows, seenThrough);
  // One millisecond PAST the newest rendered row. A `timestamptz` carries
  // microseconds that a JS `Date` has already floored away, so a cursor set to
  // the row's own millisecond is still strictly less than the row — and the row
  // would stay "unseen" forever after a "mark all as read".
  const newestAt =
    rows.length === 0
      ? null
      : new Date(rows[0].occurredAt.getTime() + 1).toISOString();

  const labels: ActivityFeedLabels = {
    rowCount: t("rowCount"),
    latestOnly: t("latestOnly"),
    filters: {
      project: t("filters.project"),
      allProjects: t("filters.allProjects"),
      actor: t("filters.actor"),
      allActors: t("filters.allActors"),
      kind: t("filters.kind"),
      allKinds: t("filters.allKinds"),
      mine: t("filters.mine"),
      apply: t("filters.apply"),
    },
    // Keyed by the RAW kind for the client; the catalogs key on the
    // underscored form because next-intl reads a dot as a namespace separator.
    kinds: Object.fromEntries(
      ACTIVITY_FEED_KINDS.map((kind) => [
        kind,
        t(`kinds.${activityKindKey(kind)}`),
      ]),
    ),
    divider: t("divider"),
    caughtUp: t("caughtUp"),
    neverLooked: t("neverLooked"),
    markRead: t("markRead"),
    markReadFailed: t("markReadFailed"),
    empty: {
      noProjects: t("empty.noProjects"),
      noRows: t("empty.noRows"),
    },
    openTask: t("openTask"),
    openRun: t("openRun"),
    openProject: t("openProject"),
    webhookAttempts: t("webhookAttempts"),
  };

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-mute">
            {t("eyebrow")}
          </div>
          <AttentionLiveRefresh
            labels={{
              disconnected: tRun("streamDisconnected"),
              live: tRun("streamLive"),
              reconnect: tRun("streamReconnect"),
              reconnecting: tRun("streamReconnecting"),
            }}
          />
        </div>
        <div>
          <h1 className="m-0 text-[30px] font-semibold tracking-[-0.03em] text-ink">
            {t("title")}
          </h1>
          <p className="mt-2 max-w-[720px] text-[13.5px] leading-[1.55] text-mute">
            {t("sub")}
          </p>
        </div>
      </header>

      <ActivityFeed
        actorOptions={ACTIVITY_ACTOR_TYPES.map((actorType) => ({
          value: actorType,
          label: t(`actor.${actorType}`),
        }))}
        divider={split.divider}
        filters={filters}
        hasCursor={seenThrough !== null}
        hasMore={feed.hasMore}
        hasProjects={projects.length > 0}
        kindOptions={ACTIVITY_FEED_KINDS.map((kind) => ({
          value: kind,
          label: t(`kinds.${activityKindKey(kind)}`),
        }))}
        labels={labels}
        limit={ACTIVITY_FEED_DEFAULT_LIMIT}
        locale={locale}
        newestAt={newestAt}
        now={new Date()}
        projectOptions={projects.map((project) => ({
          slug: project.slug,
          name: project.name,
        }))}
        seen={split.seen}
        totalRows={rows.length}
        unread={split.unread}
      />
    </div>
  );
}
