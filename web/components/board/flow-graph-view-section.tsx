"use client";

import type { FlowGraphViewLabels } from "./flow-graph-view";
import type { GraphTopology } from "@/lib/queries/flow-graph-view";
import type { RunNodeStatuses } from "@/lib/queries/run-node-status";
import type { ReactElement } from "react";

import dynamic from "next/dynamic";

// React Flow needs the DOM (canvas/measurement) → ssr:false. Next 16 forbids
// ssr:false in a Server Component, so this thin client wrapper owns the dynamic
// import; the server page renders THIS and passes serializable props through.
const FlowGraphView = dynamic(() => import("./flow-graph-view"), {
  ssr: false,
});

export interface FlowGraphViewSectionProps {
  runId: string;
  topology: GraphTopology;
  layout: Record<string, { x: number; y: number }>;
  initialStatuses: RunNodeStatuses["nodes"];
  currentStepId: string | null;
  runStatus: string;
  labels: FlowGraphViewLabels;
  editable: boolean;
}

export function FlowGraphViewSection({
  runId,
  topology,
  layout,
  initialStatuses,
  currentStepId,
  runStatus,
  labels,
  editable,
}: FlowGraphViewSectionProps): ReactElement {
  return (
    <FlowGraphView
      currentStepId={currentStepId}
      editable={editable}
      initialStatuses={initialStatuses}
      labels={labels}
      layout={layout}
      runId={runId}
      runStatus={runStatus}
      topology={topology}
    />
  );
}
