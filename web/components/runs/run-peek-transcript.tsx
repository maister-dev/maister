"use client";

import type { ReactNode } from "react";

import { RunTranscriptHistory } from "@/components/runs/run-transcript-history";

export function RunPeekTranscript({
  runId,
  nodeId,
}: {
  runId: string;
  nodeId: string | null;
}): ReactNode {
  return (
    <div data-testid="peek-transcript">
      <RunTranscriptHistory
        key={`${runId}:${nodeId ?? ""}`}
        nodeId={nodeId}
        runId={runId}
      />
    </div>
  );
}
