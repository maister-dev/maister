"use client";

import type { ReactElement } from "react";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import {
  RunStreamLiveness,
  type RunStreamLivenessLabels,
} from "@/components/feedback/run-stream-liveness";
import { useRunPageStream } from "@/components/runs/run-stream-provider";
import { isLiveRunStatus } from "@/lib/runs/live-inspector";
import { runViewKey, shouldRefreshRunView } from "@/lib/runs/live-refresh";

// Coalesce chunks without waiting for an active stream to become quiet.
const REFRESH_COALESCE_MS = 800;

// Re-renders the server-rendered run-detail tree (review/HITL panel, selected
// node, readiness) when the run actually transitions. While the run is live it
// subscribes to the run SSE stream (change-tick only) and, on a tick, fetches
// the lightweight graph-status snapshot; it calls router.refresh() ONLY when the
// run status or current node changed since the last server render — never on
// plain agent output, so an active turn does not cause a full-tree refresh
// storm. Each connection also refreshes the shared layout, which Next.js may
// retain from a previous page with an older sidebar status.
export function RunLiveRefresh({
  runId,
  runStatus,
  currentStepId,
  livenessLabels,
}: {
  runId: string;
  runStatus: string;
  currentStepId: string | null;
  livenessLabels: RunStreamLivenessLabels;
}): ReactElement | null {
  const router = useRouter();
  const live = isLiveRunStatus(runStatus);
  const { eventCount, liveness, reconnect } = useRunPageStream(runId, live);
  const seenRef = useRef<string | null>(
    runViewKey({ runStatus, currentStepId }),
  );
  const scheduleRef = useRef<(() => void) | null>(null);

  // A completed server re-render delivers fresh props — adopt them as the new
  // baseline so the next transition (not this one) triggers the following
  // refresh.
  useEffect(() => {
    seenRef.current = runViewKey({ runStatus, currentStepId });
  }, [runId, runStatus, currentStepId]);

  useEffect(() => {
    if (!live) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let pending = false;

    function schedule(): void {
      if (controller.signal.aborted) return;
      pending = true;
      if (timer !== null || inFlight) return;

      timer = setTimeout(() => void checkStatus(), REFRESH_COALESCE_MS);
    }

    async function checkStatus(): Promise<void> {
      timer = null;
      pending = false;
      inFlight = true;
      try {
        const res = await fetch(`/api/runs/${runId}/graph-status`, {
          signal: controller.signal,
        });

        if (!res.ok) return;
        const snap = (await res.json()) as {
          runStatus?: string | null;
          currentStepId?: string | null;
        };

        if (controller.signal.aborted) return;
        if (
          seenRef.current === null ||
          shouldRefreshRunView(seenRef.current, snap)
        ) {
          seenRef.current = runViewKey(snap);
          router.refresh();
        }
      } catch {
        /* a transient status refetch failure retries on the next tick */
      } finally {
        inFlight = false;
        if (pending) schedule();
      }
    }

    scheduleRef.current = schedule;

    return () => {
      controller.abort();
      if (timer !== null) clearTimeout(timer);
      scheduleRef.current = null;
    };
  }, [live, runId, router]);

  useEffect(() => {
    if (liveness === "live") seenRef.current = null;
  }, [liveness, runId]);

  useEffect(() => {
    if (live && (eventCount > 0 || liveness === "live")) {
      scheduleRef.current?.();
    }
  }, [eventCount, live, liveness, runId]);

  if (!live) return null;

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 pt-3 sm:px-6">
      <RunStreamLiveness
        labels={livenessLabels}
        liveness={liveness}
        onReconnect={reconnect}
      />
    </div>
  );
}
