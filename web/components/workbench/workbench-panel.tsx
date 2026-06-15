"use client";

import type { ReactNode } from "react";

import { usePathname, useSearchParams } from "next/navigation";

import {
  WorkbenchTabs,
  type WorkbenchTab,
  type WorkbenchTabsLabels,
} from "@/components/workbench/workbench-tabs";

const WORKBENCH_TABS: readonly WorkbenchTab[] = [
  "timeline",
  "diff",
  "files",
  "evidence",
];

function activeTab(raw: string | null): WorkbenchTab {
  return (WORKBENCH_TABS as readonly string[]).includes(raw ?? "")
    ? (raw as WorkbenchTab)
    : "timeline";
}

export interface WorkbenchPanelProps {
  runId: string;
  tabLabels: WorkbenchTabsLabels;
  filesTree: ReactNode;
  filesPane: ReactNode;
  diff: ReactNode;
  evidence: ReactNode;
  timeline: ReactNode;
}

// The diff/evidence/timeline bodies and the file tree carry server-fetched data
// hoisted into the persistent run-detail layout; the file-content pane
// (`filesPane`) is the `?file=`-driven server child that re-renders alone. The
// active body is chosen CLIENT-SIDE from `?wb` so a tab switch never re-runs the
// layout's heavy server loads, and all subtrees stay mounted (hidden, not
// unmounted) so client state (file-tree `expandedDirs`, diff selection)
// survives a tab toggle.
export function WorkbenchPanel({
  runId,
  tabLabels,
  filesTree,
  filesPane,
  diff,
  evidence,
  timeline,
}: WorkbenchPanelProps): ReactNode {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = activeTab(searchParams.get("wb"));

  return (
    <>
      <WorkbenchTabs
        active={active}
        labels={tabLabels}
        pathname={pathname}
        runId={runId}
        searchParams={searchParams}
      />
      <div
        className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(220px,300px)_1fr]"
        data-testid="files-pane"
        hidden={active !== "files"}
      >
        <div>{filesTree}</div>
        {/* `filesPane` is the layout `children` (an array node); rendering it as
            the sole child of its own wrapper keeps it out of a nested sibling
            array (which would trip React's missing-key warning). */}
        <div>{filesPane}</div>
      </div>
      <div hidden={active !== "diff"}>{diff}</div>
      <div hidden={active !== "evidence"}>{evidence}</div>
      <div hidden={active !== "timeline"}>{timeline}</div>
    </>
  );
}
