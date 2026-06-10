"use client";

import type { ReactElement } from "react";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  ChangedFilesList,
  DiffView,
  type DiffViewReview,
  type PreparedFile,
  type ReviewCommentAnchor,
  type ReviewCommentsLabels,
  type ReviewCommentStatus,
  type ReviewThread,
  type RunDiffFile,
} from "@/components/workbench/diff-view";

export { ChangedFilesList };
export type { RunDiffFile };

export interface RunDiffLabels {
  title: string;
  empty: string;
  error: string;
  changedFiles: string;
  added: string;
  removed: string;
  viewMode: string;
  split: string;
  unified: string;
  truncated: string;
}

export interface RunDiffReviewLabels extends ReviewCommentsLabels {
  // Generic failure prefix for the role="alert" surface; the server's
  // MaisterError message is appended (it never contains comment body content).
  error: string;
}

// Server context for review mode (ADR-071): the layout resolves identity,
// permission, and translated labels; this component owns threads + mutations.
export interface RunDiffReviewContext {
  currentUserId: string | null;
  canComment: boolean;
  labels: RunDiffReviewLabels;
}

export interface RunDiffProps {
  runId: string;
  labels: RunDiffLabels;
  // Absent → no review mode, no thread fetching — behavior identical to the
  // pre-review component.
  review?: RunDiffReviewContext;
}

type DiffState =
  | { kind: "loading" }
  | { kind: "error" }
  | {
      kind: "ready";
      files: RunDiffFile[];
      perFile: PreparedFile[];
      truncated: boolean;
    };

export type ReviewMutation =
  | { kind: "createRoot"; anchor: ReviewCommentAnchor; body: string }
  | { kind: "reply"; parentId: string; body: string }
  | { kind: "edit"; commentId: string; body: string }
  | { kind: "setStatus"; commentId: string; status: ReviewCommentStatus }
  | { kind: "delete"; commentId: string };

const JSON_HEADERS = { "content-type": "application/json" } as const;

// Maps a mutation onto the ADR-071 route family: POST collection for
// root/reply, PATCH item for edit/status, DELETE item. Anchor fields are
// spelled out — the server schemas are strict and refuse excess keys.
export function reviewMutationRequest(
  runId: string,
  mutation: ReviewMutation,
): { url: string; init: RequestInit } {
  const collection = `/api/runs/${runId}/review-comments`;

  switch (mutation.kind) {
    case "createRoot":
      return {
        url: collection,
        init: {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            filePath: mutation.anchor.filePath,
            side: mutation.anchor.side,
            line: mutation.anchor.line,
            body: mutation.body,
          }),
        },
      };
    case "reply":
      return {
        url: collection,
        init: {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            parentId: mutation.parentId,
            body: mutation.body,
          }),
        },
      };
    case "edit":
      return {
        url: `${collection}/${mutation.commentId}`,
        init: {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ body: mutation.body }),
        },
      };
    case "setStatus":
      return {
        url: `${collection}/${mutation.commentId}`,
        init: {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ status: mutation.status }),
        },
      };
    case "delete":
      return {
        url: `${collection}/${mutation.commentId}`,
        init: { method: "DELETE" },
      };
  }
}

// The route error shape is {code, message} (mapped MaisterError); the message
// never contains comment body content, so it is safe to surface verbatim.
async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };

    if (typeof body.message === "string" && body.message.length > 0) {
      return body.message;
    }
  } catch {
    // non-JSON error body — fall through to the status fallback
  }

  return `HTTP ${res.status}`;
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error && err.message.length > 0
    ? err.message
    : String(err);
}

export async function fetchReviewThreads(
  runId: string,
): Promise<ReviewThread[]> {
  const res = await fetch(`/api/runs/${runId}/review-comments`);

  if (!res.ok) throw new Error(await readErrorMessage(res));

  const body = (await res.json()) as { threads?: ReviewThread[] };

  return body.threads ?? [];
}

export type ReviewThreadsResult =
  | { threads: ReviewThread[] }
  | { error: string };

// The threads-effect body (exported for unit tests — effects do not run under
// renderToStaticMarkup): review mode off → no request at all.
export async function loadReviewThreads(
  runId: string,
  enabled: boolean,
  apply: (result: ReviewThreadsResult) => void,
): Promise<void> {
  if (!enabled) return;

  try {
    apply({ threads: await fetchReviewThreads(runId) });
  } catch (err) {
    apply({ error: errorMessageOf(err) });
  }
}

export interface ReviewMutationEffects {
  setBusy: (busy: boolean) => void;
  setThreads: (threads: ReviewThread[]) => void;
  setError: (message: string | null) => void;
  refresh: () => void;
}

// One mutation lifecycle (ADR-071 D8): perform the write, then refetch the
// threads + refresh the router so gate-panel counts update. A failed WRITE
// rejects so composers keep their drafts; a failed REFETCH resolves (the
// write landed — rejecting would re-arm the composer and invite a duplicate
// submit) and only surfaces the alert.
export async function executeReviewMutation(
  runId: string,
  mutation: ReviewMutation,
  effects: ReviewMutationEffects,
): Promise<void> {
  effects.setBusy(true);

  try {
    const { url, init } = reviewMutationRequest(runId, mutation);
    const res = await fetch(url, init);

    if (!res.ok) throw new Error(await readErrorMessage(res));

    try {
      effects.setThreads(await fetchReviewThreads(runId));
      effects.setError(null);
    } catch (refetchErr) {
      effects.setError(errorMessageOf(refetchErr));
    }
    effects.refresh();
  } catch (err) {
    effects.setError(errorMessageOf(err));
    throw err;
  } finally {
    effects.setBusy(false);
  }
}

