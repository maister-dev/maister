"use client";

import type { ReactElement, ReactNode } from "react";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

type Layout = "board" | "swimlanes" | "list";

export interface BoardToolsLabels {
  filterFlow: string;
  filterAgent: string;
  filterPrio: string;
  filterTouched: string;
  filterAny: string;
  touchedValue: string;
  layout: string;
  layoutBoard: string;
  layoutSwimlanes: string;
  layoutList: string;
  asOf: string;
  justNow: string;
}

export interface BoardToolsProps {
  labels: BoardToolsLabels;
  children: ReactNode;
}

export function BoardTools({
  labels,
  children,
}: BoardToolsProps): ReactElement {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>("board");
  const [activeFilter, setActiveFilter] = useState<string | null>("flow");

  useEffect(() => {
    const board = wrapRef.current?.querySelector<HTMLElement>("[data-board]");

    if (board) board.dataset.layout = layout;
  }, [layout]);

  const filters: { id: string; label: string; value: string }[] = [
    { id: "flow", label: labels.filterFlow, value: labels.filterAny },
    { id: "agent", label: labels.filterAgent, value: labels.filterAny },
    { id: "prio", label: labels.filterPrio, value: labels.filterAny },
    { id: "touched", label: labels.filterTouched, value: labels.touchedValue },
  ];

  const layouts: { id: Layout; label: string }[] = [
    { id: "board", label: labels.layoutBoard },
    { id: "swimlanes", label: labels.layoutSwimlanes },
    { id: "list", label: labels.layoutList },
  ];

  return (
    <div ref={wrapRef}>
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {filters.map((f) => (
            <button
              key={f.id}
              aria-pressed={activeFilter === f.id}
              className={clsx(
                "inline-flex items-center gap-[5px] rounded-full border px-2.5 py-[5px] font-mono text-[10.5px] tracking-[0.04em]",
                activeFilter === f.id
                  ? "border-ink bg-ink text-paper"
                  : "border-line bg-paper text-mute hover:border-mute hover:text-ink-2",
              )}
              type="button"
              onClick={() =>
                setActiveFilter((cur) => (cur === f.id ? null : f.id))
              }
            >
              {f.label}:{" "}
              <b
                className={clsx(
                  "font-semibold",
                  activeFilter === f.id ? "text-paper" : "text-ink",
                )}
              >
                {f.value}
              </b>
              <span
                className={clsx(
                  "ml-[3px] font-mono text-[11px] opacity-50",
                  activeFilter === f.id &&
                    "text-[color-mix(in_oklab,var(--paper)_60%,transparent)]",
                )}
              >
                ▾
              </span>
            </button>
          ))}
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
