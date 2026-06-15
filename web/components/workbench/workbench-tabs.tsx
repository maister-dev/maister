import type { ReactElement } from "react";

import Link from "next/link";
import clsx from "clsx";

import {
  buildRunHref,
  type RunSearchParamsInput,
} from "@/lib/runs/run-query-state";

export type WorkbenchTab = "files" | "diff" | "evidence" | "timeline";

export interface WorkbenchTabsLabels {
  files: string;
  diff: string;
  evidence: string;
  timeline: string;
}

export interface WorkbenchTabsProps {
  runId: string;
  active: WorkbenchTab;
  labels: WorkbenchTabsLabels;
  pathname?: string;
  searchParams?: RunSearchParamsInput;
}

const TABS: readonly WorkbenchTab[] = ["timeline", "diff", "files", "evidence"];

export function WorkbenchTabs({
  runId,
  active,
  labels,
  pathname,
  searchParams,
}: WorkbenchTabsProps): ReactElement {
  const hrefPath = pathname ?? `/runs/${runId}`;

  return (
    <div
      className="mb-[18px] inline-flex gap-0.5 rounded-full border border-line bg-ivory p-[3px]"
      role="tablist"
    >
      {TABS.map((tab) => {
        const isActive = tab === active;

        return (
          <Link
            key={tab}
            aria-selected={isActive}
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-full px-3.5 py-[7px] font-mono text-[11px] font-semibold uppercase leading-none tracking-[0.06em]",
              isActive
                ? "bg-paper text-ink shadow-[var(--shadow-sm)]"
                : "text-mute hover:text-ink",
            )}
            href={buildRunHref(hrefPath, searchParams, { wb: tab })}
            role="tab"
          >
            {labels[tab]}
          </Link>
        );
      })}
    </div>
  );
}
