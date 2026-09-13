/**
 * The `/work` view layer: filtering and grouping over an already-loaded table
 * (ADR-170).
 *
 * Pure by contract — no database handle, no clock. A filter is a view over the
 * ONE comparable list the read model returns, never a different query, which is
 * why `getWorkTable` takes no filter arguments and its statement count stays
 * flat under every combination of them.
 */

import type { WorkTableRow } from "@/lib/queries/work-table";
import type { WorkStage } from "@/lib/work/stage";

import { WORK_STAGES } from "@/lib/work/stage";

export const WORK_GROUP_BYS = ["none", "project", "stage", "mine"] as const;

export type WorkGroupBy = (typeof WORK_GROUP_BYS)[number];

export interface WorkTableFilters {
  projectSlug: string | null;
  stage: WorkStage | null;
  groupBy: WorkGroupBy;
}

export interface WorkTableGroup {
  /** Stable identity for a React key and for the e2e `data-group` attribute. */
  id: string;
  /**
   * How the heading is named. A project called "Review" must not borrow the
   * translated stage label, so the renderer branches on this rather than
   * probing the stage dictionary with whatever the label happens to be.
   */
  kind: "all" | "project" | "stage" | "mine" | "others";
  /** The project's name, or the stage id; empty for the headingless kinds. */
  label: string;
  rows: WorkTableRow[];
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T | null {
  return value && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/**
 * A slug is echoed back verbatim even when no visible project carries it: the
 * filter is DROPPED (it matches nothing) rather than refused, so a shared link
 * to a project the reader cannot see reveals nothing about its existence.
 */
export function normalizeWorkTableFilters(
  params: Record<string, string | string[] | undefined>,
): WorkTableFilters {
  const projectSlug = firstParam(params.project)?.trim();

  return {
    projectSlug: projectSlug ? projectSlug : null,
    stage: oneOf(firstParam(params.stage), WORK_STAGES),
    groupBy: oneOf(firstParam(params.group), WORK_GROUP_BYS) ?? "none",
  };
}

export function workTableFiltersToQuery(filters: WorkTableFilters): string {
  const params = new URLSearchParams();

  if (filters.projectSlug) params.set("project", filters.projectSlug);
  if (filters.stage) params.set("stage", filters.stage);
  if (filters.groupBy !== "none") params.set("group", filters.groupBy);

  return params.toString();
}

export function filterWorkTableRows(
  rows: readonly WorkTableRow[],
  filters: WorkTableFilters,
): WorkTableRow[] {
  return rows.filter(
    (row) =>
      (filters.projectSlug === null ||
        row.projectSlug === filters.projectSlug) &&
      (filters.stage === null || row.stage === filters.stage),
  );
}

export function groupWorkTableRows(
  rows: readonly WorkTableRow[],
  groupBy: WorkGroupBy,
): WorkTableGroup[] {
  if (groupBy === "none") {
    return [{ id: "all", kind: "all", label: "", rows: [...rows] }];
  }

  if (groupBy === "mine") {
    const mine = rows.filter((row) => row.waitingOn?.kind === "you");
    const others = rows.filter((row) => row.waitingOn?.kind !== "you");

    return [
      { id: "mine", kind: "mine" as const, label: "", rows: mine },
      { id: "others", kind: "others" as const, label: "", rows: others },
    ].filter((group) => group.rows.length > 0);
  }

  const buckets = new Map<string, WorkTableGroup>();

  for (const row of rows) {
    const id = groupBy === "project" ? row.projectSlug : row.stage;
    const label = groupBy === "project" ? row.projectName : row.stage;
    const bucket = buckets.get(id);

    if (bucket) bucket.rows.push(row);
    else buckets.set(id, { id, kind: groupBy, label, rows: [row] });
  }

  // Stage groups follow the lifecycle order the vocabulary declares; project
  // groups are alphabetical. Neither may depend on which row arrived first.
  if (groupBy === "stage") {
    return WORK_STAGES.flatMap((stage) => {
      const bucket = buckets.get(stage);

      return bucket ? [bucket] : [];
    });
  }

  return [...buckets.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export type WorkNextAction =
  | "triage"
  | "release"
  | "launch"
  | "respond"
  | "review"
  | "recover"
  | "watch"
  | "none";

// What the reader would do next, as a pure function of the stage. `/work` is
// view-only (rows never mutate), so this names the action and links to the
// surface that owns it — it never performs one.
const NEXT_ACTION_BY_STAGE = {
  Triage: "triage",
  Held: "release",
  Ready: "launch",
  Queued: "watch",
  Executing: "watch",
  WaitingOnHuman: "respond",
  Review: "review",
  Crashed: "recover",
  Promoted: "none",
  Abandoned: "none",
} as const satisfies Record<WorkStage, WorkNextAction>;

export function workNextAction(stage: WorkStage): WorkNextAction {
  return NEXT_ACTION_BY_STAGE[stage];
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Compact age ("4m", "3h", "6d"). Takes `now` rather than reading the clock so
 * the server and the client render the same string — the table is a client
 * component, and a self-read clock would hydrate differently on every load.
 */
export function workAge(from: Date, now: Date): string {
  const elapsed = Math.max(0, now.getTime() - from.getTime());

  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;

  return `${Math.floor(elapsed / DAY_MS)}d`;
}
