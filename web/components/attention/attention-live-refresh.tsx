"use client";

import type { RunStreamLivenessLabels } from "@/components/feedback/run-stream-liveness";
import type { ReactElement } from "react";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";

import { RunStreamLiveness } from "@/components/feedback/run-stream-liveness";
import { useAttentionReviewWatch } from "@/components/attention/attention-review-watch";
import {
  useAttentionStream,
  type AttentionStreamSince,
} from "@/lib/use-attention-stream";

/**
 * Keeps the app shell and current page fresh from the attention stream.
 *
 * The shell and page read models are server-rendered, so a tick
 * becomes `router.refresh()` — the server re-reads the same read models and the
 * tree re-renders. There is no client timer: the only thing that moves this
 * component is a pushed frame.
 */
export function AttentionLiveRefresh({
  labels,
  since,
}: {
  labels: RunStreamLivenessLabels;
  // ADR-171 D7: the render's cursor and counters. Without them the stream
  // opens with a snapshot, and this component refreshes an unchanged page.
  since?: AttentionStreamSince;
}): ReactElement {
  const router = useRouter();
  const watch = useAttentionReviewWatch();
  const invalidateReview = watch?.invalidate;
  const { shellTick, liveness, reconnect, reviewResync } = useAttentionStream(
    since,
    watch?.selection,
  );
  const seenRef = useRef(0);
  const [refreshing, startRefresh] = useTransition();
  const seenReviewResync = useRef(0);

  useEffect(() => {
    if (seenReviewResync.current === reviewResync) return;
    seenReviewResync.current = reviewResync;
    invalidateReview?.();
  }, [invalidateReview, reviewResync]);

  useEffect(() => {
    if (refreshing || shellTick === 0 || shellTick === seenRef.current) return;
    seenRef.current = shellTick;
    // Every tick means something the page shows moved since the render (D7)
    // or since the last tick — including while disconnected.
    // Keep the latest tick pending until React commits the current server render.
    startRefresh(() => router.refresh());
  }, [refreshing, router, shellTick]);

  return (
    <RunStreamLiveness
      labels={labels}
      liveness={liveness}
      onReconnect={reconnect}
    />
  );
}
