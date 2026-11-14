"use client";

import type { EvidenceGraphLabels } from "./evidence-graph";
import type { RunResultsAndChecks } from "@/lib/queries/run-results-and-checks";
import type { EvidenceGraph as EvidenceGraphData } from "@/lib/queries/evidence-graph";
import type { ReactElement } from "react";

import dynamic from "next/dynamic";

// React Flow needs the DOM (canvas/measurement) → ssr:false. Next 16 forbids
// ssr:false in a Server Component, so this thin client wrapper owns the dynamic
// import; the server page renders THIS and passes serializable props through.
const EvidenceGraph = dynamic(() => import("./evidence-graph"), { ssr: false });

export interface EvidenceGraphSectionProps {
  runId: string;
  graph: EvidenceGraphData;
  labels: EvidenceGraphLabels;
  results: RunResultsAndChecks;
}

export function EvidenceGraphSection({
  runId,
  graph,
  labels,
  results,
}: EvidenceGraphSectionProps): ReactElement {
  return (
    <EvidenceGraph
      graph={graph}
      labels={labels}
      results={results}
      runId={runId}
    />
  );
}
