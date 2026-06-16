"use client";

import type {
  RunInspectorChangeSummary,
  RunInspectorProps,
} from "@/components/runs/run-inspector";
import type { ReactElement } from "react";

import { useEffect, useRef, useState } from "react";

import { RunInspector } from "@/components/runs/run-inspector";
import {
  CHANGE_SUMMARY_REFRESH_DEBOUNCE_MS,
  changeSummaryRefreshUrl,
  isLiveRunStatus,
} from "@/lib/runs/live-inspector";
import { useRunStream } from "@/lib/use-run-stream";

export interface LiveRunInspectorProps extends RunInspectorProps {
  runStatus: string;
  changeScope?: string;
}

// T5.4: live-refreshing wrapper over the server-rendered RunInspector. While a
// run is live it subscribes to the run SSE stream (change-tick only, retain:
// false) and re-fetches the change summary, debounced. A failed re-fetch shows
// the stale badge over the last good snapshot. Terminal runs never subscribe.
export function LiveRunInspector({
  runStatus,
  changeScope = "run",
  changeSummary: initialChangeSummary,
  ...rest
}: LiveRunInspectorProps): ReactElement {
  const live = isLiveRunStatus(runStatus);
  const [changeSummary, setChangeSummary] =
    useState<RunInspectorChangeSummary | null>(initialChangeSummary);
  const [stale, setStale] = useState(false);
  const { eventCount } = useRunStream(live ? rest.runId : null, {
    retain: false,
  });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!live || eventCount === 0) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(
            changeSummaryRefreshUrl(rest.runId, changeScope),
          );

          if (!res.ok) {
            setStale(true);

            return;
          }
          setChangeSummary((await res.json()) as RunInspectorChangeSummary);
          setStale(false);
        } catch {
          setStale(true);
        }
      })();
    }, CHANGE_SUMMARY_REFRESH_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [eventCount, live, changeScope, rest.runId]);

  return <RunInspector {...rest} changeSummary={changeSummary} stale={stale} />;
}
