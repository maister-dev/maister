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
  status: RunStreamStatus;
  lastEventId: number | null;
  error: string | null;
  reconnect: () => void;
};

export function useRunStream(runId: string | null): UseRunStreamResult {
  const [events, setEvents] = useState<RunStreamEvent[]>([]);
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

    const es = new EventSource(url.toString());

    sourceRef.current = es;
    es.onopen = () => setStatus("open");
    es.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as RunStreamEvent;

        setEvents((cur) => [...cur, parsed]);
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
  }, [runId, reconnectKey]);

  return { events, status, lastEventId, error, reconnect };
}
