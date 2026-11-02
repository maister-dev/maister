"use client";

import type { ReactElement } from "react";
import type {
  RunTranscriptPanelProps,
  RunTranscriptPanelLabels,
} from "@/components/runs/run-transcript-panel";

import { RunTranscriptPanel } from "@/components/runs/run-transcript-panel";

export type NodeTranscriptPanelLabels = RunTranscriptPanelLabels;

export function transcriptPanelDefaultOpen(
  selectedIsCurrent: boolean,
  runIsLive: boolean,
): boolean {
  return selectedIsCurrent && runIsLive;
}

export function NodeTranscriptPanel(
  props: RunTranscriptPanelProps & { nodeId: string },
): ReactElement {
  return (
    <section
      className="mt-3 min-w-0 max-w-full"
      data-testid="node-transcript-panel"
    >
      <RunTranscriptPanel {...props} />
    </section>
  );
}
