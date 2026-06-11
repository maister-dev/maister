"use client";

import type {
  FlowGraphRunContext,
  FlowGraphViewLabels,
} from "./flow-graph-view";
import type { FlowLayoutOverride } from "@/lib/board/flow-graph-view-layout";
import type { GraphTopology } from "@/lib/queries/flow-graph-view";
import type { ReactElement } from "react";

import dynamic from "next/dynamic";

// React Flow needs the DOM (canvas/measurement) → ssr:false. Next 16 forbids
// ssr:false in a Server Component, so this thin client wrapper owns the dynamic
// import; the server page renders THIS and passes serializable props through.
const FlowGraphView = dynamic(() => import("./flow-graph-view"), {
  ssr: false,
});

export interface FlowGraphViewSectionProps {
  topology: GraphTopology;
  layout: Record<string, FlowLayoutOverride>;
  labels: FlowGraphViewLabels;
  runContext?: FlowGraphRunContext;
}

export function FlowGraphViewSection({
  topology,
  layout,
  labels,
  runContext,
}: FlowGraphViewSectionProps): ReactElement {
  return (
    <FlowGraphView
      labels={labels}
      layout={layout}
      runContext={runContext}
      topology={topology}
    />
  );
}
