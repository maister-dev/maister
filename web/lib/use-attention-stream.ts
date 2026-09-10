"use client";

/**
 * The client half of the attention stream (ADR-170 D3).
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

export interface UseAttentionStreamResult {
  /** Monotonic count of frames received — the value a consumer effects on. */
  tick: number;
  /**
   * Regions the latest frame says moved. EMPTY on the connect-time snapshot,
   * which describes state the page already rendered from — a consumer skips
   * refetching on it.
   */
  changed: AttentionTickFrame["changed"];
  decisions: number | null;
  updates: number | null;
  /** Projects named by the most recent frame; empty for a counters-only tick. */
  projectIds: string[];
  liveness: RunStreamLifecycleKind;
  lastEventId: string | null;
  reconnect: () => void;
}

function streamUrl(origin: string, lastEventId: string | null): string {
  const url = new URL("/api/attention/stream", origin);

  if (lastEventId !== null) url.searchParams.set("lastEventId", lastEventId);

  return url.toString();
}

export function useAttentionStream(options?: {
  enabled?: boolean;
}): UseAttentionStreamResult {
  const enabled = options?.enabled ?? true;
  const [tick, setTick] = useState(0);
  const [changed, setChanged] = useState<AttentionTickFrame["changed"]>([]);
  const [decisions, setDecisions] = useState<number | null>(null);
  const [updates, setUpdates] = useState<number | null>(null);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [liveness, setLiveness] =
    useState<RunStreamLifecycleKind>("connecting");
  const [lastEventId, setLastEventId] = useState<string | null>(null);
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
    if (!enabled) {
      setLiveness("closed");

      return;
    }
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

        setDecisions(frame.decisions);
        setUpdates(frame.updates);
        setProjectIds(frame.projectIds);
        setChanged(frame.changed);
        setTick((current) => current + 1);

        const id = (event as MessageEvent<string>).lastEventId;

        if (/^[1-9][0-9]*$/.test(id)) {
          lastEventIdRef.current = id;
          setLastEventId(id);
        }
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
  }, [enabled, reconnectKey]);

  return {
    tick,
    changed,
    decisions,
    updates,
    projectIds,
    liveness,
    lastEventId,
    reconnect,
  };
}
