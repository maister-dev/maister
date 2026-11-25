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
import {
  isDocumentHidden,
  subscribeDocumentVisibility,
} from "@/lib/sse-visibility";

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

type RunStreamState = {
  runId: string | null;
  status: RunStreamStatus;
  liveness: RunStreamLifecycleKind;
  events: RunStreamEvent[];
  eventCount: number;
  lastEventId: string | null;
  error: string | null;
};

function initialRunStreamState(runId: string | null): RunStreamState {
  return {
    runId,
    status: runId ? "connecting" : "closed",
    liveness: runId ? "connecting" : "closed",
    events: [],
    eventCount: 0,
    lastEventId: null,
    error: null,
  };
}

export function useRunStream(
  runId: string | null,
  options?: UseRunStreamOptions,
): UseRunStreamResult {
  const retain = options?.retain ?? true;
  const replay = options?.replay ?? retain;
  const [state, setState] = useState<RunStreamState>(() =>
    initialRunStreamState(runId),
  );
  const [context, setContext] = useState<ContextSnapshot | null>(null);
  const [attemptContext, setAttemptContext] = useState<ContextSnapshot | null>(
    null,
  );
  const sourceRef = useRef<EventSource | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const lifecycleRef = useRef(initialRunStreamLifecycle);
  const cursorRunRef = useRef<string | null>(runId);
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
    const currentRunId = cursorRunRef.current;

    if (currentRunId !== null) {
      setState((current) => {
        const base =
          current.runId === currentRunId
            ? current
            : initialRunStreamState(currentRunId);

        return {
          ...base,
          status: "connecting",
          liveness: lifecycleRef.current.kind,
          error: null,
        };
      });
    }
    setReconnectKey((k) => k + 1);
  }, []);

  // The effect owns the EventSource; keyed state resets during render when
  // `runId` changes, and async callbacks update state only for the active run.
  useEffect(() => {
    if (cursorRunRef.current !== runId) {
      cursorRunRef.current = runId;
      lastEventIdRef.current = null;
      needsVisibilityCatchUpRef.current = false;
      lifecycleRef.current = initialRunStreamLifecycle;
    }
    if (!runId) {
      lifecycleRef.current = advanceRunStreamLifecycle(
        lifecycleRef.current,
        "terminal",
      );

      return;
    }

    const pauseWhenHidden = !retain;
    const activeRunId = runId;
    let disposed = false;

    function updateActiveState(
      updater: (current: RunStreamState) => RunStreamState,
    ): void {
      if (disposed || cursorRunRef.current !== activeRunId) return;
      setState((current) => {
        const base =
          current.runId === activeRunId
            ? current
            : initialRunStreamState(activeRunId);

        return updater(base);
      });
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
      const origin =
        typeof window !== "undefined"
          ? window.location.origin
          : "http://localhost";
      const url = new URL(
        buildRunStreamUrl(origin, activeRunId, lastEventIdRef.current, replay),
      );

      url.searchParams.set("context", "1");
      const es = new EventSource(url.toString());
      let bumpedOnVisibilityOpen = false;

      sourceRef.current = es;
      es.onopen = () => {
        if (disposed || sourceRef.current !== es) return;
        lifecycleRef.current = advanceRunStreamLifecycle(
          lifecycleRef.current,
          "opened",
        );
        let shouldCatchUp = false;

        if (pauseWhenHidden && needsVisibilityCatchUpRef.current) {
          needsVisibilityCatchUpRef.current = false;
          bumpedOnVisibilityOpen = true;
          shouldCatchUp = true;
        }
        updateActiveState((current) => ({
          ...current,
          status: "open",
          liveness: lifecycleRef.current.kind,
          error: null,
          eventCount: current.eventCount + (shouldCatchUp ? 1 : 0),
        }));
      };
      es.onmessage = (msg) => {
        if (disposed || sourceRef.current !== es) return;
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
          }
          if (parsed.contextUsageOnly === true) {
            if (cursor !== null) {
              updateActiveState((current) => ({
                ...current,
                lastEventId: cursor,
              }));
            }

            return;
          }
          if (
            parsed.type === "session.stream_ready" &&
            bumpedOnVisibilityOpen
          ) {
            bumpedOnVisibilityOpen = false;
            if (cursor !== null) {
              updateActiveState((current) => ({
                ...current,
                lastEventId: cursor,
              }));
            }

            return;
          }
          updateActiveState((current) => ({
            ...current,
            lastEventId: cursor ?? current.lastEventId,
            eventCount: current.eventCount + 1,
            events: retain ? [...current.events, parsed] : current.events,
          }));
        } catch {
          /* skip malformed */
        }
      };
      es.onerror = () => {
        if (disposed || sourceRef.current !== es) return;
        if (pauseWhenHidden && isDocumentHidden()) {
          clearReconnectTimer();
          closeSource();
          needsVisibilityCatchUpRef.current = true;
          lifecycleRef.current = initialRunStreamLifecycle;

          return;
        }

        sourceRef.current = null;
        es.close();
        lifecycleRef.current = advanceRunStreamLifecycle(
          lifecycleRef.current,
          "unexpected_close",
        );
        updateActiveState((current) => ({
          ...current,
          status: "closed",
          liveness: lifecycleRef.current.kind,
          error: "eventsource error",
        }));

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
          updateActiveState((current) => ({
            ...current,
            status: "connecting",
            liveness: lifecycleRef.current.kind,
          }));
          setReconnectKey((key) => key + 1);
        }, delay);
      };
    }

    connect();
    const unsubscribeVisibility = pauseWhenHidden
      ? subscribeDocumentVisibility({
          onHide: () => {
            if (disposed) return;
            clearReconnectTimer();
            closeSource();
            needsVisibilityCatchUpRef.current = true;
            lifecycleRef.current = initialRunStreamLifecycle;
          },
          onShow: () => {
            if (disposed || sourceRef.current !== null) return;
            lifecycleRef.current = initialRunStreamLifecycle;
            updateActiveState((current) => ({
              ...current,
              status: "connecting",
              liveness: lifecycleRef.current.kind,
              error: null,
            }));
            connect();
          },
        })
      : null;

    return () => {
      disposed = true;
      unsubscribeVisibility?.();
      clearReconnectTimer();
      closeSource();
    };
  }, [runId, reconnectKey, replay, retain]);

  const activeState =
    state.runId === runId ? state : initialRunStreamState(runId);

  return {
    context: context?.runId === runId ? context : null,
    attemptContext: attemptContext?.runId === runId ? attemptContext : null,
    events: activeState.events,
    eventCount: activeState.eventCount,
    status: activeState.status,
    liveness: activeState.liveness,
    lastEventId: activeState.lastEventId,
    error: activeState.error,
    reconnect,
  };
}
