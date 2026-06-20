"use client";

import type {
  DiffViewLabels,
  PreparedFile,
  RunDiffFile,
} from "@/components/workbench/diff-view";
import type { ReactElement } from "react";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { DiffView } from "@/components/workbench/diff-view";
import { readApiError } from "@/lib/api-error";

export type LocalPackageDiffLabels = {
  title: string;
  changed: string; // non-ICU "$count changed"
  clean: string;
  error: string;
  commit: string;
  commitMessagePlaceholder: string;
  discard: string;
  discardConfirm: string;
  committing: string;
  discarding: string;
  committed: string;
  discarded: string;
  actionFailed: string;
};

// The server `WorkingDirDiff` DTO (`@git-diff-view` shape + a changed-count). No
// `working_dir` / abs path — server-only fields are never projected.
type WorkingDirDiff = {
  files: RunDiffFile[];
  perFile: PreparedFile[];
  truncated: boolean;
  changedCount: number;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; diff: WorkingDirDiff }
  | { kind: "error"; message: string };

type ActionState =
  | { kind: "idle" }
  | { kind: "committing" }
  | { kind: "discarding" }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

/**
 * The local-package GIT diff drawer (M36 T4.2). Renders the working-tree-vs-HEAD
 * diff of the editable local package (the uncommitted edits) via the shared
 * <DiffView>, with a `⎇ N changed · Commit · Discard` top bar.
 *
 * - The diff is re-fetched on mount and whenever `refreshSignal` changes (the
 *   editor bumps it after any save/import), AND after a commit/discard.
 * - Commit (optional message) / Discard (confirm) POST to the lock-guarded
 *   routes carrying the editor `sessionId`; a lost lock surfaces as an error.
 * - `onChanged` reports the changed-count up so the editor can badge it.
 *
 * `working_dir` never reaches this client — the DTO is the `@git-diff-view`
 * shape only, and `truncated` is threaded into <DiffView> so a partial diff is
 * flagged, never silently shown as the whole change.
 */
export function LocalPackageDiffDrawer({
  packageId,
  sessionId,
  canManage,
  refreshSignal,
  diffViewLabels,
  labels,
  onChanged,
}: {
  packageId: string;
  sessionId: string;
  canManage: boolean;
  refreshSignal: number;
  diffViewLabels: DiffViewLabels;
  labels: LocalPackageDiffLabels;
  onChanged?: (changedCount: number) => void;
}): ReactElement {
  const tApiErrors = useTranslations("apiErrors");
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const [message, setMessage] = useState("");

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/studio/local-packages/${packageId}/diff`, {
        method: "GET",
      });

      if (!res.ok) {
        setState({
          kind: "error",
          message: await readApiError(res, tApiErrors),
        });

        return;
      }

      const diff = (await res.json()) as WorkingDirDiff;

      setState({ kind: "ready", diff });
      onChanged?.(diff.changedCount);
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [packageId, tApiErrors, onChanged]);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  const mutate = useCallback(
    async (
      op: "commit" | "discard",
      body: Record<string, unknown>,
    ): Promise<void> => {
      setAction({ kind: op === "commit" ? "committing" : "discarding" });
      try {
        const res = await fetch(
          `/api/studio/local-packages/${packageId}/${op}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId, ...body }),
          },
        );

        if (!res.ok) {
          setAction({
            kind: "error",
            message: await readApiError(res, tApiErrors),
          });

          return;
        }

        const diff = (await res.json()) as WorkingDirDiff;

        setState({ kind: "ready", diff });
        onChanged?.(diff.changedCount);
        if (op === "commit") setMessage("");
        setAction({
          kind: "done",
          message: op === "commit" ? labels.committed : labels.discarded,
        });
      } catch (err) {
        setAction({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [packageId, sessionId, tApiErrors, onChanged, labels],
  );

  const changedCount = state.kind === "ready" ? state.diff.changedCount : 0;
  const busy = action.kind === "committing" || action.kind === "discarding";
  const canAct = canManage && changedCount > 0 && !busy;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2" data-testid="lp-diff">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <span
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-ivory px-2 py-1 font-mono text-[11px] font-semibold text-ink"
          data-testid="lp-diff-changed"
        >
          <span aria-hidden>⎇</span>
          {labels.changed.replace("$count", String(changedCount))}
        </span>

        {canManage ? (
          <>
            <input
              aria-label={labels.commitMessagePlaceholder}
              className="h-7 min-w-[160px] flex-1 rounded-md border border-line bg-ivory px-2 font-mono text-[11px] text-ink outline-none placeholder:text-mute focus:border-ink disabled:opacity-50"
              data-testid="lp-diff-message"
              disabled={busy}
              placeholder={labels.commitMessagePlaceholder}
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <button
              className="shrink-0 rounded-md bg-ink px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-paper hover:bg-ink-2 disabled:opacity-50"
              data-testid="lp-diff-commit"
              disabled={!canAct}
              type="button"
              onClick={() => void mutate("commit", { message })}
            >
              {action.kind === "committing" ? labels.committing : labels.commit}
            </button>
            <button
              className="shrink-0 rounded-md border border-danger-line bg-danger-soft px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-danger hover:bg-paper disabled:opacity-50"
              data-testid="lp-diff-discard"
              disabled={!canAct}
              type="button"
              onClick={() => {
                if (window.confirm(labels.discardConfirm)) {
                  void mutate("discard", {});
                }
              }}
            >
              {action.kind === "discarding"
                ? labels.discarding
                : labels.discard}
            </button>
          </>
        ) : null}
      </div>

      {action.kind === "done" ? (
        <p
          className="shrink-0 rounded-md border border-line bg-ivory px-2 py-1 font-mono text-[10px] text-good"
          data-testid="lp-diff-action-done"
          role="status"
        >
          <span aria-hidden>✓</span> {action.message}
        </p>
      ) : null}
      {action.kind === "error" ? (
        <p
          className="shrink-0 rounded-md border border-danger-line bg-danger-soft px-2 py-1 font-mono text-[10px] text-danger"
          data-testid="lp-diff-action-error"
          role="alert"
        >
          {labels.actionFailed} — {action.message}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {state.kind === "loading" ? (
          <p className="p-4 text-center font-mono text-[11px] text-mute">…</p>
        ) : state.kind === "error" ? (
          <p
            className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 font-mono text-[11px] text-danger"
            data-testid="lp-diff-error"
            role="alert"
          >
            {labels.error} — {state.message}
          </p>
        ) : state.diff.changedCount === 0 ? (
          <p
            className="rounded-md border border-line bg-paper p-4 font-mono text-[11px] text-mute"
            data-testid="lp-diff-clean"
          >
            {labels.clean}
          </p>
        ) : (
          <DiffView
            files={state.diff.files}
            labels={diffViewLabels}
            perFile={state.diff.perFile}
            truncated={state.diff.truncated}
            onRefresh={() => void load()}
          />
        )}
      </div>
    </div>
  );
}
