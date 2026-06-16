"use client";

import type { ReactElement } from "react";

import { useEffect, useRef, useState } from "react";

import {
  ScratchTranscript,
  type TranscriptLabels,
  type TranscriptMessage,
} from "@/components/scratch/scratch-transcript";

// M30 (ADR-078): answer-only gate-chat at a human/form HITL pause. Chat never
// resolves the gate; an unavailable state renders an explanatory empty state
// (DD2); the first idle question surfaces the ~$0.28 respawn cost; a turn the
// L3 sensor reverted carries a notice.

export interface GateChatLabels {
  title: string;
  placeholder: string;
  send: string;
  sending: string;
  unavailable: string;
  idleCostWarning: string;
  revertNotice: string;
  agentLabel: string;
  error: string;
  transcript: TranscriptLabels;
}

export interface ChatMessage {
  id: string;
  role: "user" | "agent";
  authorLabel: string;
  body: string;
  seq: number;
  mutationReverted: boolean;
  createdAt: string;
}

interface ChatState {
  availability: { available: boolean; reason?: string } | null;
  idleResumeCost: boolean;
  messages: ChatMessage[];
}

function toTranscriptMessage(message: ChatMessage): TranscriptMessage {
  return {
    id: message.id,
    role: message.role === "agent" ? "assistant" : "user",
    content: message.body,
    createdAt: message.createdAt,
  };
}

export function GateChatTranscript({
  messages,
  labels,
  running = false,
}: {
  messages: ChatMessage[];
  labels: GateChatLabels;
  running?: boolean;
}): ReactElement {
  const userLabel =
    messages.find((message) => message.role === "user")?.authorLabel ?? null;
  const revertedByMessageId = new Set(
    messages
      .filter((message) => message.mutationReverted)
      .map((message) => message.id),
  );

  return (
    <ScratchTranscript
      assistantLabel={labels.agentLabel}
      labels={labels.transcript}
      messages={messages.map(toTranscriptMessage)}
      running={running}
      userLabel={userLabel}
      renderAttachments={(messageId) =>
        revertedByMessageId.has(messageId) ? (
          <div
            className="mt-2 rounded-md border border-amber-line bg-paper px-2 py-1 font-mono text-[10px] text-amber"
            data-testid="gate-chat-revert-notice"
          >
            {labels.revertNotice}
          </div>
        ) : null
      }
    />
  );
}

export function GateChatPanel(props: {
  runId: string;
  hitlRequestId: string;
  canAct: boolean;
  labels: GateChatLabels;
}): ReactElement {
  const [state, setState] = useState<ChatState>({
    availability: null,
    idleResumeCost: false,
    messages: [],
  });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const res = await fetch(
          `/api/runs/${props.runId}/hitl/${props.hitlRequestId}/chat`,
        );

        if (!res.ok) return;
        const body = (await res.json()) as ChatState;

        if (!cancelled) {
          setState({
            availability: body.availability,
            idleResumeCost: body.idleResumeCost,
            messages: body.messages ?? [],
          });
        }
      } catch {
        /* panel stays in its initial state */
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [props.runId, props.hitlRequestId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [state.messages.length]);

  async function send(): Promise<void> {
    const message = draft.trim();

    if (message === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/runs/${props.runId}/hitl/${props.hitlRequestId}/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        },
      );

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;

        throw new Error(body?.message ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        userMessage: ChatMessage;
        agentMessage: ChatMessage;
        resumed: boolean;
      };

      setState((prev) => ({
        ...prev,
        // A resumed pause is live again — the cost warning applied once.
        idleResumeCost: prev.idleResumeCost && !body.resumed,
        messages: [...prev.messages, body.userMessage, body.agentMessage],
      }));
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (state.availability && !state.availability.available) {
    return (
      <section
        className="mb-4 rounded-[10px] border border-line bg-paper p-4"
        data-testid="gate-chat-empty"
      >
        <h3 className="mb-1 font-sans text-[13px] font-bold text-ink">
          {props.labels.title}
        </h3>
        <p className="font-mono text-[11px] text-mute">
          {props.labels.unavailable}
          {state.availability.reason ? ` — ${state.availability.reason}` : ""}
        </p>
      </section>
    );
  }

  return (
    <section
      className="mb-4 rounded-[10px] border border-line bg-paper p-4"
      data-testid="gate-chat-panel"
    >
      <h3 className="mb-2 font-sans text-[13px] font-bold text-ink">
        {props.labels.title}
      </h3>
      {state.idleResumeCost ? (
        <p
          className="mb-2 rounded-md border border-amber-line bg-ivory px-2 py-1 font-mono text-[10.5px] text-amber"
          data-testid="gate-chat-idle-cost"
        >
          {props.labels.idleCostWarning}
        </p>
      ) : null}
      {state.messages.length > 0 ? (
        <div
          ref={listRef}
          className="mb-3 max-h-[320px] overflow-auto rounded-md border border-line bg-ivory"
          data-testid="gate-chat-transcript"
        >
          <GateChatTranscript
            labels={props.labels}
            messages={state.messages}
            running={busy}
          />
        </div>
      ) : null}
      {props.canAct ? (
        <div className="flex gap-2">
          <textarea
            aria-label={props.labels.title}
            className="min-h-[60px] flex-1 rounded-md border border-line bg-ivory p-2 font-mono text-[12px] text-ink"
            data-testid="gate-chat-input"
            disabled={busy}
            placeholder={props.labels.placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            className="self-end rounded-md border border-ink bg-ink px-3 py-1.5 font-mono text-[11px] font-semibold text-paper disabled:opacity-50"
            data-testid="gate-chat-send"
            disabled={busy || draft.trim() === ""}
            type="button"
            onClick={() => void send()}
          >
            {busy ? props.labels.sending : props.labels.send}
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="mt-2 font-mono text-[11px] text-red-600" role="alert">
          {props.labels.error}: {error}
        </p>
      ) : null}
    </section>
  );
}
