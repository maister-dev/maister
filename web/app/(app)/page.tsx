import type { ActivityRowLabels } from "@/components/activity/activity-row-list";
import type { NowTilesLabels } from "@/components/attention/now-tiles";
import type { WorkRowsLabels } from "@/components/work/work-rows-table";
import type { WorkInFlightStage } from "@/lib/work/stage";
import type { Metadata } from "next";
import type { ReactElement, ReactNode } from "react";

import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import clsx from "clsx";

import { ActivityRowList } from "@/components/activity/activity-row-list";
import { DecisionSections } from "@/components/inbox/decision-sections";
import { EmptyState } from "@/components/portfolio/empty-state";
import { HitlInboxList } from "@/components/inbox/hitl-inbox-list";
import { NowTiles } from "@/components/attention/now-tiles";
import { OnboardingChecklist } from "@/components/portfolio/onboarding-checklist";
import { ScratchLaunchPopover } from "@/components/chrome/scratch-launch-popover";
import { WorkRowsTable } from "@/components/work/work-rows-table";
import {
  ACTIVITY_FEED_KINDS,
  getCrossProjectActivityFeed,
} from "@/lib/queries/activity-feed";
import { buildActivityRowLabels } from "@/lib/activity/activity-row-labels";
import { buildWorkRowsLabels } from "@/lib/work/work-row-labels";
import { countWorkInFlightByStage } from "@/lib/work/stage-counts";
import { getActivityCursor } from "@/lib/queries/activity-cursor";
import { getDecisionsQueue, hitlDecisionsOf } from "@/lib/queries/decisions";
import { getPortfolio } from "@/lib/queries/portfolio";
import { getWorkTable } from "@/lib/queries/work-table";
import {
  groupWorkTableRows,
  normalizeDeskStageFilter,
} from "@/lib/work/work-table-view";
import { isWorkInFlight, WORK_IN_FLIGHT_STAGES } from "@/lib/work/stage";
import { requireActiveSession } from "@/lib/authz";
import { splitAtCursor } from "@/lib/activity/activity-view";

/**
 * The Desk (`NAV-01`, ADR-172 D1; ADR-174) — `/`.
 *
 * It COMPOSES. Every number comes from a read model this milestone already
 * shipped, and every region renders through the component the owning surface
 * renders: `DecisionSections` + `HitlInboxList` from `/inbox`, `WorkRowsTable`
 * from `/work`, `ActivityRowList` from `/activity`. A second copy of any of them
 * would drift, which is the failure ADR-172 D1 exists to prevent.
 *
 * ADR-174 adds the rule the composition alone did not give: ONE OBJECT PER WORK
 * ITEM. The Now strip is a summary of the work table rather than a second
 * population beside it, so its five numbers are counted from the same rows.
 *
 * It adds NO mutation path: the inline actions on a decision card post to the
 * same promote / recover / discard routes `/inbox` uses.
 */

/** How much of each region the Desk shows before deferring to its full surface. */
const DESK_WORK_ROWS = 12;
const DESK_ACTIVITY_ROWS = 12;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("desk");

  return { title: t("title") };
}

