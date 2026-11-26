"use client";

import type { ReviewSelector } from "@/lib/queries/knowledge-memory-reviews";

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
  isDocumentHidden,
  subscribeDocumentVisibility,
} from "@/lib/sse-visibility";
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
  reviews?: number;
  reviewVersion?: string;
  changed: Array<"decisions" | "work" | "activity" | "reviews">;
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
  /** Frames that invalidate a server-rendered region, excluding detail-only changes. */
  shellTick: number;
  /**
   * Regions the latest frame says moved. EMPTY on the connect-time snapshot;
   * consumers still refetch on that tick to catch changes since server render
   * or during disconnection.
   */
  changed: AttentionTickFrame["changed"];
  liveness: RunStreamLifecycleKind;
  reviewResync: number;
  reconnect: () => void;
}

/**
 * ADR-171 D7: where the page stands — the render's cursor and the two counters
 * it showed. The first connect carries them, so the server stays silent while
 * the page is current rather than answering with a snapshot to refresh on.
 */
export interface AttentionStreamSince {
  cursor: string;
  decisions: number;
  updates: number;
  reviews?: number;
  reviewVersion?: string;
}

type Counters = Pick<
  AttentionTickFrame,
  "decisions" | "updates" | "reviews" | "reviewVersion"
>;

function streamUrl(
  origin: string,
  lastEventId: string | null,
  counters: Counters | null,
  reviewKind: ReviewSelector["kind"] | undefined,
  reviewId: string | undefined,
): string {
  const url = new URL("/api/attention/stream", origin);

  url.searchParams.set("reviewProtocol", "1");
  if (reviewKind !== undefined && reviewId !== undefined) {
    url.searchParams.set("reviewKind", reviewKind);
    url.searchParams.set("reviewId", reviewId);
  }

  if (lastEventId !== null) {
    url.searchParams.set("lastEventId", lastEventId);
    // A baseline means something only beside the cursor it was read at.
    if (counters !== null) {
      url.searchParams.set("decisions", String(counters.decisions));
      url.searchParams.set("updates", String(counters.updates));
      if (
        counters.reviews !== undefined &&
        counters.reviewVersion !== undefined
      ) {
        url.searchParams.set("reviews", String(counters.reviews));
        url.searchParams.set("reviewVersion", counters.reviewVersion);
      }
    }
  }

  return url.toString();
}

