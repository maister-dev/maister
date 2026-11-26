"use client";

import type { ReactElement } from "react";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import {
  RunStreamLiveness,
  type RunStreamLivenessLabels,
} from "@/components/feedback/run-stream-liveness";
import { useWorkbenchStream } from "@/components/runs/run-workbench-stream-provider";
import { useRunPageStream } from "@/components/runs/run-stream-provider";
import { isLiveRunStatus } from "@/lib/runs/live-inspector";
import { runViewKey, shouldRefreshRunView } from "@/lib/runs/live-refresh";
import { useCoalescedRefresh } from "@/lib/runs/use-coalesced-refresh";

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
  const workbench = useWorkbenchStream();
  const hasWorkbench = Boolean(workbench);
  const live = isLiveRunStatus(runStatus);
  const { eventCount, liveness, reconnect } = useRunPageStream(runId, live);
  const seenRef = useRef<string | null>(
    runViewKey({ runStatus, currentStepId }),
  );
  const metadataVersion = workbench
    ? `${workbench.mainSummaryTick}:${live ? 0 : workbench.mainExecutionTick}`
    : "legacy";
  const metadataRef = useRef(metadataVersion);
  const seenMetadataRef = useRef("legacy");

  useEffect(() => {
    metadataRef.current = metadataVersion;
  }, [metadataVersion]);

  // A completed server re-render delivers fresh props — adopt them as the new
  // baseline so the next transition (not this one) triggers the following
  // refresh.
  useEffect(() => {
    seenRef.current = runViewKey({ runStatus, currentStepId });
  }, [runId, runStatus, currentStepId]);

  const triggerRefresh = useCoalescedRefresh(
    async (signal) => {
      try {
        if (
          metadataRef.current !== "legacy" &&
          metadataRef.current !== seenMetadataRef.current
        ) {
          seenMetadataRef.current = metadataRef.current;
          router.refresh();

          return;
        }
        const res = await fetch(`/api/runs/${runId}/graph-status`, {
          signal,
        });

        if (!res.ok) return;
        const snap = (await res.json()) as {
          runStatus?: string | null;
          currentStepId?: string | null;
        };

        if (signal.aborted) return;
        if (
          metadataRef.current !== seenMetadataRef.current ||
          seenRef.current === null ||
          shouldRefreshRunView(seenRef.current, snap)
        ) {
          seenRef.current = runViewKey(snap);
          seenMetadataRef.current = metadataRef.current;
          router.refresh();
        }
      } catch {
        /* a transient status refetch failure retries on the next tick */
      }
    },
    REFRESH_COALESCE_MS,
    live || hasWorkbench
      ? `${runId}:${live ? 1 : 0}:${hasWorkbench ? 1 : 0}`
      : null,
  );

  useEffect(() => {
    if (liveness === "live" && !hasWorkbench) seenRef.current = null;
  }, [liveness, runId, hasWorkbench]);

  const prevTriggerRef = useRef<{
    runId: string;
    live: boolean;
    hasWorkbench: boolean;
    eventCount: number;
    liveness: string;
  } | null>(null);

  useEffect(() => {
    const prev = prevTriggerRef.current;

    prevTriggerRef.current = {
      runId,
      live,
      hasWorkbench,
      eventCount,
      liveness,
    };

    const settledInWorkbench =
      prev !== null &&
      hasWorkbench &&
      prev.hasWorkbench &&
      prev.runId === runId &&
      prev.live &&
      !live &&
      prev.eventCount === eventCount &&
      prev.liveness === liveness;

    if (settledInWorkbench) {
      seenMetadataRef.current = metadataRef.current;

      return;
    }

    if ((live || hasWorkbench) && (eventCount > 0 || liveness === "live")) {
      triggerRefresh();
    }
  }, [eventCount, live, liveness, runId, hasWorkbench, triggerRefresh]);

  if (!live && !hasWorkbench) return null;

  return (
    <RunStreamLiveness
      labels={livenessLabels}
      liveness={liveness}
      onReconnect={reconnect}
    />
  );
}