export default async function DeskPage({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<ReactElement> {
  const user = await requireActiveSession();
  const [params, t, tInbox, tPortfolio, tStage, tWork, tActivity, locale] =
    await Promise.all([
      searchParams,
      getTranslations("desk"),
      getTranslations("inbox"),
      getTranslations("portfolio"),
      getTranslations("workStage"),
      getTranslations("work"),
      getTranslations("activityFeed"),
      getLocale(),
    ]);

  // ADR-169 D8/ATN-05: `getDecisionsQueue` is the ONE canonical queue, and it is
  // React-`cache`d — so the rail badge, `/inbox` and this page are the same
  // computation rather than three free to disagree.
  const [portfolio, queue, table, feed, cursor] = await Promise.all([
    getPortfolio(user.id, user.role),
    getDecisionsQueue(user.id, user.role),
    getWorkTable({ id: user.id, role: user.role }),
    getCrossProjectActivityFeed({ id: user.id, role: user.role }),
    getActivityCursor(user.id),
  ]);

  const now = new Date();
  // ATN-01: the cards and the number above them are ONE population.
  const hitlItems = hitlDecisionsOf(queue.items);
  const hasProjects = portfolio.projects.length > 0;
  const inFlight = table.rows.filter((row) => isWorkInFlight(row.stage));
  // REQ-D2: counted over EVERY in-flight row, before the filter and before the
  // slice. A strip counted later would answer "what is on this page" while
  // claiming to answer "what is in flight".
  const stageCounts = countWorkInFlightByStage(inFlight);
  const activeStage = normalizeDeskStageFilter(params);
  // REQ-D3: the filter narrows BEFORE the slice, so `?stage=Crashed` shows the
  // first 12 crashed rows rather than the crashed rows among the first 12.
  const visible =
    activeStage === null
      ? inFlight
      : inFlight.filter((row) => row.stage === activeStage);
  const workGroups = groupWorkTableRows(
    visible.slice(0, DESK_WORK_ROWS),
    "project",
  );
  const activity = splitAtCursor(
    feed.rows.slice(0, DESK_ACTIVITY_ROWS),
    cursor,
  );

  // The strip reads the SAME `workStage` namespace the row chips read, so a
  // tile and the rows it filters to can never name their stage differently.
  const nowLabels: NowTilesLabels = {
    heading: t("nowLabel"),
    names: Object.fromEntries(
      WORK_IN_FLIGHT_STAGES.map((stage) => [stage, tStage(stage)]),
    ) as Record<WorkInFlightStage, string>,
  };
  const workLabels: WorkRowsLabels = buildWorkRowsLabels(tWork, tStage);
  const activityLabels: ActivityRowLabels = buildActivityRowLabels(
    tActivity,
    ACTIVITY_FEED_KINDS,
  );

  return (
    <div className="flex w-full flex-col gap-7">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-mute">
            {t("eyebrow")}
          </div>
        </div>
        <h1 className="m-0 text-[30px] font-semibold tracking-[-0.03em] text-ink">
          {t("title")}
        </h1>
      </header>

      {/* EDGE-NAV-01: the composer is absent until a project exists — there is
          nowhere for a scratch run to go. */}
      {hasProjects ? (
        <ScratchLaunchPopover
          hint={tPortfolio("launchHint")}
          label={t("composer")}
          title={t("composerTitle")}
          variant="composer"
        />
      ) : null}

      <NowTiles
        activeStage={activeStage}
        counts={stageCounts}
        labels={nowLabels}
        locale={locale}
      />

      {hasProjects ? null : (
        <div className="flex flex-col gap-5" data-testid="desk-empty">
          <p className="m-0 text-[13.5px] text-mute">{t("emptyLead")}</p>
          <OnboardingChecklist
            labels={{
              connected: tPortfolio("onboardingConnected"),
              flowReady: tPortfolio("onboardingFlowReady"),
              taskLaunched: tPortfolio("onboardingTaskLaunched"),
              title: tPortfolio("onboardingTitle"),
            }}
            progress={portfolio.onboarding}
          />
          <EmptyState canCreate={user.role === "admin"} />
        </div>
      )}

      {/*
        EDGE-NAV-02: ONE column below `xl`, so the narrow stack is exactly the
        source order — Decisions, then Work, then Activity.

        Desktop wants a different arrangement (Activity beside Decisions, the
        table full width below it), and that is done with explicit grid
        placement rather than by reordering the source. Moving Work after
        Activity in the source would fix desktop and silently break narrow,
        which is what the first cut of this page did.
      */}
      <div className="grid grid-cols-1 gap-7 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <DeskRegion
          action={{ href: "/inbox", label: t("decisionsAll") }}
          className="xl:col-start-1 xl:row-start-1"
          count={{
            value: queue.count,
            label: t("decisionsCount").replace("$count", String(queue.count)),
          }}
          testid="desk-decisions"
          title={t("decisionsTitle")}
        >
          {queue.count === 0 ? (
            <DeskEmpty text={t("decisionsEmpty")} />
          ) : (
            <div className="flex flex-col gap-6">
              {hitlItems.length > 0 ? (
                <HitlInboxList
                  canAct={user.role !== "viewer"}
                  currentUserId={user.id}
                  items={hitlItems}
                />
              ) : null}
              <DecisionSections
                items={queue.items}
                labels={{
                  promotableTitle: tInbox("decisions.promotableTitle"),
                  crashedTitle: tInbox("decisions.crashedTitle"),
                  flaggedTitle: tInbox("decisions.flaggedTitle"),
                  review: tInbox("decisions.review"),
                  openTask: tInbox("decisions.openTask"),
                  stage: workLabels.stage,
                }}
              />
            </div>
          )}
        </DeskRegion>

        {/* `min-w-0`: a grid item defaults to `min-width: auto`, which sizes it
            to the 1180px table's min-content width and stretches the whole page
            sideways — the inner `overflow-x-auto` never gets a chance. This is
            what keeps `EDGE-NAV-02`'s "no page-level horizontal scroll" true. */}
        <div className="min-w-0 xl:col-span-2 xl:col-start-1 xl:row-start-2">
          <DeskRegion
            action={{ href: "/work", label: t("workAll") }}
            count={{
              value: visible.length,
              label: t("workCount").replace("$count", String(visible.length)),
            }}
            testid="desk-work"
            title={t("workTitle")}
          >
            {visible.length === 0 ? (
              <DeskEmpty
                clear={
                  activeStage === null
                    ? undefined
                    : { href: "/", label: t("workClearFilter") }
                }
                testid={
                  activeStage === null
                    ? "desk-work-empty"
                    : "desk-work-filtered"
                }
                text={
                  activeStage === null
                    ? t("workEmpty")
                    : t("workEmptyFiltered").replace(
                        "$stage",
                        tStage(activeStage),
                      )
                }
              />
            ) : (
              <WorkRowsTable
                groupBy="project"
                groups={workGroups}
                labels={workLabels}
                locale={locale}
                now={now}
              />
            )}
          </DeskRegion>
        </div>
        <DeskRegion
          action={{ href: "/activity", label: t("activityAll") }}
          className="xl:col-start-2 xl:row-start-1"
          testid="desk-activity"
          title={t("activityTitle")}
        >
          {activity.unread.length + activity.seen.length === 0 ? (
            <DeskEmpty text={t("activityEmpty")} />
          ) : (
            <ActivityRowList
              divider={activity.divider}
              labels={activityLabels}
              locale={locale}
              now={now}
              seen={activity.seen}
              unread={activity.unread}
            />
          )}
        </DeskRegion>
      </div>
    </div>
  );
}

function DeskRegion({
  title,
  count,
  action,
  testid,
  className,
  children,
}: {
  title: string;
  count?: { value: number; label: string };
  action: { href: string; label: string };
  testid: string;
  className?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section
      aria-label={title}
      className={clsx("flex min-w-0 flex-col gap-3.5", className)}
      data-testid={testid}
    >
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="m-0 inline-flex items-center gap-2.5 font-sans text-sm font-bold tracking-[-0.01em] text-ink before:h-[7px] before:w-[7px] before:rounded-full before:bg-amber before:content-['']">
          {title}
        </h2>
        {count ? (
          <>
            {/* A BARE number, with the phrase as an `sr-only` sibling. The rail
                badge learned this the hard way in Phase 5: a testid whose text
                is "3 blocked on you" cannot be read with `Number(...)`, and the
                equality assertion against the badge is the whole point. */}
            <span
              aria-hidden="true"
              className="font-mono text-[11px] text-mute"
              data-testid={`${testid}-count`}
            >
              {count.value}
            </span>
            <span className="sr-only">{count.label}</span>
          </>
        ) : null}
        <Link
          className="ml-auto font-mono text-[11px] text-mute no-underline hover:text-ink"
          href={action.href}
        >
          {action.label}
        </Link>
      </div>
      {children}
    </section>
  );
}

function DeskEmpty({
  text,
  clear,
  testid,
}: {
  text: string;
  clear?: { href: string; label: string };
  testid?: string;
}): ReactElement {
  return (
    <p
      className="m-0 flex flex-col items-center gap-2 rounded-[14px] border border-line bg-paper px-4 py-6 text-center text-[13px] text-mute"
      data-testid={testid}
    >
      {text}
      {clear ? (
        <Link
          className="font-mono text-[11px] text-mute underline hover:text-ink"
          href={clear.href}
        >
          {clear.label}
        </Link>
      ) : null}
    </p>
  );
}
