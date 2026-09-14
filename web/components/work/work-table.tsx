"use client";

import type { WorkRowsLabels } from "@/components/work/work-rows-table";
import type {
  WorkTableFilters,
  WorkTableGroup,
} from "@/lib/work/work-table-view";
import type { ReactElement } from "react";

import { BookmarkIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import Link from "next/link";

import { WorkRowsTable } from "@/components/work/work-rows-table";
import { WORK_STAGES } from "@/lib/work/stage";
import {
  WORK_GROUP_BYS,
  workTableFiltersToQuery,
} from "@/lib/work/work-table-view";

export interface WorkTableProjectOption {
  slug: string;
  name: string;
}

/** The full `/work` surface: the shared row labels plus this page's chrome. */
export interface WorkTableLabels extends WorkRowsLabels {
  rowCount: string;
  filters: Record<
    "project" | "allProjects" | "stage" | "allStages" | "group" | "apply",
    string
  >;
  empty: Record<"noProjects" | "noRows", string>;
  savedViews: Record<
    "label" | "save" | "namePlaceholder" | "remove" | "empty",
    string
  >;
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
        <WorkRowsTable
          groupBy={filters.groupBy}
          groups={groups}
          labels={labels}
          locale={locale}
          now={now}
        />
      )}
    </div>
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
