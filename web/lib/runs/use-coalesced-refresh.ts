"use client";

import type { CoalescedRefresher } from "@/lib/runs/coalesced-refresh";

import { useCallback, useEffect, useRef } from "react";

import { createCoalescedRefresher } from "@/lib/runs/coalesced-refresh";

export function useCoalescedRefresh(
  run: (signal: AbortSignal) => Promise<void> | void,
  intervalMs: number,
  scopeKey?: string | number | null,
): () => void {
  const runRef = useRef(run);
  const refresherRef = useRef<CoalescedRefresher | null>(null);

  useEffect(() => {
    runRef.current = run;
  }, [run]);

  useEffect(() => {
    const refresher = createCoalescedRefresher({
      intervalMs,
      run: (signal) => runRef.current(signal),
    });

    refresherRef.current = refresher;

    return () => {
      refresher.dispose();
      refresherRef.current = null;
    };
  }, [intervalMs, scopeKey]);

  return useCallback(() => {
    refresherRef.current?.trigger();
  }, []);
}
