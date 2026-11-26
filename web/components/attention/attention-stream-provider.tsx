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

export interface UseSharedAttentionStreamResult extends UseAttentionStreamResult {
  /**
   * `true` when consuming `AttentionStreamContext` from the `(app)` shell's
   * `AttentionStreamProvider`; `false` when falling back to a standalone
   * `useAttentionStream` socket outside the provider.
   */
  isShared: boolean;
}

const AttentionStreamContext =
  createContext<UseSharedAttentionStreamResult | null>(null);

/**
 * Owns the single `/api/attention/stream` connection for the authenticated
 * `(app)` shell so sibling surfaces (`StatusBar`'s `AttentionLiveRefresh` and
 * `<main>`'s `TaskLaunchIntentStatus`) share one EventSource per tab.
 */
export function AttentionStreamProvider({
  children,
  since,
}: {
  children?: ReactNode;
  since?: AttentionStreamSince;
}): ReactElement {
  const watch = useAttentionReviewWatch();
  const stream = useAttentionStream(since, watch?.selection);
  const value = useMemo<UseSharedAttentionStreamResult>(
    () => ({
      tick: stream.tick,
      shellTick: stream.shellTick,
      changed: stream.changed,
      liveness: stream.liveness,
      reviewResync: stream.reviewResync,
      reconnect: stream.reconnect,
      isShared: true,
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
 * `AttentionStreamProvider`, or falls back to a standalone `useAttentionStream`
 * socket when rendered outside the provider.
 *
 * The standalone fallback exists solely for isolated component tests and
 * standalone renders; all authenticated `(app)` shell surfaces must stay
 * mounted inside `AttentionStreamProvider` so each tab shares one EventSource.
 */
export function useSharedAttentionStream(
  fallbackSince?: AttentionStreamSince,
  fallbackReview?: ReviewSelector | null,
): UseSharedAttentionStreamResult {
  const shared = useContext(AttentionStreamContext);
  const local = useAttentionStream(
    fallbackSince,
    fallbackReview,
    shared === null,
  );

  return shared ?? { ...local, isShared: false };
}
