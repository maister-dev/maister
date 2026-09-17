"use client";

/**
 * The `/work` table's ROWS, split out of `work-table.tsx` so the Desk can show
 * work in flight without re-implementing a single cell (ADR-172 D1).
 *
 * Only the rows live here. Filters, saved views and the row count stay with the
 * full surface — the Desk composes a summary, not a second control panel.
 */

import type { WorkStageLabels } from "@/components/work/work-stage-chip";
import type { WorkTableRow } from "@/lib/queries/work-table";
import type { WorkGroupBy, WorkTableGroup } from "@/lib/work/work-table-view";
import type { ReactElement } from "react";

import Link from "next/link";
import clsx from "clsx";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";

import { WorkStageChip } from "@/components/work/work-stage-chip";
import { workAge, workNextAction } from "@/lib/work/work-table-view";

/**
 * What a ROW needs. `WorkTableLabels` extends it, so adding a column is a
 * compile error at every call site rather than a blank header on one of them.
 */
export interface WorkRowsLabels {
  columns: Record<
    | "key"
    | "title"
    | "project"
    | "stage"
    | "readiness"
    | "waitingOn"
    | "blockers"
    | "tokens"
    | "lastActivity"
    | "nextAction",
    string
  >;
  group: Record<WorkGroupBy | "mineHeading" | "othersHeading", string>;
  waitingOn: Record<"you" | "anyone" | "since", string>;
  readiness: Record<string, string>;
  nextAction: Record<string, string>;
  stage: WorkStageLabels;
  openTask: string;
  openRun: string;
}

export interface WorkRowsTableProps {
  groups: WorkTableGroup[];
  groupBy: WorkGroupBy;
  labels: WorkRowsLabels;
  locale: string;
  now: Date;
}

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

/**
 * `REQ-D11` — narrow viewports DROP columns by priority rather than scrolling
 * the table sideways. Lowest value first: `tokens` and `readiness` go at the
 * smallest widths, `blockers` and `lastActivity` next.
 *
 * Hiding is CSS-driven, so the `<td>` stays in the DOM. Every `colSpan` below
 * must therefore be the FULL column count, never the visible one — a span
 * computed from what is painted misaligns exactly where the columns drop.
 */
const DROP_SM = "hidden lg:table-cell";
const DROP_MD = "hidden xl:table-cell";

/** Every column the table can render, hidden or not — the `colSpan` basis. */
const TOTAL_COLUMNS = 10;

export function WorkRowsTable({
  groups,
  groupBy,
  labels,
  locale,
  now,
}: WorkRowsTableProps): ReactElement {
  const numberFormat = new Intl.NumberFormat(locale);
  const dateFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "short",
  });

  // `REQ-D7` — grouping-derived, not surface-derived: under project grouping the
  // group header already names the project, so the cell is a second copy of a
  // value the reader is already looking at. The rule holds at BOTH surfaces.
  const showProject = groupBy !== "project";

  return (
    <div className="rounded-[14px] border border-line bg-paper">
      <table className="w-full border-collapse text-[12.5px]">
        <thead className="border-b border-line bg-ivory">
          <tr>
            <th className={HEAD}>{labels.columns.key}</th>
            <th className={HEAD}>{labels.columns.title}</th>
            {showProject ? (
              <th className={HEAD}>{labels.columns.project}</th>
            ) : null}
            <th className={HEAD}>{labels.columns.stage}</th>
            <th className={clsx(HEAD, DROP_SM)}>{labels.columns.readiness}</th>
            <th className={HEAD}>{labels.columns.waitingOn}</th>
            <th className={clsx(HEAD, DROP_MD)}>{labels.columns.blockers}</th>
            <th className={clsx(HEAD, DROP_SM, "text-right")}>
              {labels.columns.tokens}
            </th>
            <th className={clsx(HEAD, DROP_MD)}>
              {labels.columns.lastActivity}
            </th>
            <th className={HEAD}>{labels.columns.nextAction}</th>
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.id} data-group={group.id}>
            {groupBy === "none" ? null : (
              <tr className="border-b border-line bg-ivory/60">
                <th
                  className="px-3 py-1.5 text-left font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-2"
                  colSpan={showProject ? TOTAL_COLUMNS : TOTAL_COLUMNS - 1}
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
                showProject={showProject}
              />
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function groupHeading(group: WorkTableGroup, labels: WorkRowsLabels): string {
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
  showProject,
}: {
  row: WorkTableRow;
  labels: WorkRowsLabels;
  numberFormat: Intl.NumberFormat;
  dateFormat: Intl.DateTimeFormat;
  now: Date;
  showProject: boolean;
}): ReactElement {
  const taskHref = `/projects/${row.projectSlug}/tasks/${row.number}`;
  const nextAction = workNextAction(row.stage);

  return (
    <tr
      className="border-b border-line last:border-b-0"
      data-stage={row.stage}
      data-testid="work-row"
    >
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
      {showProject ? (
        <td className={CELL}>
          <Link
            className="text-ink-2 no-underline"
            href={`/projects/${row.projectSlug}`}
          >
            {row.projectName}
          </Link>
        </td>
      ) : null}
      <td className={CELL}>
        <WorkStageChip
          blocked={row.blocked}
          labels={labels.stage}
          progress={row.progress}
          promotedKind={row.promotedKind}
          runStatus={row.runStatus}
          stage={row.stage}
        />
      </td>
      <td className={clsx(CELL, DROP_SM)}>
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
      <td className={clsx(CELL, DROP_MD)}>
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
        className={clsx(
          CELL,
          DROP_SM,
          "text-right font-mono text-[11.5px] text-ink-2",
        )}
      >
        {numberFormat.format(row.tokens)}
      </td>
      <td className={clsx(CELL, DROP_MD, "whitespace-nowrap text-mute")}>
        <span suppressHydrationWarning>
          {dateFormat.format(row.lastActivityAt)}
        </span>
      </td>
      {/* The trailing action cluster: the next action, then the run. Reads
          left-to-right primary -> secondary, per web/CLAUDE.md. */}
      <td className={clsx(CELL, "whitespace-nowrap text-ink-2")}>
        <span className="inline-flex items-center gap-2">
          {/* `REQ-D10` — a `none` action is an em dash. "Nothing" reads as a
              thing to do, which is the opposite of what it means. */}
          {nextAction === "none" ? (
            <span className="text-mute">—</span>
          ) : (
            <span>{labels.nextAction[nextAction] ?? nextAction}</span>
          )}
          {/* `REQ-D9` — removing the run COLUMN must not remove the ability to
              open the run. Icon-only, so it carries an accessible name. */}
          {row.runId === null ? null : (
            <Link
              aria-label={labels.openRun}
              className="text-mute no-underline hover:text-ink"
              href={`/runs/${row.runId}`}
              title={labels.openRun}
            >
              <ArrowTopRightOnSquareIcon
                aria-hidden="true"
                className="h-3.5 w-3.5"
              />
            </Link>
          )}
        </span>
      </td>
    </tr>
  );
}
