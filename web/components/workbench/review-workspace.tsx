"use client";

import type { ReactElement, ReactNode } from "react";

import { useSearchParams } from "next/navigation";

import RunDiff, {
  type RunDiffLabels,
  type RunDiffReviewContext,
} from "@/components/workbench/run-diff";

export interface ReviewWorkspaceLabels {
  title: string;
  source: string;
  decision: string;
}

export interface ReviewWorkspaceProps {
  runId: string;
  diffLabels: RunDiffLabels;
  review: RunDiffReviewContext;
  decision: ReactNode;
  labels: ReviewWorkspaceLabels;
}

export function ReviewWorkspaceUnavailable({
  message,
}: {
  message: string;
}): ReactElement | null {
  const searchParams = useSearchParams();

  if (searchParams.get("wb") !== "review") return null;

  return (
    <p
      className="rounded-[14px] border border-dashed border-line bg-ivory/50 p-4 font-mono text-[12px] text-mute"
      data-testid="review-workspace-unavailable"
      aria-live="polite"
      role="status"
    >
      {message}
    </p>
  );
}

// ADR-138: this is the only Flow-review decision location. The diff source is
// intentionally fixed to `review`, so a copied or stale URL cannot downgrade
// the reviewer to the committed-run or uncommitted-only comparison.
export function ReviewWorkspace({
  runId,
  diffLabels,
  review,
  decision,
  labels,
}: ReviewWorkspaceProps): ReactElement {
  return (
    <section
      aria-label={labels.title}
      className="grid min-w-0 gap-4"
      data-testid="review-workspace"
    >
      <header className="rounded-[14px] border border-amber-line bg-amber-soft/30 px-4 py-3">
        <h2 className="font-sans text-[16px] font-bold tracking-[-0.01em] text-ink">
          {labels.title}
        </h2>
        <p className="mt-1 font-mono text-[11px] leading-[1.5] text-ink-2">
          {labels.source}
        </p>
      </header>
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(300px,380px)] xl:items-start">
        <div className="min-w-0 rounded-[14px] border border-line bg-paper p-2">
          <RunDiff
            forcedScope="review"
            labels={diffLabels}
            review={review}
            runId={runId}
          />
        </div>
        <aside className="rounded-[14px] border border-line bg-paper p-4">
          <h3 className="mb-3 font-sans text-[14px] font-bold tracking-[-0.01em] text-ink">
            {labels.decision}
          </h3>
          {decision}
        </aside>
      </div>
    </section>
  );
}
