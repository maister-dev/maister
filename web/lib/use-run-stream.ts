"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  ContextSnapshotSchema,
  type ContextSnapshot,
} from "@/lib/runs/context-snapshot";
import {
  advanceRunStreamLifecycle,
  buildRunStreamUrl,
  initialRunStreamLifecycle,
  reconnectDelayMs,
  runStreamCursor,
  type RunStreamLifecycleKind,
} from "@/lib/run-stream-controller";

export type RunStreamEvent = {
  type: string;
  monotonicId?: number;
  runSequence?: string;
  [key: string]: unknown;
};

export type RunStreamStatus = "connecting" | "open" | "closed";

export type UseRunStreamResult = {
  context?: ContextSnapshot | null;
  attemptContext?: ContextSnapshot | null;
  events: RunStreamEvent[];
  eventCount: number;
  status: RunStreamStatus;
  liveness: RunStreamLifecycleKind;
  lastEventId: string | null;
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
  const [context, setContext] = useState<ContextSnapshot | null>(null);
  const [attemptContext, setAttemptContext] = useState<ContextSnapshot | null>(
    null,
  );
  const [eventCount, setEventCount] = useState(0);
  const [status, setStatus] = useState<RunStreamStatus>("connecting");
  const [liveness, setLiveness] =
    useState<RunStreamLifecycleKind>("connecting");
  const [lastEventId, setLastEventId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const lifecycleRef = useRef(initialRunStreamLifecycle);
  const cursorRunRef = useRef<string | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const needsVisibilityCatchUpRef = useRef(false);
  const [reconnectKey, setReconnectKey] = useState(0);

  const reconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (sourceRef.current) {
      const current = sourceRef.current;

      sourceRef.current = null;
      current.close();
    }
    lifecycleRef.current = advanceRunStreamLifecycle(
      lifecycleRef.current,
      "manual_reconnect",
    );
    setLiveness(lifecycleRef.current.kind);
    setError(null);
    setReconnectKey((k) => k + 1);
  }, []);

  // The effect owns the EventSource; status and liveness mirror the lifecycle of
  // the connection it opens and closes.
  useEffect(() => {
    if (cursorRunRef.current !== runId) {
      cursorRunRef.current = runId;
      lastEventIdRef.current = null;
      needsVisibilityCatchUpRef.current = false;
    }
    if (!runId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStatus("closed");
      lifecycleRef.current = advanceRunStreamLifecycle(
        lifecycleRef.current,
        "terminal",
      );
      setLiveness(lifecycleRef.current.kind);

      return;
    }

    const pauseWhenHidden = !retain;
    const activeRunId = runId;
    let disposed = false;

    function isDocumentHidden(): boolean {
      return (
        typeof document !== "undefined" && document.visibilityState === "hidden"
      );
    }

    function clearReconnectTimer(): void {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    }

    function closeSource(): void {
      const current = sourceRef.current;

      sourceRef.current = null;
      current?.close();
    }

    function connect(): void {
      if (disposed || sourceRef.current !== null) return;
      if (pauseWhenHidden && isDocumentHidden()) {
        needsVisibilityCatchUpRef.current = true;

        return;
      }

      clearReconnectTimer();
      if (lifecycleRef.current.kind === "closed") {
        lifecycleRef.current = initialRunStreamLifecycle;
      }
      setStatus("connecting");
      setLiveness(lifecycleRef.current.kind);
      const origin =
        typeof window !== "undefined"
          ? window.location.origin
          : "http://localhost";
      const url = new URL(
        buildRunStreamUrl(origin, activeRunId, lastEventIdRef.current, replay),
      );

      url.searchParams.set("context", "1");
      const es = new EventSource(url.toString());

      sourceRef.current = es;
      es.onopen = () => {
        if (sourceRef.current !== es) return;
        lifecycleRef.current = advanceRunStreamLifecycle(
          lifecycleRef.current,
          "opened",
        );
        setStatus("open");
        setLiveness(lifecycleRef.current.kind);
        setError(null);
        if (pauseWhenHidden && needsVisibilityCatchUpRef.current) {
          needsVisibilityCatchUpRef.current = false;
          setEventCount((c) => c + 1);
        }
      };
      es.onmessage = (msg) => {
        if (sourceRef.current !== es) return;
        try {
          const parsed = JSON.parse(msg.data) as RunStreamEvent;

          if (parsed.type === "session.context_snapshot") {
            const snapshot = ContextSnapshotSchema.safeParse(parsed);

            if (snapshot.success && snapshot.data.runId === activeRunId) {
              if (snapshot.data.nodeAttemptId === null)
                setContext(snapshot.data);
              else setAttemptContext(snapshot.data);
            }

            return;
          }
          const cursor = runStreamCursor(parsed, msg.lastEventId);

          if (cursor !== null) {
            lastEventIdRef.current = cursor;
            setLastEventId(cursor);
          }
          if (parsed.contextUsageOnly === true) return;
          setEventCount((c) => c + 1);
          if (retain) setEvents((cur) => [...cur, parsed]);
        } catch {
          /* skip malformed */
        }
      };
      es.onerror = () => {
        if (sourceRef.current !== es) return;
        if (pauseWhenHidden && isDocumentHidden()) {
          clearReconnectTimer();
          closeSource();
          needsVisibilityCatchUpRef.current = true;
          lifecycleRef.current = initialRunStreamLifecycle;

          return;
        }
        setError("eventsource error");

        sourceRef.current = null;
        es.close();
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
          reconnectTimerRef.current = null;
          if (disposed || (pauseWhenHidden && isDocumentHidden())) return;
          lifecycleRef.current = advanceRunStreamLifecycle(
            lifecycleRef.current,
            "retrying",
          );
          setLiveness(lifecycleRef.current.kind);
          setReconnectKey((key) => key + 1);
        }, delay);
      };
    }

    function onVisibilityChange(): void {
      if (disposed || !pauseWhenHidden) return;
      if (isDocumentHidden()) {
        clearReconnectTimer();
        closeSource();
        needsVisibilityCatchUpRef.current = true;
        lifecycleRef.current = initialRunStreamLifecycle;
      } else if (sourceRef.current === null) {
        lifecycleRef.current = initialRunStreamLifecycle;
        connect();
      }
    }

    connect();
    if (pauseWhenHidden && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    return () => {
      disposed = true;
      if (pauseWhenHidden && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      clearReconnectTimer();
      closeSource();
    };
  }, [runId, reconnectKey, replay, retain]);

  return {
    context: context?.runId === runId ? context : null,
    attemptContext: attemptContext?.runId === runId ? attemptContext : null,
    events,
    eventCount,
    status,
    liveness,
    lastEventId,
    error,
    reconnect,
  };
}
