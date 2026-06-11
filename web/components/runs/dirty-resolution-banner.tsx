"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// M30 (ADR-082): pre-review dirty-state banner at an open review-gate pause.
// The gate is never blocked — the three actions are part of the review. A
// recorded "proceed" keeps a persistent dirty badge instead of the actions.

export interface DirtySummaryView {
  files: Array<{ path: string; states: string[] }>;
  staged: number;
  unstaged: number;
  untracked: number;
  total: number;
}

export interface DirtyResolutionLabels {
  title: string;
  summary: string; // expects {staged} {unstaged} {untracked} already interpolated by caller
  commit: string;
  discard: string;
  discardConfirm: string;
  proceed: string;
  recordedBadge: string; // e.g. "reviewing committed state — worktree still dirty"
  error: string;
}

export function DirtyResolutionBanner(props: {
  runId: string;
  hitlRequestId: string;
  canAct: boolean;
  dirty: DirtySummaryView;
  dirtyResolution: "commit" | "discard" | "proceed" | null;
  labels: DirtyResolutionLabels;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  async function resolve(choice: "commit" | "discard" | "proceed") {
    setBusy(choice);
    setError(null);
    try {
      const res = await fetch(
        `/api/runs/${props.runId}/hitl/${props.hitlRequestId}/dirty-resolution`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ choice }),
        },
      );

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;

        throw new Error(body?.message ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setConfirmingDiscard(false);
    }
  }

  // After "proceed" the run stays dirty by choice — show the persistent badge.
  if (props.dirtyResolution === "proceed") {
    return (
      <div
        className="mb-4 rounded-md border border-amber-line bg-paper px-3 py-2 font-mono text-[11px] text-amber"
        data-testid="dirty-proceed-badge"
      >
        {props.labels.recordedBadge}
      </div>
    );
  }

  // commit/discard recorded → the worktree was handled; nothing to show
  // (the summary recomputes server-side on refresh and disappears when clean).
  if (props.dirtyResolution !== null) return null;

  return (
    <section
      className="mb-4 rounded-[10px] border border-amber-line bg-paper p-4"
      data-testid="dirty-banner"
    >
      <h3 className="mb-1 font-sans text-[13px] font-bold text-ink">
        {props.labels.title}
      </h3>
      <p className="mb-2 font-mono text-[11px] text-mute">
        {props.labels.summary}
      </p>
      <ul className="mb-3 max-h-[120px] overflow-auto font-mono text-[11px] text-ink-2">
        {props.dirty.files.slice(0, 20).map((f) => (
          <li key={f.path}>
            {f.path} <span className="text-mute">({f.states.join(", ")})</span>
          </li>
        ))}
        {props.dirty.files.length > 20 ? (
          <li className="text-mute">… +{props.dirty.files.length - 20}</li>
        ) : null}
      </ul>
      {props.canAct ? (
        <div className="flex flex-wrap gap-2">
          <button
            className="rounded-md border border-line bg-ivory px-3 py-1.5 font-mono text-[11px] font-semibold text-ink disabled:opacity-50"
            data-testid="dirty-commit"
            disabled={busy !== null}
            type="button"
            onClick={() => resolve("commit")}
          >
            {props.labels.commit}
          </button>
          {confirmingDiscard ? (
            <button
              className="rounded-md border border-red-400 bg-red-50 px-3 py-1.5 font-mono text-[11px] font-semibold text-red-700 disabled:opacity-50 dark:bg-red-950/40 dark:text-red-300"
              data-testid="dirty-discard-confirm"
              disabled={busy !== null}
              type="button"
              onClick={() => resolve("discard")}
            >
              {props.labels.discardConfirm}
            </button>
          ) : (
            <button
              className="rounded-md border border-line bg-ivory px-3 py-1.5 font-mono text-[11px] font-semibold text-ink disabled:opacity-50"
              data-testid="dirty-discard"
              disabled={busy !== null}
              type="button"
              onClick={() => setConfirmingDiscard(true)}
            >
              {props.labels.discard}
            </button>
          )}
          <button
            className="rounded-md border border-line bg-ivory px-3 py-1.5 font-mono text-[11px] font-semibold text-ink disabled:opacity-50"
            data-testid="dirty-proceed"
            disabled={busy !== null}
            type="button"
            onClick={() => resolve("proceed")}
          >
            {props.labels.proceed}
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
