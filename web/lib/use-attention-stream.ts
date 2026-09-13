"use client";

/**
 * The client half of the attention stream (ADR-171 D3).
 *
 * A TICK, never a log. `useRunStream`'s `retain: false` idiom exists because a
 * surface a reader leaves open for a working day must not grow a per-event array
 * in React state; this hook has no retain option at all — there is nothing to
 * retain. Consumers watch `tick` and refetch.
 *
 * The lifecycle (connect / reconnect with backoff / give up) is the run stream's
 * `advanceRunStreamLifecycle`, reused rather than re-derived, so the liveness
 * pill means the same thing on every surface.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { isSseCursor } from "@/lib/sse/frame";
import {
  advanceRunStreamLifecycle,
  initialRunStreamLifecycle,
  reconnectDelayMs,
  type RunStreamLifecycleKind,
} from "@/lib/run-stream-controller";

/** Mirrors `AttentionTickEvent` in `docs/api/async/attention-stream.asyncapi.yaml`. */
export interface AttentionTickFrame {
  type: "attention.tick";
  id: string;
  occurredAt: string;
  decisions: number;
  updates: number;
  changed: Array<"decisions" | "work" | "activity">;
  projectIds: string[];
}

/**
 * Deliberately NARROWER than the frame (ADR-171 D3 fixes the wire, not this).
 *
 * The frame also carries `decisions`, `updates` and `projectIds`. None is
 * returned here, because the surfaces this hook serves are server-rendered and
 * a tick becomes `router.refresh()` — which re-reads the counters server-side.
 * Re-exposing them would be a second, client-side source for a number ADR-169
 * D8 says has exactly one, and it would be the stale one between refreshes.
 */
export interface UseAttentionStreamResult {
  /** Monotonic count of frames received — the value a consumer effects on. */
  tick: number;
  /**
   * Regions the latest frame says moved. EMPTY on the connect-time snapshot,
   * which describes state the page already rendered from — a consumer skips
   * refetching on it.
   */
  changed: AttentionTickFrame["changed"];
  liveness: RunStreamLifecycleKind;
  reconnect: () => void;
}

function streamUrl(origin: string, lastEventId: string | null): string {
  const url = new URL("/api/attention/stream", origin);

  if (lastEventId !== null) url.searchParams.set("lastEventId", lastEventId);

  return url.toString();
}

export function useAttentionStream(): UseAttentionStreamResult {
  const [tick, setTick] = useState(0);
  const [changed, setChanged] = useState<AttentionTickFrame["changed"]>([]);
  const [liveness, setLiveness] =
    useState<RunStreamLifecycleKind>("connecting");
  const sourceRef = useRef<EventSource | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const lifecycleRef = useRef(initialRunStreamLifecycle);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);

  const reconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
    lifecycleRef.current = advanceRunStreamLifecycle(
      lifecycleRef.current,
      "manual_reconnect",
    );
    setLiveness(lifecycleRef.current.kind);
    setReconnectKey((key) => key + 1);
  }, []);

  useEffect(() => {
    if (lifecycleRef.current.kind === "closed") {
      lifecycleRef.current = initialRunStreamLifecycle;
    }
    setLiveness(lifecycleRef.current.kind);

    const origin =
      typeof window !== "undefined"
        ? window.location.origin
        : "http://localhost";
    const source = new EventSource(streamUrl(origin, lastEventIdRef.current));

    sourceRef.current = source;
    source.onopen = () => {
      lifecycleRef.current = advanceRunStreamLifecycle(
        lifecycleRef.current,
        "opened",
      );
      setLiveness(lifecycleRef.current.kind);
    };
    source.addEventListener("attention.tick", (event) => {
      try {
        const frame = JSON.parse(
          (event as MessageEvent<string>).data,
        ) as AttentionTickFrame;

        setChanged(frame.changed);
        setTick((current) => current + 1);

        const id = (event as MessageEvent<string>).lastEventId;

        // Same spelling the route parses and the AsyncAPI declares.
        if (isSseCursor(id)) lastEventIdRef.current = id;
      } catch {
        /* a malformed frame is skipped, never thrown at the reader */
      }
    });
    source.onerror = () => {
      if (sourceRef.current !== source) return;

      source.close();
      sourceRef.current = null;
      lifecycleRef.current = advanceRunStreamLifecycle(
        lifecycleRef.current,
        "unexpected_close",
      );
      setLiveness(lifecycleRef.current.kind);

      const delay = reconnectDelayMs(
        lifecycleRef.current.retryAttempt - 1,
        lifecycleRef.current.kind,
      );

      if (delay === null) return;

      reconnectTimerRef.current = setTimeout(() => {
        lifecycleRef.current = advanceRunStreamLifecycle(
          lifecycleRef.current,
          "retrying",
        );
        setLiveness(lifecycleRef.current.kind);
        reconnectTimerRef.current = null;
        setReconnectKey((key) => key + 1);
      }, delay);
    };

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      source.close();
      if (sourceRef.current === source) sourceRef.current = null;
    };
  }, [reconnectKey]);

  return { tick, changed, liveness, reconnect };
}
