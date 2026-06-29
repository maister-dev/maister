"use client";

import type { ReactElement } from "react";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { isLiveRunStatus } from "@/lib/runs/live-inspector";
import { runViewKey, shouldRefreshRunView } from "@/lib/runs/live-refresh";
import { useRunStream } from "@/lib/use-run-stream";

// Debounced so a burst of streamed chunks collapses into one status check.
const REFRESH_DEBOUNCE_MS = 800;

// Re-renders the server-rendered run-detail tree (review/HITL panel, selected
// node, readiness) when the run actually transitions. While the run is live it
// subscribes to the run SSE stream (change-tick only) and, on a tick, fetches
// the lightweight graph-status snapshot; it calls router.refresh() ONLY when the
// run status or current node changed since the last server render — never on
// plain agent output, so an active turn does not cause a full-tree refresh
// storm. Terminal runs never subscribe. Renders nothing.
export function RunLiveRefresh({
  runId,
  runStatus,
  currentStepId,
}: {
  runId: string;
  runStatus: string;
  currentStepId: string | null;
}): ReactElement | null {
  const router = useRouter();
  const live = isLiveRunStatus(runStatus);
  const { eventCount } = useRunStream(live ? runId : null, { retain: false });
  const seenRef = useRef(runViewKey({ runStatus, currentStepId }));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A completed server re-render delivers fresh props — adopt them as the new
  // baseline so the next transition (not this one) triggers the following
  // refresh.
  useEffect(() => {
    seenRef.current = runViewKey({ runStatus, currentStepId });
  }, [runStatus, currentStepId]);

  useEffect(() => {
    if (!live || eventCount === 0) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/runs/${runId}/graph-status`);

          if (!res.ok) return;
          const snap = (await res.json()) as {
            runStatus?: string | null;
            currentStepId?: string | null;
          };

          if (shouldRefreshRunView(seenRef.current, snap)) {
            seenRef.current = runViewKey(snap);
            router.refresh();
          }
        } catch {
          /* a transient status refetch failure retries on the next tick */
        }
      })();
    }, REFRESH_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [eventCount, live, runId, router]);

  return null;
}
