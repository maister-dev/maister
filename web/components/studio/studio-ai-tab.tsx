"use client";

import type { ReactElement } from "react";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { ScratchConversation } from "@/components/scratch/scratch-conversation";
import { readApiError } from "@/lib/api-error";
import { useRunStream } from "@/lib/use-run-stream";

export type StudioAiTabLabels = {
  intro: string;
  promptPlaceholder: string;
  launch: string;
  launching: string;
  lockRequired: string;
};

// M36 Phase 5 (ADR-097) T5.7: the docked AI authoring assistant tab. ONE ACP run
// per editor tab — the run id is held in this component's state for the editor
// mount's lifetime, so toggling Properties⇆AI never relaunches. A 2nd browser
// tab generates a fresh lock session that does NOT hold the working-dir lock, so
// its launch is refused server-side (assertHoldsLock) — no 2nd assistant for the
// same holder. Reuses ScratchConversation for the transcript + inline HITL + SSE,
// and the run's live stream to drive: (a) the editor "AI working" read-only while
// a turn is in flight, and (b) the diff/canvas refresh after assistant writes.
export function StudioAiTab({
  packageId,
  sessionId,
  canManage,
  labels,
  onBusyChange,
  onActivity,
}: {
  packageId: string;
  sessionId: string;
  canManage: boolean;
  labels: StudioAiTabLabels;
  // Lift "assistant turn in flight" so the editor goes read-only ("AI working").
  onBusyChange: (busy: boolean) => void;
  // Bumped on every assistant stream event so the editor re-reads the working
  // dir (canvas + the git-diff drawer's changed-count) — reuses diffRefresh.
  onActivity: () => void;
}): ReactElement {
  const t = useTranslations("apiErrors");
  const [runId, setRunId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Change-tick only (retain:false): the run's SSE stream signals assistant
  // activity. We re-read dialogStatus on each tick to drive busy/refresh.
  const { eventCount } = useRunStream(runId, { retain: false });

  const refreshStatus = useCallback(async (): Promise<void> => {
    if (!runId) return;

    try {
      const res = await fetch(`/api/scratch-runs/${runId}`);

      if (!res.ok) return;
      const detail = (await res.json()) as {
        scratch?: { dialogStatus?: string };
      };
      const status = detail.scratch?.dialogStatus;

      onBusyChange(status === "Running" || status === "Starting");
    } catch {
      /* a transient read failure leaves the last-known busy state */
    }
  }, [runId, onBusyChange]);

  // On each assistant stream event: bump the editor refresh (writes may have
  // landed) and re-read the run's busy state. A new run also kicks one refresh.
  const lastTickRef = useRef(0);

  useEffect(() => {
    if (!runId) return;
    if (eventCount === lastTickRef.current) return;
    lastTickRef.current = eventCount;
    onActivity();
    void refreshStatus();
  }, [eventCount, runId, onActivity, refreshStatus]);

  // Turn end (run gone / tab closed) must not strand the editor read-only.
  useEffect(() => {
    if (!runId) onBusyChange(false);
  }, [runId, onBusyChange]);

  const launch = useCallback(async (): Promise<void> => {
    const trimmed = prompt.trim();

    if (trimmed.length === 0 || launching) return;
    setLaunching(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/studio/local-packages/${packageId}/assistant`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, prompt: trimmed }),
        },
      );

      if (!res.ok) {
        setError(await readApiError(res, t));

        return;
      }

      const body = (await res.json()) as { runId: string };

      setRunId(body.runId);
      onActivity();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLaunching(false);
    }
  }, [prompt, launching, packageId, sessionId, t, onActivity]);

  if (runId) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="studio-ai-tab">
        <ScratchConversation runId={runId} />
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 p-4"
      data-testid="studio-ai-tab"
    >
      <p className="text-[13px] leading-[1.55] text-ink-2">{labels.intro}</p>
      {!canManage ? (
        <p
          className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] text-amber"
          data-testid="studio-ai-lock-required"
          role="status"
        >
          {labels.lockRequired}
        </p>
      ) : null}
      <textarea
        aria-label={labels.promptPlaceholder}
        className="min-h-[140px] w-full resize-y rounded-lg border border-line bg-paper px-3.5 py-3 font-mono text-[13px] leading-[1.35] text-ink outline-none transition focus:border-amber focus:shadow-[0_0_0_3px_var(--amber-soft)] placeholder:text-mute disabled:opacity-50"
        data-testid="studio-ai-prompt"
        disabled={!canManage || launching}
        placeholder={labels.promptPlaceholder}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />
      {error ? (
        <p
          className="rounded-lg border border-danger-line bg-danger-soft px-3 py-2 font-mono text-[11px] text-danger"
          data-testid="studio-ai-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <button
          className="rounded-full bg-amber px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-amber-2 disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="studio-ai-launch"
          disabled={!canManage || launching || prompt.trim().length === 0}
          type="button"
          onClick={() => void launch()}
        >
          {launching ? labels.launching : labels.launch}
        </button>
      </div>
    </div>
  );
}
