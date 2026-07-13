"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  advanceRunStreamLifecycle,
  buildRunStreamUrl,
  initialRunStreamLifecycle,
  reconnectDelayMs,
  type RunStreamLifecycleKind,
} from "@/lib/run-stream-controller";

export type RunStreamEvent = {
  type: string;
  monotonicId: number;
  [key: string]: unknown;
};

export type RunStreamStatus = "connecting" | "open" | "closed";

export type UseRunStreamResult = {
  events: RunStreamEvent[];
  eventCount: number;
  status: RunStreamStatus;
  liveness: RunStreamLifecycleKind;
  lastEventId: number | null;
  error: string | null;
  reconnect: () => void;
};

export type UseRunStreamOptions = {
  // Default true. Pass false for consumers that only need a change-tick
  // (`eventCount`) on a long-lived run — skips retaining every event in state,
  // which would otherwise grow unbounded for the lifetime of the stream.
  retain?: boolean;
  // Default follows `retain`. Tick-only consumers should live-tail instead of
  // replaying the full event log on every reconnect.
  replay?: boolean;
};

export function useRunStream(
  runId: string | null,
  options?: UseRunStreamOptions,
): UseRunStreamResult {
  const retain = options?.retain ?? true;
  const replay = options?.replay ?? retain;
  const [events, setEvents] = useState<RunStreamEvent[]>([]);
  const [eventCount, setEventCount] = useState(0);
  const [status, setStatus] = useState<RunStreamStatus>("connecting");
  const [liveness, setLiveness] =
    useState<RunStreamLifecycleKind>("connecting");
  const [lastEventId, setLastEventId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const lastEventIdRef = useRef<number | null>(null);
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
    setError(null);
    setReconnectKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!runId) {
      setStatus("closed");
      lifecycleRef.current = advanceRunStreamLifecycle(
        lifecycleRef.current,
        "terminal",
      );
      setLiveness(lifecycleRef.current.kind);

      return;
    }
    if (lifecycleRef.current.kind === "closed") {
      lifecycleRef.current = initialRunStreamLifecycle;
    }
    setStatus("connecting");
    setLiveness(lifecycleRef.current.kind);
    const origin =
      typeof window !== "undefined"
        ? window.location.origin
        : "http://localhost";
    const es = new EventSource(
      buildRunStreamUrl(origin, runId, lastEventIdRef.current, replay),
    );

    sourceRef.current = es;
    es.onopen = () => {
      lifecycleRef.current = advanceRunStreamLifecycle(
        lifecycleRef.current,
        "opened",
      );
      setStatus("open");
      setLiveness(lifecycleRef.current.kind);
      setError(null);
    };
    es.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as RunStreamEvent;

        setEventCount((c) => c + 1);
        if (retain) setEvents((cur) => [...cur, parsed]);
        if (typeof parsed.monotonicId === "number") {
          lastEventIdRef.current = parsed.monotonicId;
          setLastEventId(parsed.monotonicId);
        }
      } catch {
        /* skip malformed */
      }
    };
    es.onerror = () => {
      setError("eventsource error");
      if (sourceRef.current !== es) return;

      es.close();
      sourceRef.current = null;
      setStatus("closed");
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
      es.close();
      if (sourceRef.current === es) sourceRef.current = null;
    };
  }, [runId, reconnectKey, replay, retain]);

  return {
    events,
    eventCount,
    status,
    liveness,
    lastEventId,
    error,
    reconnect,
  };
}
