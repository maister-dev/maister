"use client";

import { useEffect, useRef } from "react";

// M8 T8: client-side keep-alive ping. Wired to a run-detail page (or
// any UI surface that represents a single run). While the user is on
// the page we POST /api/runs/:runId/activity on:
//   - mount,
//   - document.visibilitychange → visible,
//   - window.focus,
//   - debounced pointerdown/keydown (5s window),
//   - periodic heartbeat at keepaliveMs/2 while the tab is visible.
//
// The heartbeat is the safety net for "focused but idle review" — long
// HITL forms that the operator is reading but not typing into. Per
// user-locked decision 2026-05-29 the heartbeat stays.
//
// Activity does NOT auto-resume idle runs (server returns 409); the
// hook silently treats 409/410 as "stop pinging" so a stale tab does
// not flood the server with noise after the run terminates.

const DEBOUNCE_MS = 5_000;

export type UseActivityPingOptions = {
  runId: string | null;
  keepaliveMs?: number;
  enabled?: boolean;
  fetcher?: typeof fetch;
};

export function useActivityPing(opts: UseActivityPingOptions): void {
  const { runId, enabled = true } = opts;
  const keepaliveMs = opts.keepaliveMs ?? 30 * 60_000;
  const fetcherRef = useRef(opts.fetcher ?? globalThis.fetch);
  const lastPingRef = useRef<number>(0);
  const stoppedRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  fetcherRef.current = opts.fetcher ?? globalThis.fetch;

  useEffect(() => {
    if (!enabled || !runId) return;
    stoppedRef.current = false;
    lastPingRef.current = 0;

    const post = async () => {
      if (stoppedRef.current) return;
      const now = Date.now();

      if (now - lastPingRef.current < DEBOUNCE_MS) return;
      lastPingRef.current = now;

      try {
        const res = await fetcherRef.current(
          `/api/runs/${encodeURIComponent(runId)}/activity`,
          { method: "POST" },
        );

        if (res.status === 410 || res.status === 409) {
          stoppedRef.current = true;
        }
      } catch {
        /* swallow network errors — next event will retry */
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") void post();
    };
    const onFocus = () => void post();
    const onPointerDown = () => void post();
    const onKeyDown = () => void post();

    void post();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);

    const heartbeatMs = Math.max(60_000, Math.floor(keepaliveMs / 2));

    intervalRef.current = setInterval(() => {
      if (document.visibilityState === "visible") {
        lastPingRef.current = 0;
        void post();
      }
    }, heartbeatMs);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      stoppedRef.current = true;
    };
  }, [runId, enabled, keepaliveMs]);
}