// Review mode reaches DiffView only when the server context AND the first
// successful threads fetch are both present — a failed GET degrades to the
// bare diff instead of blanking it.
export function buildDiffViewReview(args: {
  context: RunDiffReviewContext | undefined;
  threads: ReviewThread[] | null;
  busy: boolean;
  mutate: (mutation: ReviewMutation) => Promise<void>;
}): DiffViewReview | undefined {
  const { context, threads, busy, mutate } = args;

  if (!context || threads === null) return undefined;

  return {
    threads,
    currentUserId: context.currentUserId,
    canComment: context.canComment,
    busy,
    labels: context.labels,
    onCreateRoot: (anchor, body) =>
      mutate({ kind: "createRoot", anchor, body }),
    onReply: (parentId, body) => mutate({ kind: "reply", parentId, body }),
    onEdit: (commentId, body) => mutate({ kind: "edit", commentId, body }),
    onSetStatus: (commentId, status) =>
      mutate({ kind: "setStatus", commentId, status }),
    onDelete: (commentId) => mutate({ kind: "delete", commentId }),
  };
}

export interface ReviewActionAlertProps {
  label: string;
  message: string | null;
}

export function ReviewActionAlert({
  label,
  message,
}: ReviewActionAlertProps): ReactElement | null {
  if (message === null) return null;

  return (
    <p
      className="mb-2 rounded-[10px] border border-line bg-paper px-3 py-2 font-mono text-[11px] leading-[1.5] text-rust"
      data-testid="run-diff-review-error"
      role="alert"
    >
      {message.length > 0 ? `${label}: ${message}` : label}
    </p>
  );
}

export default function RunDiff({
  runId,
  labels,
  review,
}: RunDiffProps): ReactElement {
  const router = useRouter();
  const [state, setState] = useState<DiffState>({ kind: "loading" });
  const [threads, setThreads] = useState<ReviewThread[] | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const hasReview = review !== undefined;

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const res = await fetch(`/api/runs/${runId}/diff`);

        if (!res.ok) {
          if (!cancelled) setState({ kind: "error" });

          return;
        }
        const body = (await res.json()) as {
          files?: RunDiffFile[];
          perFile?: PreparedFile[];
          truncated?: boolean;
        };

        if (!cancelled) {
          setState({
            kind: "ready",
            files: body.files ?? [],
            perFile: body.perFile ?? [],
            truncated: body.truncated ?? false,
          });
        }
      } catch {
        if (!cancelled) setState({ kind: "error" });
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [runId]);

  // Sibling effect → the threads GET runs in parallel with the diff GET and
  // never blocks the diff render; review mode appears when threads land.
  useEffect(() => {
    let cancelled = false;

    void loadReviewThreads(runId, hasReview, (result) => {
      if (cancelled) return;
      if ("threads" in result) setThreads(result.threads);
      else setReviewError(result.error);
    });

    return () => {
      cancelled = true;
    };
  }, [runId, hasReview]);

  const mutate = useCallback(
    (mutation: ReviewMutation): Promise<void> =>
      executeReviewMutation(runId, mutation, {
        setBusy: setReviewBusy,
        setThreads,
        setError: setReviewError,
        refresh: () => router.refresh(),
      }),
    [runId, router],
  );

  // Memoized so the DiffViewReview object (and its onReply / onEdit /
  // onSetStatus / onDelete / onCreateRoot closures) keeps a stable identity
  // across renders that don't change the threads, busy flag, or mutate handle.
  const diffReview = useMemo(
    () =>
      buildDiffViewReview({
        context: review,
        threads,
        busy: reviewBusy,
        mutate,
      }),
    [review, threads, reviewBusy, mutate],
  );

  if (state.kind === "loading") {
    return (
      <p
        className="p-4 text-center font-mono text-[11px] text-mute"
        data-testid="run-diff-loading"
      >
        {labels.title}
      </p>
    );
  }

  if (state.kind === "error") {
    return (
      <p
        className="p-4 text-center font-mono text-[11px] text-rust"
        data-testid="run-diff-error"
        role="alert"
      >
        {labels.error}
      </p>
    );
  }

  return (
    <div data-testid="run-diff">
      {review ? (
        <ReviewActionAlert label={review.labels.error} message={reviewError} />
      ) : null}
      <p className="mb-2 px-2 py-1 font-mono text-[9.5px] font-bold uppercase tracking-[0.06em] text-mute">
        {labels.changedFiles}
      </p>
      <DiffView
        files={state.files}
        labels={{
          empty: labels.empty,
          added: labels.added,
          removed: labels.removed,
          viewMode: labels.viewMode,
          split: labels.split,
          unified: labels.unified,
          truncated: labels.truncated,
        }}
        perFile={state.perFile}
        review={diffReview}
        truncated={state.truncated}
      />
    </div>
  );
}
