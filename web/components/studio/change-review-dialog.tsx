"use client";

import type {
  DiffViewLabels,
  PreparedFile,
  RunDiffFile,
} from "@/components/workbench/diff-view";
import type { ReactElement } from "react";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { DiffView } from "@/components/workbench/diff-view";
import { readApiError } from "@/lib/api-error";

export type ChangeReviewDialogLabels = {
  title: string;
  changed: string; // non-ICU "$count changed"
  clean: string;
  loadError: string;
  messageLabel: string;
  messagePlaceholder: string;
  commit: string;
  committing: string;
  cancel: string;
  invalidTitle: string;
};

// NOTE: the `buildChangeReviewLabels` builder lives in `lib/flows/editor/
// editor-labels.ts` (server-safe), NOT here — a server component (the editor
// page) calls it during render, and a function exported from this `"use client"`
// module would be a client reference that throws when called on the server.

type WorkingDirDiff = {
  files: RunDiffFile[];
  perFile: PreparedFile[];
  truncated: boolean;
  changedCount: number;
};

type InvalidArtifact = { path: string; message: string };

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; diff: WorkingDirDiff }
  | { kind: "error"; message: string };

/**
 * A shared "review your working-tree changes, then commit" modal (M39 A3). It is
 * self-contained: it fetches the working-tree diff (GET /diff), takes an editable
 * commit message, and POSTs the commit (the lock-guarded route → the commit-time
 * validation gate). When the gate HARD-BLOCKS (PRECONDITION carrying
 * `details.invalidArtifacts`), the per-artifact error list renders inline and the
 * dialog stays open so the author can fix and retry. Reused by Stream B for the
 * launch/publish flows (same diff + commit-message surface).
 *
 * `working_dir` never reaches the client — the diff DTO is the `@git-diff-view`
 * shape only, and `truncated` is threaded so a partial diff is flagged.
 */
export function ChangeReviewDialog({
  packageId,
  sessionId,
  labels,
  diffViewLabels,
  onClose,
  onCommitted,
}: {
  packageId: string;
  sessionId: string;
  labels: ChangeReviewDialogLabels;
  diffViewLabels: DiffViewLabels;
  onClose: () => void;
  onCommitted?: () => void;
}): ReactElement {
  const tApiErrors = useTranslations("apiErrors");
  const onCloseRef = useRef(onClose);

  onCloseRef.current = onClose;

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<InvalidArtifact[]>([]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onCloseRef.current();
    }

    document.addEventListener("keydown", onKeyDown);

    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/studio/local-packages/${packageId}/diff`);

      if (!res.ok) {
        setState({
          kind: "error",
          message: await readApiError(res, tApiErrors),
        });

        return;
      }

      setState({ kind: "ready", diff: (await res.json()) as WorkingDirDiff });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [packageId, tApiErrors]);

  useEffect(() => {
    void load();
  }, [load]);

  async function commit(): Promise<void> {
    setCommitting(true);
    setError(null);
    setInvalid([]);

    try {
      const res = await fetch(
        `/api/studio/local-packages/${packageId}/commit`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, message }),
        },
      );

      if (!res.ok) {
        // Read the body off a CLONE so readApiError can still consume the
        // original for the localized fallback message.
        const body = (await res
          .clone()
          .json()
          .catch(() => null)) as {
          details?: { invalidArtifacts?: InvalidArtifact[] };
        } | null;
        const list = body?.details?.invalidArtifacts;

        if (Array.isArray(list) && list.length > 0) {
          setInvalid(list);
        } else {
          setError(await readApiError(res, tApiErrors));
        }

        return;
      }

      onCommitted?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitting(false);
    }
  }

  const changedCount = state.kind === "ready" ? state.diff.changedCount : 0;

  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid="change-review-dialog"
      role="dialog"
    >
      <div className="flex max-h-[85vh] w-full max-w-[760px] flex-col gap-3 rounded-[16px] border border-line bg-paper p-6 shadow-xl">
        <div className="flex items-center justify-between gap-2">
          <h3
            className="m-0 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-mute"
            id="change-review-title"
          >
            {labels.title}
          </h3>
          <span
            className="font-mono text-[11px] font-semibold text-ink"
            data-testid="change-review-changed"
          >
            <span aria-hidden>⎇</span>{" "}
            {labels.changed.replace("$count", String(changedCount))}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto rounded-[10px] border border-line">
          {state.kind === "loading" ? (
            <p className="p-4 text-center font-mono text-[11px] text-mute">…</p>
          ) : state.kind === "error" ? (
            <p
              className="m-3 rounded-md border border-danger-line bg-danger-soft px-3 py-2 font-mono text-[11px] text-danger"
              role="alert"
            >
              {labels.loadError} — {state.message}
            </p>
          ) : changedCount === 0 ? (
            <p
              className="m-3 rounded-md border border-line bg-paper p-4 font-mono text-[11px] text-mute"
              data-testid="change-review-clean"
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

        {invalid.length > 0 ? (
          <div
            className="rounded-[10px] border border-danger-line bg-danger-soft p-3"
            data-testid="change-review-invalid"
            role="alert"
          >
            <p className="m-0 mb-1.5 font-mono text-[11px] font-semibold text-danger">
              {labels.invalidTitle}
            </p>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {invalid.map((artifact) => (
                <li
                  key={artifact.path}
                  className="font-mono text-[11px] text-danger"
                >
                  <span className="font-semibold">{artifact.path}</span> —{" "}
                  {artifact.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {error ? (
          <p
            className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 font-mono text-[11px] text-danger"
            data-testid="change-review-error"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label={labels.messageLabel}
            className="h-9 min-w-[200px] flex-1 rounded-[10px] border border-line bg-ivory px-3 font-mono text-[12px] text-ink outline-none placeholder:text-mute focus:border-ink disabled:opacity-50"
            data-testid="change-review-message"
            disabled={committing}
            placeholder={labels.messagePlaceholder}
            type="text"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
          <button
            className="rounded-[10px] border border-line bg-paper px-3 py-2 text-[12px] text-mute hover:text-ink-2"
            data-testid="change-review-cancel"
            type="button"
            onClick={onClose}
          >
            {labels.cancel}
          </button>
          <button
            className="rounded-[10px] bg-ink px-4 py-2 text-[12px] font-bold uppercase tracking-[0.06em] text-paper hover:bg-ink-2 disabled:opacity-50"
            data-testid="change-review-commit"
            disabled={committing || changedCount === 0}
            type="button"
            onClick={() => void commit()}
          >
            {committing ? labels.committing : labels.commit}
          </button>
        </div>
      </div>
    </div>
  );
}
