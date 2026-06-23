"use client";

import type { ReactNode } from "react";

import { useEffect, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { usePathname, useSearchParams } from "next/navigation";

import {
  WorkbenchTabs,
  WORKBENCH_TABS,
  type WorkbenchTab,
  type WorkbenchTabsLabels,
} from "@/components/workbench/workbench-tabs";

type CollapsibleWorkbenchTab = "files" | "diff";

function tabFromSearch(
  raw: string | null,
  tabs: readonly WorkbenchTab[],
): WorkbenchTab | null {
  if (tabs.includes(raw as WorkbenchTab)) return raw as WorkbenchTab;

  return null;
}

function isCollapsibleWorkbenchTab(
  tab: WorkbenchTab,
): tab is CollapsibleWorkbenchTab {
  return tab === "files" || tab === "diff";
}

function regularWorkbenchTabs(
  tabs: readonly WorkbenchTab[],
): readonly WorkbenchTab[] {
  return tabs.filter((tab) => !isCollapsibleWorkbenchTab(tab));
}

function collapsibleWorkbenchTabs(
  tabs: readonly WorkbenchTab[],
): readonly CollapsibleWorkbenchTab[] {
  return tabs.filter(isCollapsibleWorkbenchTab);
}

function activeCollapsibleTabOrDefault(
  raw: string | null,
  tabs: readonly CollapsibleWorkbenchTab[],
): CollapsibleWorkbenchTab | null {
  const tab = tabFromSearch(raw, tabs);

  if (tab && isCollapsibleWorkbenchTab(tab)) return tab;

  return tabs[0] ?? null;
}

function activeRegularTab(
  raw: string | null,
  tabs: readonly WorkbenchTab[],
  activeCollapsible: CollapsibleWorkbenchTab | null,
): WorkbenchTab | null {
  if (activeCollapsible) return null;

  return tabFromSearch(raw, tabs) ?? tabs[0] ?? null;
}

function activeCollapsibleTab(
  raw: string | null,
  tabs: readonly WorkbenchTab[],
): CollapsibleWorkbenchTab | null {
  const tab = tabFromSearch(raw, tabs);

  return tab && isCollapsibleWorkbenchTab(tab) ? tab : null;
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

interface WorkbenchDisclosureProps {
  children: ReactNode;
  label: string;
  routeOpen: boolean;
  testId: string;
}

function WorkbenchDisclosure({
  children,
  label,
  routeOpen,
  testId,
}: WorkbenchDisclosureProps): ReactNode {
  const [open, setOpen] = useState(routeOpen);
  const Icon = open ? ChevronDownIcon : ChevronRightIcon;

  useEffect(() => {
    setOpen(routeOpen);
  }, [routeOpen]);

  return (
    <details
      className="min-w-0 max-w-full overflow-hidden rounded-[10px] border border-line bg-paper"
      data-testid={testId}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        aria-expanded={open}
        className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 font-mono text-[11px] font-semibold uppercase leading-none tracking-[0.06em] text-ink marker:hidden [&::-webkit-details-marker]:hidden"
      >
        <span>{label}</span>
        <Icon aria-hidden="true" className="h-3.5 w-3.5 text-mute" />
      </summary>
      <div className="min-w-0 max-w-full border-t border-line p-3">
        {children}
      </div>
    </details>
  );
}

function workbenchDisclosureLabel(
  labels: WorkbenchTabsLabels,
  tabs: readonly CollapsibleWorkbenchTab[],
): string {
  return tabs.map((tab) => labels[tab]).join(" / ");
}

// The diff/evidence/timeline bodies and the file tree carry server-fetched data
// hoisted into the persistent run-detail layout; the file-content pane
// (`filesPane`) is the `?file=`-driven server child that re-renders alone. The
// active Timeline/Evidence body and the Files/Diff disclosure default are
// chosen CLIENT-SIDE from `?wb` so navigation never re-runs the layout's heavy
// server loads, and all subtrees stay mounted so client state (file-tree
// `expandedDirs`, diff selection) survives navigation and collapsing.
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
  const rawTab = searchParams.get("wb");
  const activeCollapsible = activeCollapsibleTab(rawTab, tabs);
  const regularTabs = regularWorkbenchTabs(tabs);
  const collapsibleTabs = collapsibleWorkbenchTabs(tabs);
  const activeRegular = activeRegularTab(
    rawTab,
    regularTabs,
    activeCollapsible,
  );
  const activeWorkbenchTab = activeCollapsibleTabOrDefault(
    rawTab,
    collapsibleTabs,
  );

  return (
    <div className="grid min-w-0 max-w-full gap-3">
      {regularTabs.length > 0 && activeRegular ? (
        <WorkbenchTabs
          active={activeRegular}
          labels={tabLabels}
          pathname={pathname}
          runId={runId}
          searchParams={searchParams}
          tabs={regularTabs}
        />
      ) : null}
      {tabs.includes("timeline") ? (
        <div data-testid="timeline-pane" hidden={activeRegular !== "timeline"}>
          {timeline}
        </div>
      ) : null}
      {tabs.includes("evidence") ? (
        <div data-testid="evidence-pane" hidden={activeRegular !== "evidence"}>
          {evidence}
        </div>
      ) : null}
      {collapsibleTabs.length > 0 && activeWorkbenchTab ? (
        <WorkbenchDisclosure
          label={workbenchDisclosureLabel(tabLabels, collapsibleTabs)}
          routeOpen={activeCollapsible !== null}
          testId="workbench-disclosure"
        >
          <WorkbenchTabs
            active={activeWorkbenchTab}
            labels={tabLabels}
            pathname={pathname}
            runId={runId}
            searchParams={searchParams}
            tabs={collapsibleTabs}
          />
          {collapsibleTabs.includes("files") ? (
            <div
              className="grid min-w-0 grid-cols-1 items-stretch gap-3 md:grid-cols-[minmax(220px,300px)_minmax(0,1fr)]"
              data-testid="files-pane"
              hidden={activeWorkbenchTab !== "files"}
            >
              <div className="min-h-[560px] min-w-0 [&>[data-testid=file-tree]]:h-full">
                {filesTree}
              </div>
              {/* `filesPane` is the layout `children` (an array node); rendering it
                  as the sole child of its own wrapper keeps it out of a nested
                  sibling array (which would trip React's missing-key warning). */}
              <div className="min-h-[560px] min-w-0 max-w-full [&_.markdown-rich-view]:!h-full [&_.markdown-rich-view]:!max-h-full [&_[data-testid=code-view]]:!h-full [&_[data-testid=code-view]]:!max-h-full">
                {filesPane}
              </div>
            </div>
          ) : null}
          {collapsibleTabs.includes("diff") ? (
            <div
              className="min-w-0 max-w-full"
              data-testid="diff-pane"
              hidden={activeWorkbenchTab !== "diff"}
            >
              {diff}
            </div>
          ) : null}
        </WorkbenchDisclosure>
      ) : null}
    </div>
  );
}
