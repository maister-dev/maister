"use client";

import type { ReactNode } from "react";

import { usePathname, useSearchParams } from "next/navigation";

import {
  WorkbenchTabs,
  WORKBENCH_TABS,
  type WorkbenchTab,
  type WorkbenchTabsLabels,
} from "@/components/workbench/workbench-tabs";

function activeTab(
  raw: string | null,
  tabs: readonly WorkbenchTab[],
): WorkbenchTab {
  if (tabs.includes(raw as WorkbenchTab)) return raw as WorkbenchTab;

  return tabs.includes("timeline") ? "timeline" : tabs[0];
}

export interface WorkbenchPanelProps {
  runId: string;
  tabLabels: WorkbenchTabsLabels;
  filesTree: ReactNode;
  filesPane: ReactNode;
  diff: ReactNode;
  // Optional: scratch runs render only Files + Diff and omit these.
  evidence?: ReactNode;
  timeline?: ReactNode;
  tabs?: readonly WorkbenchTab[];
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
  tabs = WORKBENCH_TABS,
}: WorkbenchPanelProps): ReactNode {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = activeTab(searchParams.get("wb"), tabs);

  return (
    <>
      <WorkbenchTabs
        active={active}
        labels={tabLabels}
        pathname={pathname}
        runId={runId}
        searchParams={searchParams}
        tabs={tabs}
      />
      {tabs.includes("files") ? (
        <div
          className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(220px,300px)_1fr]"
          data-testid="files-pane"
          hidden={active !== "files"}
        >
          <div>{filesTree}</div>
          {/* `filesPane` is the layout `children` (an array node); rendering it
              as the sole child of its own wrapper keeps it out of a nested
              sibling array (which would trip React's missing-key warning). */}
          <div>{filesPane}</div>
        </div>
      ) : null}
      {tabs.includes("diff") ? (
        <div hidden={active !== "diff"}>{diff}</div>
      ) : null}
      {tabs.includes("evidence") ? (
        <div hidden={active !== "evidence"}>{evidence}</div>
      ) : null}
      {tabs.includes("timeline") ? (
        <div hidden={active !== "timeline"}>{timeline}</div>
      ) : null}
    </>
  );
}
