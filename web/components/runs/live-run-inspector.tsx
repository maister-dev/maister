"use client";

import type {
  RunInspectorChangeSummary,
  RunInspectorFact,
  RunInspectorProps,
} from "@/components/runs/run-inspector";
import type { RunCostSummary } from "@/lib/queries/run";
import type { CostSummaryFactLabels } from "@/lib/runs/cost-summary-facts";
import type { ReactElement } from "react";

import { useEffect, useMemo, useRef, useState } from "react";

import { RunInspector } from "@/components/runs/run-inspector";
import { buildCostSummaryFacts } from "@/lib/runs/cost-summary-facts";
import {
  CHANGE_SUMMARY_REFRESH_DEBOUNCE_MS,
  changeSummaryRefreshUrl,
  costSummaryRefreshUrl,
  formatRunDuration,
  isLiveRunStatus,
} from "@/lib/runs/live-inspector";
import { useRunStream } from "@/lib/use-run-stream";

// Live token-cost poll config: the cost facts (token totals) carried in `facts`
// are replaced by label as cost.jsonl grows during the run.
export interface LiveCostConfig {
  initial: RunCostSummary;
  labels: CostSummaryFactLabels;
}

// Live wall-clock config: the `label` fact's value ticks client-side while the
// run is live (endedAtMs null) so elapsed time advances without a reload.
export interface LiveWallClockConfig {
  startedAtMs: number;
  endedAtMs: number | null;
  label: string;
}

export interface LiveRunInspectorProps extends RunInspectorProps {
  runStatus: string;
  changeScope?: string;
  liveCost?: LiveCostConfig;
  liveWallClock?: LiveWallClockConfig;
}

// T5.4: live-refreshing wrapper over the server-rendered RunInspector. While a
// run is live it subscribes to the run SSE stream (change-tick only, retain:
// false) and re-fetches the change summary, debounced. A failed re-fetch shows
// the stale badge over the last good snapshot. Terminal runs never subscribe.
// It also keeps the token-cost facts and the wall-clock fact live: cost is
// re-fetched on each SSE tick (cost.jsonl grows mid-turn), and elapsed time
// ticks on a 1s client interval — both spliced into `facts` by label so the
// fact order rendered by RunInspector is unchanged.
export function LiveRunInspector({
  runStatus,
  changeScope = "run",
  changeSummary: initialChangeSummary,
  liveCost,
  liveWallClock,
  facts,
  ...rest
}: LiveRunInspectorProps): ReactElement {
  const live = isLiveRunStatus(runStatus);
  const [changeSummary, setChangeSummary] =
    useState<RunInspectorChangeSummary | null>(initialChangeSummary);
  const [stale, setStale] = useState(false);
  const [cost, setCost] = useState<RunCostSummary | null>(
    liveCost?.initial ?? null,
  );
  const [nowMs, setNowMs] = useState<number | null>(null);
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

  // Re-poll cost on the same SSE tick (separate debounce timer): cost.jsonl is
  // appended per usage event during the turn. A failed poll keeps the last good
  // snapshot (no stale badge — cost is advisory).
  const costTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!live || !liveCost || eventCount === 0) return;

    if (costTimerRef.current) clearTimeout(costTimerRef.current);
    costTimerRef.current = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(costSummaryRefreshUrl(rest.runId));

          if (!res.ok) return;
          setCost((await res.json()) as RunCostSummary);
        } catch {
          // keep last good cost
        }
      })();
    }, CHANGE_SUMMARY_REFRESH_DEBOUNCE_MS);

    return () => {
      if (costTimerRef.current) clearTimeout(costTimerRef.current);
    };
  }, [eventCount, live, liveCost, rest.runId]);

  // Tick elapsed wall-clock once a second while the run is live and unfinished.
  useEffect(() => {
    if (!live || !liveWallClock || liveWallClock.endedAtMs !== null) return;

    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);

    return () => clearInterval(id);
  }, [live, liveWallClock]);

  const liveFacts = useMemo<RunInspectorFact[]>(() => {
    const overrides = new Map<string, string>();

    if (liveCost && cost) {
      for (const fact of buildCostSummaryFacts(cost, liveCost.labels)) {
        overrides.set(fact.label, fact.value);
      }
    }
    if (liveWallClock && liveWallClock.endedAtMs === null && nowMs !== null) {
      overrides.set(
        liveWallClock.label,
        formatRunDuration(Math.max(0, nowMs - liveWallClock.startedAtMs)),
      );
    }

    if (overrides.size === 0) return facts;

    return facts.map((fact) =>
      overrides.has(fact.label)
        ? { ...fact, value: overrides.get(fact.label) as string }
        : fact,
    );
  }, [facts, liveCost, cost, liveWallClock, nowMs]);

  return (
    <RunInspector
      {...rest}
      changeSummary={changeSummary}
      facts={liveFacts}
      stale={stale}
    />
  );
}
