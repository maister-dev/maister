"use client";

import type { ReactElement } from "react";
import type {
  TranscriptMessage,
  TranscriptLabels,
} from "@/components/run-transcript/transcript-view";

import { useState } from "react";

import { TranscriptView } from "@/components/run-transcript/transcript-view";
import { RunTranscriptHistory } from "@/components/runs/run-transcript-history";

export type RunTranscriptPanelLabels = {
  title: string;
  empty: string;
  thinking: string;
  rawEvent: string;
  input: string;
  result: string;
  copy: string;
  copied: string;
  toolCount: string;
};

export type RunTranscriptPanelProps = {
  runId: string;
  nodeId: string | null;
  labels: RunTranscriptPanelLabels;
  defaultOpen: boolean;
  live: boolean;
  initialMessages?: TranscriptMessage[];
};

export function RunTranscriptPanel({
  runId,
  nodeId,
  labels,
  defaultOpen,
  live,
  initialMessages,
}: RunTranscriptPanelProps): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const transcriptLabels: TranscriptLabels = {
    thinking: labels.thinking,
    rawEvent: labels.rawEvent,
    input: labels.input,
    result: labels.result,
    copy: labels.copy,
    copied: labels.copied,
    toolCount: (name, count) =>
      labels.toolCount
        .replace("{name}", name)
        .replace("{count}", String(count)),
  };

  return (
    <>
      <button
        aria-expanded={open}
        className="flex w-full min-w-0 items-center justify-between gap-2 rounded-[7px] border border-line bg-ivory px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute hover:text-amber"
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="min-w-0 truncate">{labels.title}</span>
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <div className="mt-2 min-w-0 max-w-full overflow-clip">
          {initialMessages === undefined ? (
            <RunTranscriptHistory
              key={`${runId}:${nodeId ?? ""}`}
              labels={transcriptLabels}
              live={live}
              nodeId={nodeId}
              runId={runId}
            />
          ) : initialMessages.length > 0 ? (
            <TranscriptView
              labels={transcriptLabels}
              messages={initialMessages}
              running={live}
            />
          ) : (
            <p className="text-center font-mono text-[11px] text-mute">
              {labels.empty}
            </p>
          )}
        </div>
      ) : null}
    </>
  );
}