export function useAttentionStream(
  since?: AttentionStreamSince,
  review?: ReviewSelector | null,
  enabled = true,
): UseAttentionStreamResult {
  const [tick, setTick] = useState(0);
  const [shellTick, setShellTick] = useState(0);
  const [changed, setChanged] = useState<AttentionTickFrame["changed"]>([]);
  const [liveness, setLiveness] =
    useState<RunStreamLifecycleKind>("connecting");
  const [reviewResync, setReviewResync] = useState(0);
  const reviewKind = review?.kind;
  const reviewId = review?.id;
  const renderedReviews = since?.reviews;
  const renderedReviewVersion = since?.reviewVersion;
  const reviewRender = useRef<Pick<Counters, "reviews" | "reviewVersion">>({});
  const sourceRef = useRef<EventSource | null>(null);
  // Read once, at mount: later renders move the page, not this subscription —
  // a reconnect resumes from the last tick instead.
  const lastEventIdRef = useRef<string | null>(
    since !== undefined && isSseCursor(since.cursor) ? since.cursor : null,
  );
  const countersRef = useRef<Counters | null>(
    since === undefined
      ? null
      : {
          decisions: since.decisions,
          updates: since.updates,
          reviews: since.reviews,
          reviewVersion: since.reviewVersion,
        },
  );
  const lifecycleRef = useRef(initialRunStreamLifecycle);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);

  useEffect(() => {
    reviewRender.current = {
      reviews: renderedReviews,
      reviewVersion: renderedReviewVersion,
    };
    // Only the pending review pair is refreshed here. The replay cursor and
    // other counters still advance exclusively with the tail.
    if (
      countersRef.current &&
      renderedReviews !== undefined &&
      renderedReviewVersion !== undefined
    )
      countersRef.current = { ...countersRef.current, ...reviewRender.current };
  }, [renderedReviews, renderedReviewVersion]);

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
    setReconnectKey((key) => key + 1);
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;

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
      if (disposed || sourceRef.current !== null || isDocumentHidden()) return;

      clearReconnectTimer();
      if (lifecycleRef.current.kind === "closed") {
        lifecycleRef.current = initialRunStreamLifecycle;
      }
      setLiveness(lifecycleRef.current.kind);

      const origin =
        typeof window !== "undefined"
          ? window.location.origin
          : "http://localhost";
      const source = new EventSource(
        streamUrl(
          origin,
          lastEventIdRef.current,
          countersRef.current,
          reviewKind,
          reviewId,
        ),
      );

      sourceRef.current = source;
      source.onopen = () => {
        if (sourceRef.current !== source) return;
        lifecycleRef.current = advanceRunStreamLifecycle(
          lifecycleRef.current,
          "opened",
        );
        setLiveness(lifecycleRef.current.kind);
        if (reviewId !== undefined) setReviewResync((current) => current + 1);
      };
      source.addEventListener("attention.tick", (event) => {
        if (sourceRef.current !== source) return;
        try {
          const frame = JSON.parse(
            (event as MessageEvent<string>).data,
          ) as AttentionTickFrame;

          setChanged(frame.changed);
          setTick((current) => current + 1);
          const matchesRenderedReviewQueue =
            frame.changed.length === 1 &&
            frame.changed[0] === "reviews" &&
            frame.reviews !== undefined &&
            frame.reviewVersion !== undefined &&
            frame.reviews === reviewRender.current.reviews &&
            frame.reviewVersion === reviewRender.current.reviewVersion;

          if (!matchesRenderedReviewQueue)
            setShellTick((current) => current + 1);
          if (reviewId !== undefined && frame.changed.includes("reviews"))
            setReviewResync((current) => current + 1);

          const id = (event as MessageEvent<string>).lastEventId;

          // Same spelling the route parses and the AsyncAPI declares. The
          // counters travel with the cursor they were read at.
          if (isSseCursor(id)) {
            lastEventIdRef.current = id;
            countersRef.current = {
              decisions: frame.decisions,
              updates: frame.updates,
              reviews: frame.reviews ?? countersRef.current?.reviews,
              reviewVersion:
                frame.reviewVersion ?? countersRef.current?.reviewVersion,
            };
          }
        } catch {
          /* a malformed frame is skipped, never thrown at the reader */
        }
      });
      source.addEventListener("attention.stream_timeout", (event) => {
        if (reviewId === undefined || sourceRef.current !== source) return;
        try {
          const frame = JSON.parse((event as MessageEvent<string>).data) as {
            reason?: string;
          };

          if (frame.reason === "access_revoked")
            setReviewResync((current) => current + 1);
        } catch {
          /* a malformed frame is skipped, never thrown at the reader */
        }
      });
      source.onerror = () => {
        if (sourceRef.current !== source) return;
        if (isDocumentHidden()) {
          clearReconnectTimer();
          closeSource();
          lifecycleRef.current = initialRunStreamLifecycle;

          return;
        }

        sourceRef.current = null;
        source.close();
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
          if (disposed || isDocumentHidden()) return;
          lifecycleRef.current = advanceRunStreamLifecycle(
            lifecycleRef.current,
            "retrying",
          );
          setLiveness(lifecycleRef.current.kind);
          setReconnectKey((key) => key + 1);
        }, delay);
      };
    }

    connect();
    const unsubscribeVisibility = subscribeDocumentVisibility({
      onHide: () => {
        if (disposed) return;
        clearReconnectTimer();
        closeSource();
        // Reset retry backoff so returning to visible reconnects immediately.
        lifecycleRef.current = initialRunStreamLifecycle;
      },
      onShow: () => {
        if (disposed || sourceRef.current !== null) return;
        lifecycleRef.current = initialRunStreamLifecycle;
        connect();
      },
    });

    return () => {
      disposed = true;
      unsubscribeVisibility();
      clearReconnectTimer();
      closeSource();
    };
  }, [enabled, reconnectKey, reviewKind, reviewId]);

  return { tick, shellTick, changed, liveness, reviewResync, reconnect };
}
