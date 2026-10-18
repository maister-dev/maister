"use client";

import type { ReactElement, ReactNode } from "react";
import type { BoardFilters } from "@/lib/board/filters";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import clsx from "clsx";

import {
  BOARD_FILTER_QUERY_KEYS,
  hasActiveBoardFilters,
} from "@/lib/board/filters";

type Layout = "board" | "swimlanes" | "list";

export interface BoardToolsLabels {
  filterFlow: string;
  filterAgent: string;
  filterPrio: string;
  filterTouched: string;
  filterAny: string;
  filterAnyTime: string;
  clearFilters: string;
  layout: string;
  layoutBoard: string;
  layoutSwimlanes: string;
  layoutList: string;
  asOf: string;
  justNow: string;
}

export interface BoardFilterOption {
  value: string;
  label: string;
}

export interface BoardToolsProps {
  labels: BoardToolsLabels;
  filters: BoardFilters;
  options: {
    flow: BoardFilterOption[];
    agent: BoardFilterOption[];
    priority: BoardFilterOption[];
    touched: BoardFilterOption[];
  };
  children: ReactNode;
}

export function BoardTools({
  labels,
  filters,
  options,
  children,
}: BoardToolsProps): ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const serverQuery = searchParams.toString();
  const wrapRef = useRef<HTMLDivElement>(null);
  const pendingQuery = useRef(serverQuery);
  const previousServerQuery = useRef(serverQuery);
  const [layout, setLayout] = useState<Layout>("board");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const board = wrapRef.current?.querySelector<HTMLElement>("[data-board]");

    if (board) board.dataset.layout = layout;
  }, [layout]);

  useEffect(() => {
    if (serverQuery === previousServerQuery.current) return;

    previousServerQuery.current = serverQuery;
    pendingQuery.current = serverQuery;
  }, [serverQuery]);

  const commitFilter = (key: keyof BoardFilters, value: string): void => {
    const next = new URLSearchParams(pendingQuery.current);
    const queryKey = BOARD_FILTER_QUERY_KEYS[key];

    if (value) next.set(queryKey, value);
    else next.delete(queryKey);

    pendingQuery.current = next.toString();
    startTransition(() => {
      router.replace(`${pathname}${next.size > 0 ? `?${next}` : ""}`, {
        scroll: false,
      });
    });
  };
  const clearFilters = (): void => {
    const next = new URLSearchParams(pendingQuery.current);

    for (const queryKey of Object.values(BOARD_FILTER_QUERY_KEYS)) {
      next.delete(queryKey);
    }

    pendingQuery.current = next.toString();
    startTransition(() => {
      router.replace(`${pathname}${next.size > 0 ? `?${next}` : ""}`, {
        scroll: false,
      });
    });
  };
  const filterControls: Array<{
    id: keyof BoardFilters;
    label: string;
    value: string;
    anyLabel: string;
    options: BoardFilterOption[];
  }> = [
    {
      id: "flow",
      label: labels.filterFlow,
      value: filters.flow,
      anyLabel: labels.filterAny,
      options: options.flow,
    },
    {
      id: "agent",
      label: labels.filterAgent,
      value: filters.agent,
      anyLabel: labels.filterAny,
      options: options.agent,
    },
    {
      id: "priority",
      label: labels.filterPrio,
      value: filters.priority,
      anyLabel: labels.filterAny,
      options: options.priority,
    },
    {
      id: "touched",
      label: labels.filterTouched,
      value: filters.touched,
      anyLabel: labels.filterAnyTime,
      options: options.touched,
    },
  ];

  const layouts: { id: Layout; label: string }[] = [
    { id: "board", label: labels.layoutBoard },
    { id: "swimlanes", label: labels.layoutSwimlanes },
    { id: "list", label: labels.layoutList },
  ];

  return (
    <div ref={wrapRef} aria-busy={pending}>
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {filterControls.map((filter) => (
            <label
              key={filter.id}
              className={clsx(
                "relative inline-flex min-h-8 items-center gap-1.5 rounded-full border bg-paper px-3 font-mono text-[10.5px] tracking-[0.04em] transition-colors focus-within:ring-2 focus-within:ring-accent-4/35",
                filter.value
                  ? "border-ink text-ink"
                  : "border-line text-mute hover:border-mute",
              )}
            >
              <span aria-hidden="true">{filter.label}:</span>
              <select
                key={`${filter.id}:${filter.value}`}
                aria-label={filter.label}
                className="max-w-44 cursor-pointer appearance-none border-0 bg-transparent py-1.5 pl-0 pr-4 font-mono text-[10.5px] font-semibold text-ink outline-none"
                defaultValue={filter.value}
                name={BOARD_FILTER_QUERY_KEYS[filter.id]}
                onChange={(event) =>
                  commitFilter(filter.id, event.currentTarget.value)
                }
              >
                <option value="">{filter.anyLabel}</option>
                {filter.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span
                aria-hidden="true"
                className="pointer-events-none absolute right-2.5 font-mono text-[11px] opacity-45"
              >
                ▾
              </span>
            </label>
          ))}
          {hasActiveBoardFilters(filters) ? (
            <button
              className="min-h-8 rounded-full border border-transparent px-2.5 font-mono text-[10.5px] font-semibold text-mute underline decoration-line underline-offset-4 hover:text-ink"
              type="button"
              onClick={clearFilters}
            >
              {labels.clearFilters}
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-2.5 font-mono text-[10.5px] tracking-[0.02em] text-mute">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-transparent px-2 py-1 hover:border-line hover:text-ink-2">
            <span className="h-1.5 w-1.5 rounded-full bg-accent-4 animate-[pulse-dot_2.6s_ease-out_infinite]" />
            {labels.asOf}{" "}
            <b className="font-semibold text-ink-2">{labels.justNow}</b>
          </span>
          <span className="h-[18px] w-px bg-line" />
          <span className="font-semibold uppercase tracking-[0.12em]">
            {labels.layout}
          </span>
          <span className="inline-flex gap-1 rounded-full border border-line bg-ivory p-[3px]">
            {layouts.map((l) => (
              <button
                key={l.id}
                aria-pressed={layout === l.id}
                className={clsx(
                  "rounded-full px-2.5 py-1 font-mono text-[10px] font-semibold tracking-[0.04em]",
                  layout === l.id
                    ? "bg-paper text-ink shadow-[var(--shadow-sm)]"
                    : "text-mute hover:text-ink",
                )}
                type="button"
                onClick={() => setLayout(l.id)}
              >
                {l.label}
              </button>
            ))}
          </span>
        </div>
      </div>
      {children}
    </div>
  );
}
