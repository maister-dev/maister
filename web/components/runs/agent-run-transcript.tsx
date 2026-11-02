"use client";

import type { ReactElement } from "react";
import type { RunTranscriptPanelProps } from "@/components/runs/run-transcript-panel";

import { RunTranscriptPanel } from "@/components/runs/run-transcript-panel";

export function AgentRunTranscript(
  props: Omit<RunTranscriptPanelProps, "nodeId">,
): ReactElement {
  return (
    <section
      className="mt-3 min-w-0 max-w-full"
      data-testid="agent-run-transcript"
    >
      <RunTranscriptPanel {...props} nodeId={null} />
    </section>
  );
}
