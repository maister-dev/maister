"use client";

import type { RunStreamLivenessLabels } from "@/components/feedback/run-stream-liveness";
import type { ReactElement } from "react";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { RunStreamLiveness } from "@/components/feedback/run-stream-liveness";
import { useAttentionStream } from "@/lib/use-attention-stream";

/**
 * Keeps a cross-project surface fresh from the attention stream (ADR-171, T5.6).
 *
 * The surfaces it serves (`/work`, `/activity`) are server-rendered, so a tick
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
  const { tick, changed, liveness, reconnect } = useAttentionStream();
  const seenRef = useRef(0);

  useEffect(() => {
    if (tick === 0 || tick === seenRef.current) return;
    seenRef.current = tick;
    // The connect-time snapshot names no changed region — it describes the state
    // the page was already rendered from, so refreshing on it is a round trip
    // for nothing.
    if (changed.length === 0) return;
    router.refresh();
  }, [changed, router, tick]);

  return (
    <RunStreamLiveness
      labels={labels}
      liveness={liveness}
      onReconnect={reconnect}
    />
  );
}
