"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  advanceRunStreamLifecycle,
  initialRunStreamLifecycle,
  reconnectDelayMs,
  type RunStreamLifecycleKind,
} from "@/lib/run-stream-controller";

// The study stream emits NAMED SSE events (`event: <type>` per frame), which
// never reach `EventSource.onmessage` — each type needs an explicit listener.
// Hand-mirror of the durable taxonomy: fsm.ts `eventTypeForTransition` + the
// append sites (evaluation.queued / review.* / verdict.recorded) + the route's
// stream_timeout frame.
const STUDY_STREAM_EVENT_TYPES = [
  "evaluation.queued",
  "evidence.capture_started",
  "evidence.snapshot_sealed",
  "evidence.capture_failed",
  "objective_check.completed",
  "evaluation.partial",
  "evaluation.failed",
  "panel.quorum_reached",
  "evaluation.completed",
  "panel.partial",
  "evaluation.cancelling",
  "evaluation.cancelled",
  "evaluation.transition",
  "review.required",
  "review.resolved",
  "verdict.recorded",
  "stream_timeout",
] as const;

export interface UseStudyStreamResult {
  liveness: RunStreamLifecycleKind;
  reconnect: () => void;
}

// One EventSource per Study Lab page while the study has active executions.
// Presentation-only (read model, D17): each event only ticks `onEvent` so the
// caller can debounce an RSC refresh; the last seen `id:` is kept in a ref and
// re-sent as `?lastEventId=` on every (re)open so a reconnect resumes the tail
// instead of replaying the whole event log from 0.
export function useStudyStream(args: {
  slug: string;
  studyId: string;
  active: boolean;
  onEvent: () => void;
}): UseStudyStreamResult {
  const { slug, studyId, active, onEvent } = args;
  const [liveness, setLiveness] =
    useState<RunStreamLifecycleKind>("connecting");
  const [reconnectKey, setReconnectKey] = useState(0);
  const sourceRef = useRef<EventSource | null>(null);
  const lastEventIdRef = useRef<number | null>(null);
  const lifecycleRef = useRef(initialRunStreamLifecycle);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEventRef = useRef(onEvent);

  onEventRef.current = onEvent;

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
    if (!active) {
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
    setLiveness(lifecycleRef.current.kind);

    const url = new URL(
      `/api/projects/${encodeURIComponent(slug)}/evaluations/studies/${encodeURIComponent(studyId)}/stream`,
      window.location.origin,
    );

    if (lastEventIdRef.current !== null) {
      url.searchParams.set("lastEventId", String(lastEventIdRef.current));
    }
    const es = new EventSource(url.toString());

    sourceRef.current = es;
    es.onopen = () => {
      lifecycleRef.current = advanceRunStreamLifecycle(
        lifecycleRef.current,
        "opened",
      );
      setLiveness(lifecycleRef.current.kind);
    };

    const onStreamEvent = (msg: MessageEvent): void => {
      const id = Number.parseInt(msg.lastEventId, 10);

      if (Number.isFinite(id) && id > 0) lastEventIdRef.current = id;
      onEventRef.current();
    };

    for (const type of STUDY_STREAM_EVENT_TYPES) {
      es.addEventListener(type, onStreamEvent);
    }
    // Future unnamed frames still tick the consumer.
    es.onmessage = onStreamEvent;

    es.onerror = () => {
      if (sourceRef.current !== es) return;

      es.close();
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
      es.close();
      if (sourceRef.current === es) sourceRef.current = null;
    };
  }, [slug, studyId, active, reconnectKey]);

  return { liveness, reconnect };
}
