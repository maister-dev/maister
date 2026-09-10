"use client";

import type { WorkStageLabels } from "@/components/work/work-stage-chip";
import type { WorkTableRow } from "@/lib/queries/work-table";
import type {
  WorkGroupBy,
  WorkTableFilters,
  WorkTableGroup,
} from "@/lib/work/work-table-view";
import type { ReactElement } from "react";

import { BookmarkIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import Link from "next/link";
import clsx from "clsx";

import { WorkStageChip } from "@/components/work/work-stage-chip";
import { WORK_STAGES } from "@/lib/work/stage";
import {
  WORK_GROUP_BYS,
  workAge,
  workNextAction,
  workTableFiltersToQuery,
} from "@/lib/work/work-table-view";

export interface WorkTableProjectOption {
  slug: string;
  name: string;
}

export interface WorkTableLabels {
  rowCount: string;
  filters: Record<
    "project" | "allProjects" | "stage" | "allStages" | "group" | "apply",
    string
  >;
  group: Record<WorkGroupBy | "mineHeading" | "othersHeading", string>;
  columns: Record<
    | "key"
    | "title"
    | "project"
    | "stage"
    | "run"
    | "readiness"
    | "waitingOn"
    | "blockers"
    | "tokens"
    | "lastActivity"
    | "nextAction",
    string
  >;
  waitingOn: Record<"you" | "anyone" | "since", string>;
  readiness: Record<string, string>;
  nextAction: Record<string, string>;
  stage: WorkStageLabels;
  empty: Record<"noProjects" | "noRows", string>;
  savedViews: Record<
    "label" | "save" | "namePlaceholder" | "remove" | "empty",
    string
  >;
  openTask: string;
  openRun: string;
}

export interface WorkTableProps {
  groups: WorkTableGroup[];
  totalRows: number;
  filters: WorkTableFilters;
  projectOptions: WorkTableProjectOption[];
  hasProjects: boolean;
  labels: WorkTableLabels;
  locale: string;
  now: Date;
}

interface SavedView {
  label: string;
  query: string;
}

const SAVED_VIEWS_KEY = "maister.work.savedViews";

const READINESS_TONE: Record<string, string> = {
  ready: "text-good",
  blocked: "text-danger",
  failed: "text-danger",
  stale: "text-amber",
  waiting: "text-mute",
  overridden: "text-ink-2",
};

const CELL = "px-3 py-2 align-middle";
const HEAD =
  "px-3 py-2 text-left font-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-mute";

function readSavedViews(): SavedView[] {
  try {
    const raw = window.localStorage.getItem(SAVED_VIEWS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];

    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((entry) =>
      entry &&
      typeof entry === "object" &&
      typeof (entry as SavedView).label === "string" &&
      typeof (entry as SavedView).query === "string"
        ? [
            {
              label: (entry as SavedView).label,
              query: (entry as SavedView).query,
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}

export function WorkTable({
  groups,
  totalRows,
  filters,
  projectOptions,
  hasProjects,
  labels,
  locale,
  now,
}: WorkTableProps): ReactElement {
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [draftName, setDraftName] = useState("");
  const numberFormat = new Intl.NumberFormat(locale);
  const dateFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "short",
  });

  // localStorage is read after mount so the server and the first client render
  // agree; saved views are a per-browser convenience, never filter state.
  useEffect(() => {
    setSavedViews(readSavedViews());
  }, []);

  function persist(next: SavedView[]): void {
    setSavedViews(next);
    try {
      window.localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(next));
    } catch {
      // A browser refusing site data still gets a working table.
    }
  }

  function saveCurrentView(): void {
    const label = draftName.trim();

    if (label === "") return;

    persist([
      ...savedViews.filter((view) => view.label !== label),
      { label, query: workTableFiltersToQuery(filters) },
    ]);
    setDraftName("");
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <form
        action="/work"
        className="grid gap-3 rounded-[14px] border border-line bg-paper px-4 py-4 shadow-[var(--shadow-sm)] md:grid-cols-[minmax(160px,1.1fr)_minmax(150px,0.9fr)_minmax(150px,0.9fr)_auto]"
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
          label={labels.filters.stage}
          name="stage"
          value={filters.stage ?? ""}
        >
          <option value="">{labels.filters.allStages}</option>
          {WORK_STAGES.map((stage) => (
            <option key={stage} value={stage}>
              {labels.stage[stage]}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          label={labels.filters.group}
          name="group"
          value={filters.groupBy}
        >
          {WORK_GROUP_BYS.map((groupBy) => (
            <option key={groupBy} value={groupBy}>
              {labels.group[groupBy]}
            </option>
          ))}
        </FilterSelect>
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
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-mute">
            {labels.savedViews.label}
          </span>
          {savedViews.length === 0 ? (
            <span className="text-[12px] text-mute">
              {labels.savedViews.empty}
            </span>
          ) : (
            savedViews.map((view) => (
              <span
                key={view.label}
                className="inline-flex items-center gap-1 rounded-full border border-line bg-ivory px-2 py-0.5"
              >
                <Link
                  className="text-[12px] text-ink no-underline"
                  href={view.query ? `/work?${view.query}` : "/work"}
                >
                  {view.label}
                </Link>
                <button
                  aria-label={labels.savedViews.remove}
                  className="text-mute"
                  title={labels.savedViews.remove}
                  type="button"
                  onClick={() =>
                    persist(savedViews.filter((v) => v.label !== view.label))
                  }
                >
                  <TrashIcon aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              </span>
            ))
          )}
          <input
            aria-label={labels.savedViews.namePlaceholder}
            className="h-8 w-[160px] rounded-[10px] border border-line bg-paper px-2 text-[12.5px] text-ink"
            placeholder={labels.savedViews.namePlaceholder}
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
          />
          <button
            aria-label={labels.savedViews.save}
            className="inline-flex h-8 items-center gap-1 rounded-[10px] border border-line bg-ivory px-2 text-[12.5px] text-ink disabled:opacity-50"
            disabled={draftName.trim() === ""}
            title={labels.savedViews.save}
            type="button"
            onClick={saveCurrentView}
          >
            <BookmarkIcon aria-hidden="true" className="h-4 w-4" />
          </button>
        </span>
      </div>

      {totalRows === 0 ? (
        <p
          className="rounded-[14px] border border-line bg-paper px-4 py-6 text-[13px] text-mute"
          data-testid="work-empty"
        >
          {hasProjects ? labels.empty.noRows : labels.empty.noProjects}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[14px] border border-line bg-paper">
          <table className="w-full min-w-[1180px] border-collapse text-[12.5px]">
            <thead className="border-b border-line bg-ivory">
              <tr>
                <th className={HEAD}>{labels.columns.key}</th>
                <th className={HEAD}>{labels.columns.title}</th>
                <th className={HEAD}>{labels.columns.project}</th>
                <th className={HEAD}>{labels.columns.stage}</th>
                <th className={HEAD}>{labels.columns.run}</th>
                <th className={HEAD}>{labels.columns.readiness}</th>
                <th className={HEAD}>{labels.columns.waitingOn}</th>
                <th className={HEAD}>{labels.columns.blockers}</th>
                <th className={clsx(HEAD, "text-right")}>
                  {labels.columns.tokens}
                </th>
                <th className={HEAD}>{labels.columns.lastActivity}</th>
                <th className={HEAD}>{labels.columns.nextAction}</th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.id} data-group={group.id}>
                {filters.groupBy === "none" ? null : (
                  <tr className="border-b border-line bg-ivory/60">
                    <th
                      className="px-3 py-1.5 text-left font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-2"
                      colSpan={11}
                    >
                      {groupHeading(group, labels)}
                    </th>
                  </tr>
                )}
                {group.rows.map((row) => (
                  <WorkTableRowView
                    key={row.taskId}
                    dateFormat={dateFormat}
                    labels={labels}
                    now={now}
                    numberFormat={numberFormat}
                    row={row}
                  />
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </div>
  );
}

function groupHeading(group: WorkTableGroup, labels: WorkTableLabels): string {
  if (group.kind === "mine") return labels.group.mineHeading;
  if (group.kind === "others") return labels.group.othersHeading;
  if (group.kind === "stage") {
    return labels.stage[group.label as keyof WorkStageLabels] ?? group.label;
  }

  return group.label;
}

function WorkTableRowView({
  row,
  labels,
  numberFormat,
  dateFormat,
  now,
}: {
  row: WorkTableRow;
  labels: WorkTableLabels;
  numberFormat: Intl.NumberFormat;
  dateFormat: Intl.DateTimeFormat;
  now: Date;
}): ReactElement {
  const taskHref = `/projects/${row.projectSlug}/tasks/${row.number}`;
  const nextAction = workNextAction(row.stage);

  return (
    <tr className="border-b border-line last:border-b-0" data-testid="work-row">
      <td className={CELL}>
        <Link
          className="font-mono text-[12px] font-semibold text-ink no-underline"
          href={taskHref}
          title={labels.openTask}
        >
          {row.keyRef}
        </Link>
      </td>
      <td className={clsx(CELL, "max-w-[320px] truncate text-ink")}>
        {row.title}
      </td>
      <td className={CELL}>
        <Link
          className="text-ink-2 no-underline"
          href={`/projects/${row.projectSlug}`}
        >
          {row.projectName}
        </Link>
      </td>
      <td className={CELL}>
        <WorkStageChip
          blocked={row.blocked}
          labels={labels.stage}
          progress={row.progress}
          promotedKind={row.promotedKind}
          stage={row.stage}
        />
      </td>
      <td className={CELL}>
        {row.runId === null ? (
          <span className="text-mute">—</span>
        ) : (
          <Link
            className="font-mono text-[11px] text-ink-2 no-underline"
            href={`/runs/${row.runId}`}
            title={labels.openRun}
          >
            {row.runStatus}
          </Link>
        )}
      </td>
      <td className={CELL}>
        {row.readiness === null ? (
          <span className="text-mute">—</span>
        ) : (
          <span
            className={clsx(
              "font-mono text-[11px]",
              READINESS_TONE[row.readiness] ?? "text-ink-2",
            )}
          >
            {labels.readiness[row.readiness] ?? row.readiness}
          </span>
        )}
      </td>
      <td className={CELL}>
        {row.waitingOn === null ? (
          <span className="text-mute">—</span>
        ) : (
          <span className="text-ink-2">
            {row.waitingOn.kind === "you"
              ? labels.waitingOn.you
              : (row.waitingOn.name ?? labels.waitingOn.anyone)}{" "}
            <span className="text-mute">
              {labels.waitingOn.since.replace(
                "$age",
                workAge(row.waitingOn.since, now),
              )}
            </span>
          </span>
        )}
      </td>
      <td className={CELL}>
        {row.blockers.length === 0 ? (
          <span className="text-mute">—</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {row.blockers.map((blocker) => (
              <span
                key={blocker.taskId}
                className="rounded-full border border-line bg-ivory px-1.5 py-0.5 font-mono text-[10.5px] text-mute"
              >
                {blocker.keyRef}
              </span>
            ))}
          </span>
        )}
      </td>
      <td
        className={clsx(CELL, "text-right font-mono text-[11.5px] text-ink-2")}
      >
        {numberFormat.format(row.tokens)}
      </td>
      <td className={clsx(CELL, "whitespace-nowrap text-mute")}>
        <span suppressHydrationWarning>
          {dateFormat.format(row.lastActivityAt)}
        </span>
      </td>
      <td className={clsx(CELL, "whitespace-nowrap text-ink-2")}>
        {labels.nextAction[nextAction] ?? nextAction}
      </td>
    </tr>
  );
}

function FilterSelect({
  label,
  name,
  value,
  children,
}: {
  label: string;
  name: string;
  value: string;
  children: React.ReactNode;
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
