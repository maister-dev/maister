"use client";

import type { ReviewSelector } from "@/lib/queries/knowledge-memory-reviews";
import type { ReactElement, ReactNode } from "react";

import { createContext, useContext, useMemo } from "react";

import { useAttentionReviewWatch } from "@/components/attention/attention-review-watch";
import {
  useAttentionStream,
  type AttentionStreamSince,
  type UseAttentionStreamResult,
} from "@/lib/use-attention-stream";

const AttentionStreamContext = createContext<UseAttentionStreamResult | null>(
  null,
);

/**
 * Owns the single `/api/attention/stream` connection for the authenticated
 * `(app)` shell so sibling surfaces (`StatusBar`'s `AttentionLiveRefresh` and
 * `<main>`'s `TaskLaunchIntentStatus`) share one EventSource per tab.
 */
export function AttentionStreamProvider({
  children,
  since,
}: {
  children: ReactNode;
  since?: AttentionStreamSince;
}): ReactElement {
  const watch = useAttentionReviewWatch();
  const stream = useAttentionStream(since, watch?.selection);
  const value = useMemo<UseAttentionStreamResult>(
    () => ({
      tick: stream.tick,
      shellTick: stream.shellTick,
      changed: stream.changed,
      liveness: stream.liveness,
      reviewResync: stream.reviewResync,
      reconnect: stream.reconnect,
    }),
    [
      stream.tick,
      stream.shellTick,
      stream.changed,
      stream.liveness,
      stream.reviewResync,
      stream.reconnect,
    ],
  );

  return (
    <AttentionStreamContext.Provider value={value}>
      {children}
    </AttentionStreamContext.Provider>
  );
}

/**
 * Reads the shared shell attention stream when mounted inside
 * `AttentionStreamProvider`, or falls back to a local `useAttentionStream`
 * instance for standalone component renders/tests.
 */
export function useSharedAttentionStream(
  fallbackSince?: AttentionStreamSince,
  fallbackReview?: ReviewSelector | null,
): UseAttentionStreamResult {
  const shared = useContext(AttentionStreamContext);
  const local = useAttentionStream(
    fallbackSince,
    fallbackReview,
    shared === null,
  );

  return shared ?? local;
}
