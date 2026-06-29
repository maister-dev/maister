"use client";

import type { ReactElement } from "react";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  TranscriptView,
  type TranscriptLabels,
  type TranscriptMessage,
} from "@/components/run-transcript/transcript-view";
import { useRunStream } from "@/lib/use-run-stream";

// Run statuses where the agent may still be producing output — drives live
// refetch on stream content ticks. Terminal runs fetch once.
const TERMINAL_RUN_STATUSES = new Set([
  "Done",
  "Abandoned",
  "Failed",
  "Crashed",
]);

export function isLiveRunStatus(status: string): boolean {
  return !TERMINAL_RUN_STATUSES.has(status);
}

// The active (current) node of a live run auto-expands so streamed output is
// visible without a click; everything else starts collapsed.
export function transcriptPanelDefaultOpen(
  selectedIsCurrent: boolean,
  runIsLive: boolean,
): boolean {
  return selectedIsCurrent && runIsLive;
}

export type NodeTranscriptPanelLabels = {
  title: string;
  empty: string;
  thinking: string;
  rawEvent: string;
  input: string;
  result: string;
  copy: string;
  copied: string;
  // Mustache-style template, e.g. "{name} ×{count}".
  toolCount: string;
};

function buildTranscriptLabels(
  labels: NodeTranscriptPanelLabels,
): TranscriptLabels {
  return {
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
}

export function NodeTranscriptPanel({
  runId,
  nodeId,
  labels,
  defaultOpen,
  live,
  initialMessages,
}: {
  runId: string;
  nodeId: string;
  labels: NodeTranscriptPanelLabels;
  defaultOpen: boolean;
  live: boolean;
  // Test/SSR seam — when provided, skips the initial client fetch.
  initialMessages?: TranscriptMessage[];
}): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const [messages, setMessages] = useState<TranscriptMessage[] | null>(
    initialMessages ?? null,
  );
  const { eventCount } = useRunStream(live ? runId : null, { retain: false });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/transcript?node=${encodeURIComponent(nodeId)}`,
      );

      if (!res.ok) return;
      const body = (await res.json()) as { messages: TranscriptMessage[] };

      setMessages(body.messages);
    } catch {
      /* transient fetch error — keep the prior transcript, retry on next tick */
    }
  }, [runId, nodeId]);

  // Initial fetch when the panel is open and we have no preloaded messages.
  useEffect(() => {
    if (open && initialMessages === undefined) void load();
  }, [open, initialMessages, load]);

  // Live refetch on stream content ticks (debounced), only while open + live.
  useEffect(() => {
    if (!open || !live || eventCount === 0) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void load(), 400);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [eventCount, open, live, load]);

  return (
    <section className="mt-3" data-testid="node-transcript-panel">
      <button
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-[7px] border border-line bg-ivory px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute hover:text-amber"
        type="button"
        onClick={() => setOpen((o) => !o)}
      >
        <span>{labels.title}</span>
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open ? (
        messages && messages.length > 0 ? (
          <div className="mt-2">
            <TranscriptView
              labels={buildTranscriptLabels(labels)}
              messages={messages}
              running={live}
            />
          </div>
        ) : (
          <p className="mt-2 text-center font-mono text-[11px] text-mute">
            {labels.empty}
          </p>
        )
      ) : null}
    </section>
  );
}
