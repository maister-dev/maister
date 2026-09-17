"use client";

/**
 * The activity feed's ROWS, split out of `activity-feed.tsx` so the Desk can
 * render the same log without re-implementing a row (ADR-172 D1).
 *
 * The filters, the row count and the "mark all as read" control stay with the
 * full `/activity` surface: the cursor is written from one place.
 */

import type { ActivityFeedRow } from "@/lib/queries/activity-feed";
import type { ReactElement } from "react";

import Link from "next/link";
import clsx from "clsx";

// The feed and the work table print the same "how long ago" string; a second
// copy of the unit thresholds is how the two surfaces start disagreeing.
import { workAge } from "@/lib/work/work-table-view";

/**
 * `REQ-D19` — every row names its subject.
 *
 * A row whose task join is absent used to render time + kind + actor + a
 * GENERIC "open the run" label + the project name, naming the thing it is about
 * nowhere. That degradation lands hardest on `run.crashed`, the highest-signal
 * kind in the feed, because a crashed run often has no task joined to it.
 *
 * Eight characters is the repo's existing short-id convention: long enough to
 * identify a run in a list, short enough not to crowd the row.
 */
const SHORT_RUN_ID_LENGTH = 8;

/** What a ROW needs. `ActivityFeedLabels` extends it. */
export interface ActivityRowLabels {
  /** Keyed by the raw kind, so the client needs no key transform. */
  kinds: Record<string, string>;
  divider: string;
  openTask: string;
  openRun: string;
  openProject: string;
  webhookAttempts: string;
}

export interface ActivityRowListProps {
  unread: ActivityFeedRow[];
  seen: ActivityFeedRow[];
  divider: boolean;
  labels: ActivityRowLabels;
  locale: string;
  now: Date;
}

export function ActivityRowList({
  unread,
  seen,
  divider,
  labels,
  locale,
  now,
}: ActivityRowListProps): ReactElement {
  const numberFormat = new Intl.NumberFormat(locale);
  const dateFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "short",
  });

  return (
    <ul className="m-0 list-none rounded-[14px] border border-line bg-paper p-0">
      {unread.map((row) => (
        <ActivityRow
          key={row.id}
          isUnread
          dateFormat={dateFormat}
          labels={labels}
          now={now}
          numberFormat={numberFormat}
          row={row}
        />
      ))}
      {divider ? (
        <li
          className="flex items-center gap-2 border-b border-line px-3 py-1.5"
          data-testid="activity-divider"
        >
          <span className="h-px grow bg-amber" />
          <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-amber">
            {labels.divider}
          </span>
          <span className="h-px grow bg-amber" />
        </li>
      ) : null}
      {seen.map((row) => (
        <ActivityRow
          key={row.id}
          dateFormat={dateFormat}
          isUnread={false}
          labels={labels}
          now={now}
          numberFormat={numberFormat}
          row={row}
        />
      ))}
    </ul>
  );
}

function ActivityRow({
  row,
  isUnread,
  labels,
  numberFormat,
  dateFormat,
  now,
}: {
  row: ActivityFeedRow;
  isUnread: boolean;
  labels: ActivityRowLabels;
  numberFormat: Intl.NumberFormat;
  dateFormat: Intl.DateTimeFormat;
  now: Date;
}): ReactElement {
  // Mirrors the task link's OWN render condition below, not just `taskKey`: a
  // key that arrives without its number renders no link, so such a row is
  // unnamed by the narrower path and needs the fallback too.
  const namesTask = row.taskKey !== null && row.taskNumber !== null;

  return (
    <li
      className={clsx(
        "flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-line px-3 py-2 last:border-b-0",
        isUnread && "bg-ivory",
      )}
      data-activity-kind={row.kind}
      data-activity-unread={isUnread ? "true" : "false"}
      data-testid="activity-row"
    >
      <time
        suppressHydrationWarning
        className="w-[112px] shrink-0 font-mono text-[11px] text-mute"
        dateTime={row.occurredAt.toISOString()}
        title={dateFormat.format(row.occurredAt)}
      >
        {workAge(row.occurredAt, now)}
      </time>
      <span className="text-[12.5px] font-semibold text-ink">
        {labels.kinds[row.kind] ?? row.kind}
      </span>
      {row.actor ? (
        <span className="text-[12.5px] text-ink-2">{row.actor.label}</span>
      ) : null}
      {row.taskKey && row.taskNumber !== null ? (
        <Link
          className="font-mono text-[12px] text-ink no-underline"
          href={`/projects/${row.projectSlug}/tasks/${row.taskNumber}`}
          title={labels.openTask}
        >
          {row.taskKey}
        </Link>
      ) : null}
      {row.taskTitle ? (
        <span className="min-w-0 grow truncate text-[12.5px] text-ink-2">
          {row.taskTitle}
        </span>
      ) : null}
      {row.gateId ? (
        <span className="font-mono text-[11.5px] text-mute">{row.gateId}</span>
      ) : null}
      {row.webhook ? (
        <span className="font-mono text-[11.5px] text-mute">
          {row.webhook.subscriptionName}
          {row.webhook.httpStatus === null
            ? ""
            : ` · ${row.webhook.httpStatus}`}
          {` · ${labels.webhookAttempts.replace(
            "$count",
            numberFormat.format(row.webhook.attemptCount),
          )}`}
        </span>
      ) : null}
      {row.runId ? (
        <Link
          className={clsx(
            "font-mono text-[11.5px] no-underline",
            namesTask ? "text-mute" : "text-ink",
          )}
          href={`/runs/${row.runId}`}
          title={labels.openRun}
        >
          {/* The task is the better name when there is one; two identifiers on
              one row is noise. The id only stands in when nothing else does. */}
          {namesTask ? labels.openRun : row.runId.slice(0, SHORT_RUN_ID_LENGTH)}
        </Link>
      ) : null}
      <Link
        className="ml-auto font-mono text-[11px] text-mute no-underline"
        href={`/projects/${row.projectSlug}`}
        title={labels.openProject}
      >
        {row.projectName}
      </Link>
    </li>
  );
}
