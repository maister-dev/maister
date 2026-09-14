"use client";

import type { RunStreamLivenessLabels } from "@/components/feedback/run-stream-liveness";
import type { ReactElement } from "react";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { RunStreamLiveness } from "@/components/feedback/run-stream-liveness";
import { useAttentionStream } from "@/lib/use-attention-stream";

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
}: {
  labels: RunStreamLivenessLabels;
}): ReactElement {
  const router = useRouter();
  const { tick, liveness, reconnect } = useAttentionStream();
  const seenRef = useRef(0);

  useEffect(() => {
    if (tick === 0 || tick === seenRef.current) return;
    seenRef.current = tick;
    // Initial and reconnect snapshots close the gap between the server render
    // and subscription, including changes that happened while disconnected.
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
