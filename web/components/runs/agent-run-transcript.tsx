"use client";

import type { ReactElement } from "react";
import type { NodeTranscriptPanelLabels } from "@/components/runs/node-transcript-panel";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  TranscriptView,
  type TranscriptLabels,
  type TranscriptMessage,
} from "@/components/run-transcript/transcript-view";
import { CHANGE_SUMMARY_REFRESH_DEBOUNCE_MS } from "@/lib/runs/live-inspector";
import { useRunStream } from "@/lib/use-run-stream";

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

// Run-scoped transcript for a standalone agent run. The flow timeline is empty
// for agents (no node attempts), so this renders the coalesced ACP conversation
// (thinking + tool calls + messages) read whole-run from canonical Postgres events via
// the shared TranscriptView. A run-scoped clone of NodeTranscriptPanel — fetches
// the transcript route WITHOUT `?node`.
export function AgentRunTranscript({
  runId,
  labels,
  defaultOpen,
  live,
  initialMessages,
}: {
  runId: string;
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
  const reqIdRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const reqId = (reqIdRef.current += 1);

    try {
      const res = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/transcript`,
      );

      if (!res.ok) return;
      const body = (await res.json()) as { messages: TranscriptMessage[] };

      // Latest-wins: ignore a response superseded by a newer in-flight load().
      if (reqId !== reqIdRef.current) return;
      setMessages(body.messages);
    } catch {
      /* transient fetch error — keep the prior transcript, retry on next tick */
    }
  }, [runId]);

  useEffect(() => {
    if (open && initialMessages === undefined) void load();
  }, [open, initialMessages, load]);

  useEffect(() => {
    if (!open || !live || eventCount === 0) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(
      () => void load(),
      CHANGE_SUMMARY_REFRESH_DEBOUNCE_MS,
    );

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [eventCount, open, live, load]);

  return (
    <section
      className="mt-3 min-w-0 max-w-full"
      data-testid="agent-run-transcript"
    >
      <button
        aria-expanded={open}
        className="flex w-full min-w-0 items-center justify-between gap-2 rounded-[7px] border border-line bg-ivory px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute hover:text-amber"
        type="button"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="min-w-0 truncate">{labels.title}</span>
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open ? (
        messages && messages.length > 0 ? (
          <div className="mt-2 min-w-0 max-w-full overflow-hidden">
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
