"use client";

import type { RunStreamLivenessLabels } from "@/components/feedback/run-stream-liveness";
import type { ReactElement } from "react";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { RunStreamLiveness } from "@/components/feedback/run-stream-liveness";
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
  const { tick, liveness, reconnect } = useAttentionStream(since);
  const seenRef = useRef(0);

  useEffect(() => {
    if (tick === 0 || tick === seenRef.current) return;
    seenRef.current = tick;
    // Every tick means something the page shows moved since the render (D7)
    // or since the last tick — including while disconnected.
    router.refresh();
  }, [router, tick]);

  return (
    <RunStreamLiveness
      labels={labels}
      liveness={liveness}
      onReconnect={reconnect}
    />
  );
}
