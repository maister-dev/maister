"use client";

import type { ReactElement } from "react";

import {
  ReviewThreadCardMemo,
  type ReviewCommentsLabels,
  type ReviewThread,
  type ReviewThreadActions,
} from "@/components/workbench/review-thread-card";

export interface OutdatedThreadsSectionProps {
  // The full thread list — placement filtering happens here so the owner can
  // pass the GET response wholesale.
  threads: ReviewThread[];
  currentUserId: string | null;
  canComment: boolean;
  busy?: boolean;
  labels: ReviewCommentsLabels;
  actions: ReviewThreadActions;
}

// ADR-071: threads whose stored line_content no longer matches the current
// diff at their anchor render in a collapsible list below the diff —
// file:line (side) + quoted stale snapshot — and stay resolvable there.
export function OutdatedThreadsSection({
  threads,
  currentUserId,
  canComment,
  busy = false,
  labels,
  actions,
}: OutdatedThreadsSectionProps): ReactElement | null {
  const outdated = threads.filter((thread) => thread.placement === "outdated");

  if (outdated.length === 0) return null;

  return (
    <details
      className="rounded-[10px] border border-line bg-paper"
      data-testid="outdated-threads"
    >
      <summary className="cursor-pointer px-3 py-2 font-mono text-[11px] font-semibold text-ink-2">
        {labels.outdatedTitle} ({outdated.length})
      </summary>
      <div className="flex flex-col gap-3 border-t border-line p-3">
        {outdated.map((thread) => (
          <div
            key={`${thread.root.id}:${thread.root.status}`}
            className="flex flex-col gap-1.5"
            data-testid="outdated-thread-entry"
          >
            <p
              className="font-mono text-[11px] text-mute"
              data-testid="outdated-anchor"
            >
              {thread.root.filePath}:{thread.root.line} (
              {thread.root.side === "old" ? labels.sideOld : labels.sideNew})
            </p>
            {thread.root.lineContent !== null ? (
              <blockquote
                className="m-0 border-l-2 border-line pl-2 font-mono text-[11px] text-mute"
                data-testid="outdated-quote"
              >
                {thread.root.lineContent}
              </blockquote>
            ) : null}
            <ReviewThreadCardMemo
              actions={actions}
              busy={busy}
              canComment={canComment}
              currentUserId={currentUserId}
              labels={labels}
              thread={thread}
            />
          </div>
        ))}
      </div>
    </details>
  );
}
