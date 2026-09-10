"use client";

import type { ActivityFeedRow } from "@/lib/queries/activity-feed";
import type { ActivityFilters } from "@/lib/activity/activity-view";
import type { ReactElement, ReactNode } from "react";

import { CheckCircleIcon } from "@heroicons/react/24/outline";
import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import clsx from "clsx";

// The feed and the work table print the same "how long ago" string; a second
// copy of the unit thresholds is how the two surfaces start disagreeing.
import { workAge } from "@/lib/work/work-table-view";

export interface ActivityProjectOption {
  slug: string;
  name: string;
}

/**
 * Option lists arrive already resolved and already translated. The vocabulary
 * lives beside the read model in a `server-only` module, and the house rule is
 * that a client component imports TYPES from those, never values.
 */
export interface ActivityOption {
  value: string;
  label: string;
}

export interface ActivityFeedLabels {
  rowCount: string;
  latestOnly: string;
  filters: Record<
    | "project"
    | "allProjects"
    | "actor"
    | "allActors"
    | "kind"
    | "allKinds"
    | "mine"
    | "apply",
    string
  >;
  /** Keyed by the raw kind, so the client needs no key transform. */
  kinds: Record<string, string>;
  divider: string;
  caughtUp: string;
  neverLooked: string;
  markRead: string;
  markReadFailed: string;
  empty: Record<"noProjects" | "noRows", string>;
  openTask: string;
  openRun: string;
  openProject: string;
  webhookAttempts: string;
}

export interface ActivityFeedProps {
  unread: ActivityFeedRow[];
  seen: ActivityFeedRow[];
  divider: boolean;
  hasMore: boolean;
  limit: number;
  totalRows: number;
  filters: ActivityFilters;
  projectOptions: ActivityProjectOption[];
  actorOptions: ActivityOption[];
  kindOptions: ActivityOption[];
  hasProjects: boolean;
  hasCursor: boolean;
  newestAt: string | null;
  labels: ActivityFeedLabels;
  locale: string;
  now: Date;
}

function FilterSelect({
  children,
  label,
  name,
  value,
}: {
  children: ReactNode;
  label: string;
  name: string;
  value: string;
}): ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-mute">
        {label}
      </span>
      <select
        className="h-9 rounded-[10px] border border-line bg-paper px-2 text-[12.5px] text-ink"
        defaultValue={value}
        name={name}
      >
        {children}
      </select>
    </label>
  );
}

export function ActivityFeed({
  unread,
  seen,
  divider,
  hasMore,
  limit,
  totalRows,
  filters,
  projectOptions,
  actorOptions,
  kindOptions,
  hasProjects,
  hasCursor,
  newestAt,
  labels,
  locale,
  now,
}: ActivityFeedProps): ReactElement {
  const router = useRouter();
  const [marking, setMarking] = useState(false);
  const [markFailed, setMarkFailed] = useState(false);
  const numberFormat = new Intl.NumberFormat(locale);
  const dateFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "short",
  });

  async function markAllRead(): Promise<void> {
    if (!newestAt) return;
    setMarking(true);
    setMarkFailed(false);
    try {
      const response = await fetch("/api/activity/cursor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seenThrough: newestAt }),
      });

      if (!response.ok) {
        setMarkFailed(true);

        return;
      }
      router.refresh();
    } catch {
      setMarkFailed(true);
    } finally {
      setMarking(false);
    }
  }

  function renderRow(row: ActivityFeedRow, isUnread: boolean): ReactElement {
    return (
      <li
        key={row.id}
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
          <span className="font-mono text-[11.5px] text-mute">
            {row.gateId}
          </span>
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
            className="font-mono text-[11.5px] text-mute no-underline"
            href={`/runs/${row.runId}`}
            title={labels.openRun}
          >
            {labels.openRun}
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

  return (
    <div className="flex w-full flex-col gap-4">
      <form
        action="/activity"
        className="grid gap-3 rounded-[14px] border border-line bg-paper px-4 py-4 shadow-[var(--shadow-sm)] md:grid-cols-[minmax(160px,1.1fr)_minmax(140px,0.8fr)_minmax(170px,1fr)_auto_auto]"
      >
        <FilterSelect
          label={labels.filters.project}
          name="project"
          value={filters.projectSlug ?? ""}
        >
          <option value="">{labels.filters.allProjects}</option>
          {projectOptions.map((project) => (
            <option key={project.slug} value={project.slug}>
              {project.name}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          label={labels.filters.actor}
          name="actor"
          value={filters.actorType ?? ""}
        >
          <option value="">{labels.filters.allActors}</option>
          {actorOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          label={labels.filters.kind}
          name="kind"
          value={filters.kind ?? ""}
        >
          <option value="">{labels.filters.allKinds}</option>
          {kindOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </FilterSelect>
        <label className="flex items-end gap-2 pb-2 text-[12.5px] text-ink">
          <input
            defaultChecked={filters.mine}
            name="mine"
            type="checkbox"
            value="1"
          />
          {labels.filters.mine}
        </label>
        <div className="flex items-end">
          <button
            className="h-9 rounded-[10px] border border-line bg-ivory px-4 text-[12.5px] font-semibold text-ink"
            type="submit"
          >
            {labels.filters.apply}
          </button>
        </div>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] text-mute">
          {labels.rowCount.replace("$count", numberFormat.format(totalRows))}
        </span>
        {hasMore ? (
          <span className="font-mono text-[11px] text-mute">
            {labels.latestOnly.replace("$count", numberFormat.format(limit))}
          </span>
        ) : null}
        {!hasCursor && totalRows > 0 ? (
          <span className="font-mono text-[11px] text-mute">
            {labels.neverLooked}
          </span>
        ) : null}
        {unread.length === 0 && hasCursor && totalRows > 0 ? (
          <span
            className="inline-flex items-center gap-1 font-mono text-[11px] text-good"
            data-testid="activity-caught-up"
          >
            <CheckCircleIcon aria-hidden="true" className="h-3.5 w-3.5" />
            {labels.caughtUp}
          </span>
        ) : null}
        {newestAt ? (
          <button
            className="ml-auto h-8 rounded-[10px] border border-line bg-paper px-3 text-[12.5px] text-ink disabled:opacity-60"
            data-testid="activity-mark-read"
            disabled={marking}
            type="button"
            onClick={() => void markAllRead()}
          >
            {labels.markRead}
          </button>
        ) : null}
      </div>

      {markFailed ? (
        <p className="m-0 text-[12.5px] text-danger" role="alert">
          {labels.markReadFailed}
        </p>
      ) : null}

      {totalRows === 0 ? (
        <p
          className="m-0 rounded-[14px] border border-line bg-paper px-4 py-6 text-center text-[13px] text-mute"
          data-testid="activity-empty"
        >
          {hasProjects ? labels.empty.noRows : labels.empty.noProjects}
        </p>
      ) : (
        <ul className="m-0 list-none rounded-[14px] border border-line bg-paper p-0">
          {unread.map((row) => renderRow(row, true))}
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
          {seen.map((row) => renderRow(row, false))}
        </ul>
      )}
    </div>
  );
}
