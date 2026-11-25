"use client";

import type {
  RunInspectorChangeSummary,
  RunInspectorFact,
  RunInspectorProps,
} from "@/components/runs/run-inspector";
import type { RunCostSummary } from "@/lib/queries/run";
import type { CostSummaryFactLabels } from "@/lib/runs/cost-summary-facts";
import type { ReactElement } from "react";

import { useEffect, useMemo, useState } from "react";

import { RunInspector } from "@/components/runs/run-inspector";
import { useRunPageStream } from "@/components/runs/run-stream-provider";
import { ContextUsageMeter } from "@/components/runs/context-usage-meter";
import { buildCostSummaryFacts } from "@/lib/runs/cost-summary-facts";
import {
  CHANGE_SUMMARY_REFRESH_COALESCE_MS,
  changeSummaryRefreshUrl,
  costSummaryRefreshUrl,
  formatRunDuration,
  isLiveRunStatus,
} from "@/lib/runs/live-inspector";
import { useCoalescedRefresh } from "@/lib/runs/use-coalesced-refresh";

// Live token-cost poll config: the cost facts (token totals) carried in `facts`
// are replaced by label as canonical usage events arrive during the run.
export interface LiveCostConfig {
  initial: RunCostSummary;
  labels: CostSummaryFactLabels;
  locale: string;
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
// re-fetched on each SSE tick (canonical usage grows mid-turn), and elapsed time
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
  const summaryKey = `${rest.runId}:${changeScope}`;
  const [liveSummaryOverride, setLiveSummaryOverride] = useState<{
    key: string;
    value: RunInspectorChangeSummary;
  } | null>(null);
  const [staleKey, setStaleKey] = useState<string | null>(null);
  const [liveCostOverride, setLiveCostOverride] = useState<{
    runId: string;
    value: RunCostSummary;
  } | null>(null);
  const [nowMs, setNowMs] = useState<number | null>(null);
  const { eventCount, context } = useRunPageStream(rest.runId, live);

  const changeSummary =
    live && liveSummaryOverride?.key === summaryKey
      ? liveSummaryOverride.value
      : initialChangeSummary;
  const stale = live && staleKey === summaryKey;
  const cost =
    live && liveCostOverride?.runId === rest.runId
      ? liveCostOverride.value
      : (liveCost?.initial ?? null);

  const triggerChangeSummaryRefresh = useCoalescedRefresh(
    async (signal) => {
      try {
        const res = await fetch(
          changeSummaryRefreshUrl(rest.runId, changeScope),
          { signal },
        );

        if (signal.aborted) return;
        if (!res.ok) {
          setStaleKey(summaryKey);

          return;
        }
        const nextSummary = (await res.json()) as RunInspectorChangeSummary;

        if (signal.aborted) return;
        setLiveSummaryOverride({ key: summaryKey, value: nextSummary });
        setStaleKey(null);
      } catch {
        if (signal.aborted) return;
        setStaleKey(summaryKey);
      }
    },
    CHANGE_SUMMARY_REFRESH_COALESCE_MS,
    live ? summaryKey : null,
  );

  useEffect(() => {
    if (!live || eventCount === 0) return;

    triggerChangeSummaryRefresh();
  }, [eventCount, live, triggerChangeSummaryRefresh]);

  // Re-poll cost on the same SSE tick (separate coalesced refresher): canonical
  // usage is appended per event during the turn. A failed poll keeps the last
  // good snapshot (no stale badge — cost is advisory).
  const hasLiveCost = Boolean(liveCost);
  const triggerCostRefresh = useCoalescedRefresh(
    async (signal) => {
      try {
        const res = await fetch(costSummaryRefreshUrl(rest.runId), {
          signal,
        });

        if (signal.aborted || !res.ok) return;
        const nextCost = (await res.json()) as RunCostSummary;

        if (signal.aborted) return;
        setLiveCostOverride({ runId: rest.runId, value: nextCost });
      } catch {
        // keep last good cost
      }
    },
    CHANGE_SUMMARY_REFRESH_COALESCE_MS,
    live && hasLiveCost ? rest.runId : null,
  );

  useEffect(() => {
    if (!live || !hasLiveCost || eventCount === 0) return;

    triggerCostRefresh();
  }, [eventCount, live, hasLiveCost, triggerCostRefresh]);

  const wallClockStartedAtMs = liveWallClock?.startedAtMs;
  const wallClockEndedAtMs = liveWallClock?.endedAtMs;

  // Tick elapsed wall-clock once a second while the run is live and unfinished.
  useEffect(() => {
    if (
      !live ||
      wallClockStartedAtMs === undefined ||
      wallClockEndedAtMs !== null
    )
      return;

    const tick = (): void => setNowMs(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 1000);

    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [live, wallClockStartedAtMs, wallClockEndedAtMs]);

  const liveFacts = useMemo<RunInspectorFact[]>(() => {
    const overrides = new Map<string, string>();

    if (liveCost && cost) {
      for (const fact of buildCostSummaryFacts(
        cost,
        liveCost.labels,
        liveCost.locale,
      )) {
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
    <>
      {live ? <ContextUsageMeter snapshot={context ?? null} /> : null}
      <RunInspector
        {...rest}
        changeSummary={changeSummary}
        facts={liveFacts}
        stale={stale}
      />
    </>
  );
}
