import type { ReactElement } from "react";

import { Tabs, type TabItem } from "@/components/navigation/tabs";
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
  // Restrict the rendered tab set (default: all four). Scratch runs surface
  // only Files + Diff — they have no flow timeline or evidence graph.
  tabs?: readonly WorkbenchTab[];
}

export const WORKBENCH_TABS: readonly WorkbenchTab[] = [
  "timeline",
  "diff",
  "files",
  "evidence",
];

export function WorkbenchTabs({
  runId,
  active,
  labels,
  pathname,
  searchParams,
  tabs = WORKBENCH_TABS,
}: WorkbenchTabsProps): ReactElement {
  const hrefPath = pathname ?? `/runs/${runId}`;

  const items: TabItem[] = tabs.map((tab) => ({
    key: tab,
    label: labels[tab],
    href: buildRunHref(hrefPath, searchParams, { wb: tab }),
  }));

  return <Tabs activeKey={active} className="mb-[18px]" items={items} />;
}
