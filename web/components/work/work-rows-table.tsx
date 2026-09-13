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
    | "run"
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

  return (
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
            {groupBy === "none" ? null : (
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
}: {
  row: WorkTableRow;
  labels: WorkRowsLabels;
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
