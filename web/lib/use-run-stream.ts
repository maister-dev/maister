"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
  const [lastEventId, setLastEventId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const lastEventIdRef = useRef<number | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);

  const reconnect = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
    setReconnectKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!runId) {
      setStatus("closed");

      return;
    }
    setStatus("connecting");
    const url = new URL(
      `/api/runs/${encodeURIComponent(runId)}/stream`,
      typeof window !== "undefined"
        ? window.location.origin
        : "http://localhost",
    );

    if (lastEventIdRef.current !== null) {
      url.searchParams.set("lastEventId", String(lastEventIdRef.current));
    }
    if (!replay) {
      url.searchParams.set("replay", "0");
    }

    const es = new EventSource(url.toString());

    sourceRef.current = es;
    es.onopen = () => setStatus("open");
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
      if (es.readyState === EventSource.CLOSED) {
        setStatus("closed");
      }
    };

    return () => {
      es.close();
      sourceRef.current = null;
      setStatus("closed");
    };
  }, [runId, reconnectKey, replay, retain]);

  return { events, eventCount, status, lastEventId, error, reconnect };
}
