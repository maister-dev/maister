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
import type { KeyboardEvent, MouseEvent, ReactElement, ReactNode } from "react";

import Link from "next/link";
import clsx from "clsx";
import { useState } from "react";
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
  /**
   * Row expansion, OFF by default (ADR-174 D5). The Desk turns it on; `/work`
   * adopts it in a later increment, once "what does a backlog row expand into"
   * has an answer. A default of `false` is what keeps one shared component from
   * needing a fork.
   */
  expandable?: boolean;
  /**
   * Panel content by `taskId`. A ReactNode rather than a render function on
   * purpose: this is a client component, and a FUNCTION prop cannot cross the
   * RSC boundary — the Desk is a server component that builds these elements and
   * passes them as children would be passed.
   */
  panels?: Record<string, ReactNode>;
}

/**
 * A click that lands on a link or a button belongs to that control, never to the
 * row (`REQ-D13`). A reader clicking `MYAPP-1` wants the task; getting the task
 * AND an expanded panel is the bug this closes.
 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('a,button,input,select,textarea,[role="button"]') !== null
  );
}

const READINESS_TONE: Record<string, string> = {
  ready: "text-good",
  blocked: "text-danger",
  failed: "text-danger",
  stale: "text-amber",
  waiting: "text-mute",
  overridden: "text-ink-2",
};

// Tighter gutters on a phone. Four visible columns spend 96px on padding at
// `px-3`, which is a quarter of a 390px viewport before any content renders.
const CELL = "px-2 py-2 align-middle sm:px-3";
const HEAD =
  "px-2 py-2 text-left font-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-mute sm:px-3";

/**
 * `REQ-D11` — narrow viewports DROP columns by priority rather than scrolling
 * the table sideways. Each constant is named for the widths at which its
 * columns are GONE, so they drop in the order `MD` -> `SM` -> `XS` as the
 * viewport narrows:
 *
 * 1. `blockers`, `lastActivity` — below `xl`.
 * 2. `readiness`, `waitingOn`, `tokens` — below `lg`. `waitingOn` is an em dash
 *    on every row without a pending request, and the widest text column when it
 *    is not; the Desk's expanded panel and the run surface both still name the
 *    person.
 * 3. `project` — below `md`, last because it is the highest-value of the three
 *    groups but also the widest cheap win on a phone, and `/work` — which does
 *    NOT group by project and so always renders it — was the surface still
 *    pushing the page sideways at 390px.
 *
 * A `<th>` and its `<td>` MUST carry the SAME constant. They are ~170 lines
 * apart, and a header that outlives its cells leaves every row one column short
 * of its own header from that point rightward — `T-D11` pins the pairing.
 *
 * Hiding is CSS-driven, so the `<td>` stays in the DOM. Every `colSpan` below
 * must therefore be the FULL column count, never the visible one — a span
 * computed from what is painted misaligns exactly where the columns drop.
 */
const DROP_SM = "hidden lg:table-cell";
const DROP_MD = "hidden xl:table-cell";
const DROP_XS = "hidden md:table-cell";

/** Every column the table can render, hidden or not — the `colSpan` basis. */
const TOTAL_COLUMNS = 10;

export function WorkRowsTable({
  groups,
  groupBy,
  labels,
  locale,
  now,
  expandable = false,
  panels,
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
              <th className={clsx(HEAD, DROP_XS)}>{labels.columns.project}</th>
            ) : null}
            <th className={HEAD}>{labels.columns.stage}</th>
            <th className={clsx(HEAD, DROP_SM)}>{labels.columns.readiness}</th>
            <th className={clsx(HEAD, DROP_SM)}>{labels.columns.waitingOn}</th>
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
                columnCount={showProject ? TOTAL_COLUMNS : TOTAL_COLUMNS - 1}
                dateFormat={dateFormat}
                expandable={expandable}
                labels={labels}
                now={now}
                numberFormat={numberFormat}
                panel={panels?.[row.taskId]}
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
  expandable,
  panel,
  columnCount,
}: {
  row: WorkTableRow;
  labels: WorkRowsLabels;
  numberFormat: Intl.NumberFormat;
  dateFormat: Intl.DateTimeFormat;
  now: Date;
  showProject: boolean;
  expandable: boolean;
  panel: ReactNode;
  columnCount: number;
}): ReactElement {
  const taskHref = `/projects/${row.projectSlug}/tasks/${row.number}`;
  const nextAction = workNextAction(row.stage);
  // Open state gates RENDERING, so it lives in `useState` — a ref read during
  // render is a silent no-re-render bug this project has already paid for.
  const [open, setOpen] = useState(false);
  // Mount-once, then hide. `open` alone would conditionally unmount the panel,
  // which discards an unsent HITL answer in the response form it carries — the
  // project's standing rule is that a surface holding live state stays MOUNTED
  // and toggles via `hidden`. Mounting only after the FIRST expand is what keeps
  // `REQ-D16` true: no panel exists on page load, so no request fires per row.
  const [hasOpened, setHasOpened] = useState(false);
  const canExpand = expandable && panel !== undefined;
  const panelId = `work-row-panel-${row.taskId}`;

  function activate(event: MouseEvent | KeyboardEvent): void {
    if (!canExpand || isInteractiveTarget(event.target)) return;
    // Selecting a task title or KEY-N ends in a `click` on the row. Copying a
    // value out of a table is an everyday action; it must not open a panel.
    if ((globalThis.getSelection?.()?.toString() ?? "") !== "") return;
    setOpen((wasOpen) => {
      if (!wasOpen) setHasOpened(true);

      return !wasOpen;
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTableRowElement>): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (isInteractiveTarget(event.target)) return;
    // Space scrolls the page otherwise, and Enter would submit an ancestor form.
    event.preventDefault();
    activate(event);
  }

  return (
    <>
      <tr
        // Only once the target EXISTS: the panel row is not rendered until the
        // first expand, and `aria-controls` pointing at a missing id is a
        // dangling reference, not a hint.
        aria-controls={canExpand && hasOpened ? panelId : undefined}
        aria-expanded={canExpand ? open : undefined}
        className={clsx(
          "border-b border-line last:border-b-0",
          canExpand &&
            "cursor-pointer hover:bg-ivory/60 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-amber",
        )}
        data-stage={row.stage}
        data-testid="work-row"
        tabIndex={canExpand ? 0 : undefined}
        onClick={canExpand ? activate : undefined}
        onKeyDown={canExpand ? onKeyDown : undefined}
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
        {/* Absorbs the leftover width and ellipsises — see the DROP_* note. */}
        <td className={clsx(CELL, "w-full max-w-0 truncate text-ink")}>
          {row.title}
        </td>
        {showProject ? (
          <td className={clsx(CELL, DROP_XS)}>
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
        <td className={clsx(CELL, DROP_SM)}>
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
              // The WORDS drop on a phone; the run affordance beside them does
              // not, so `REQ-D9` still holds at every width.
              <span className="hidden sm:inline">
                {labels.nextAction[nextAction] ?? nextAction}
              </span>
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
      {canExpand && hasOpened ? (
        <tr
          className="border-b border-line last:border-b-0"
          data-testid="work-row-panel"
          hidden={!open}
          id={panelId}
        >
          {/* The FULL column count, never the visible one: the responsive
            columns are hidden by CSS and their `<td>`s stay in the DOM, so a
            span derived from what is painted misaligns exactly at the widths
            where the columns drop (`REQ-D11`). */}
          <td className="bg-ivory/40 p-0" colSpan={columnCount}>
            {panel}
          </td>
        </tr>
      ) : null}
    </>
  );
}
