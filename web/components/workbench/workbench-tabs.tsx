import type { ReactElement } from "react";

import Link from "next/link";
import clsx from "clsx";

export type WorkbenchTab = "files" | "diff" | "graph";

export interface WorkbenchTabsLabels {
  files: string;
  diff: string;
  graph: string;
}

export interface WorkbenchTabsProps {
  runId: string;
  active: WorkbenchTab;
  labels: WorkbenchTabsLabels;
}

const TABS: readonly WorkbenchTab[] = ["files", "diff", "graph"];

export function WorkbenchTabs({
  runId,
  active,
  labels,
}: WorkbenchTabsProps): ReactElement {
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
            href={`/runs/${runId}?wb=${tab}`}
            role="tab"
          >
            {labels[tab]}
          </Link>
        );
      })}
    </div>
  );
}
