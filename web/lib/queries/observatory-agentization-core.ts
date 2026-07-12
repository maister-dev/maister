import type { DeliveryDiffStat, RepoDeliveryRef } from "@/lib/db/schema";
import type {
  DeliveryRunKind,
  ObservatoryRunKind,
} from "@/lib/observatory/run-kind";

import { MIN_GROUP_EXECUTIONS } from "@/lib/queries/observatory-core";

export interface ObservatoryAgentizationRun {
  id: string;
  runKind: DeliveryRunKind;
  promotedHeadSha: string | null;
  mergeCommitSha: string | null;
  diffStat: DeliveryDiffStat | null;
  prNumber: number | null;
  active: boolean;
}

export interface ObservatoryDeliveryBucket {
  bucketStart: Date;
  bucketEnd: Date;
  commits: number;
  mergePrUnits: number;
  additions: number;
  deletions: number;
  deliveryRefs: readonly RepoDeliveryRef[];
  providerComplete: boolean;
  fetchedAt: Date;
}

export interface AgentizationKindBucket {
  kind: DeliveryRunKind;
  runs: number;
  deliveryUnits: number;
  additions: number;
  deletions: number;
  lines: number;
}

export interface AgentizationRate {
  numerator: number;
  denominator: number;
  sampleSize: number;
  value: number | null;
}

export interface AgentizationTrendPoint {
  bucketStart: Date;
  additions: number;
  deletions: number;
  aiAdditions: number;
  aiDeletions: number;
  value: number | null;
}

export interface AgentizationSummary {
  lines: AgentizationRate;
  deliveryUnits: AgentizationRate;
  buckets: AgentizationKindBucket[];
  trend: AgentizationTrendPoint[];
  fetchedAt: Date | null;
  volatile: boolean;
  availability: "ready" | "insufficient";
}

export interface ObservatoryFunnelRun {
  id: string;
  runKind: DeliveryRunKind;
  startedAt: Date;
  status: string;
  launchMode: "auto" | "manual" | null;
  triggerSource: string | null;
  promotionLane: "auto" | "manual" | null;
  platformPromoted: boolean;
  hasHitl: boolean;
  hasHumanReview: boolean;
  hasHumanTakeover: boolean;
}

export interface ObservatoryFunnel {
  runKinds: Array<{ key: DeliveryRunKind; count: number }>;
  launchModes: Array<{ key: "auto" | "manual" | "unrecorded"; count: number }>;
  triggerSources: Array<{ key: string; count: number }>;
  humanTouch: Array<{
    key: "pure_autonomous" | "ai_with_correction" | "human_takeover";
    count: number;
  }>;
  throughput: Array<{
    key: "platform_promoted" | "failed" | "crashed" | "abandoned";
    count: number;
  }>;
  promotionLanes: Array<{ key: "auto" | "manual"; count: number }>;
  volatile: boolean;
}

type MatchedRun = {
  run: ObservatoryAgentizationRun;
  bucket: ObservatoryDeliveryBucket;
  ref: RepoDeliveryRef;
};

type DeliveryRefMatch = Omit<MatchedRun, "run">;

type MatchResolution = {
  canonical: MatchedRun[];
  trend: MatchedRun[];
  complete: boolean;
};

export function rollupAgentization(input: {
  runKind: ObservatoryRunKind;
  runs: readonly ObservatoryAgentizationRun[];
  buckets: readonly ObservatoryDeliveryBucket[];
}): AgentizationSummary {
  const selectedRuns = input.runs.filter((run) =>
    input.runKind === "all" ? true : run.runKind === input.runKind,
  );
  const resolution = matchRunsToDeliveryRefs(selectedRuns, input.buckets);
  const matches = resolution.canonical;
  const totals = input.buckets.reduce(
    (acc, bucket) => ({
      commits: acc.commits + bucket.commits,
      mergePrUnits: acc.mergePrUnits + bucket.mergePrUnits,
      additions: acc.additions + bucket.additions,
      deletions: acc.deletions + bucket.deletions,
      providerComplete: acc.providerComplete && bucket.providerComplete,
    }),
    {
      commits: 0,
      mergePrUnits: 0,
      additions: 0,
      deletions: 0,
      providerComplete: true,
    },
  );
  const aiStats = sumRunStats(matches.map((match) => match.run));
  const linesDenominator = totals.additions + totals.deletions;
  const deliveryUnits = deliveryUnitCount(matches);
  const lineRate = resolution.complete
    ? rate(aiStats.lines, linesDenominator, totals.commits)
    : unavailableRate(aiStats.lines, linesDenominator);
  const deliveryRate =
    totals.providerComplete && resolution.complete
      ? rate(deliveryUnits, totals.mergePrUnits, totals.mergePrUnits)
      : unavailableRate(deliveryUnits, totals.mergePrUnits);
  const fetchedAt = latestFetchedAt(input.buckets);

  return {
    lines: lineRate,
    deliveryUnits: deliveryRate,
    buckets: selectedKinds(input.runKind).map((kind) =>
      bucketForKind(kind, matches),
    ),
    trend: input.buckets.map((bucket) => trendPoint(bucket, resolution.trend)),
    fetchedAt,
    volatile: selectedRuns.some((run) => run.active),
    availability:
      fetchedAt === null || lineRate.value === null || !resolution.complete
        ? "insufficient"
        : "ready",
  };
}

export function rollupObservatoryFunnel(input: {
  runKind: ObservatoryRunKind;
  runs: readonly ObservatoryFunnelRun[];
  since?: Date;
}): ObservatoryFunnel {
  const runs = input.runs.filter(
    (run) =>
      (input.runKind === "all" || run.runKind === input.runKind) &&
      (input.since === undefined || run.startedAt >= input.since),
  );

  return {
    runKinds: selectedKinds(input.runKind).map((kind) => ({
      key: kind,
      count: count(runs, (run) => run.runKind === kind),
    })),
    launchModes: ["auto", "manual", "unrecorded"].map((key) => ({
      key: key as "auto" | "manual" | "unrecorded",
      count: count(runs, (run) => (run.launchMode ?? "unrecorded") === key),
    })),
    triggerSources: groupedStrings(
      runs.map((run) => run.triggerSource ?? "unrecorded"),
    ),
    humanTouch: ["pure_autonomous", "ai_with_correction", "human_takeover"].map(
      (key) => ({
        key: key as "pure_autonomous" | "ai_with_correction" | "human_takeover",
        count: count(runs, (run) => humanTouchKind(run) === key),
      }),
    ),
    throughput: ["platform_promoted", "failed", "crashed", "abandoned"].map(
      (key) => ({
        key: key as "platform_promoted" | "failed" | "crashed" | "abandoned",
        count: count(runs, (run) => throughputKind(run) === key),
      }),
    ),
    promotionLanes: ["auto", "manual"].map((key) => ({
      key: key as "auto" | "manual",
      count: count(runs, (run) => run.promotionLane === key),
    })),
    volatile: runs.some((run) => !isTerminalStatus(run.status)),
  };
}

const DELIVERY_RUN_KINDS: readonly DeliveryRunKind[] = [
  "flow",
  "scratch",
  "agent",
];

function matchRunsToDeliveryRefs(
  runs: readonly ObservatoryAgentizationRun[],
  buckets: readonly ObservatoryDeliveryBucket[],
): MatchResolution {
  const refs = buckets.flatMap((bucket) =>
    bucket.deliveryRefs.map((ref) => ({ bucket, ref })),
  );
  const canonicalCandidates: MatchedRun[] = [];
  let complete = true;

  for (const run of runs) {
    if (!run.diffStat) continue;

    const resolved = canonicalMatchForRun(run, refs);

    if (resolved === "ambiguous") {
      complete = false;
      continue;
    }
    if (resolved === null) continue;

    canonicalCandidates.push(resolved);
  }

  const { canonical, ambiguousRunIds } =
    uniqueCanonicalMatches(canonicalCandidates);

  complete = complete && ambiguousRunIds.size === 0;
  const trend = canonical.flatMap((match) =>
    trendMatchesForRun(match.run, match, refs),
  );

  return { canonical, trend, complete };
}

function uniqueCanonicalMatches(matches: readonly MatchedRun[]): {
  canonical: MatchedRun[];
  ambiguousRunIds: ReadonlySet<string>;
} {
  const matchByRunId = new Map<string, MatchedRun>();
  const runIdsBySha = new Map<string, Set<string>>();
  const ambiguousRunIds = new Set<string>();

  for (const match of matches) {
    const existing = matchByRunId.get(match.run.id);

    if (existing && existing.ref.sha !== match.ref.sha) {
      ambiguousRunIds.add(match.run.id);
      continue;
    }
    if (existing) continue;

    matchByRunId.set(match.run.id, match);
    const runIds = runIdsBySha.get(match.ref.sha) ?? new Set<string>();

    runIds.add(match.run.id);
    runIdsBySha.set(match.ref.sha, runIds);
  }

  for (const runIds of runIdsBySha.values()) {
    if (runIds.size < 2) continue;

    for (const runId of runIds) ambiguousRunIds.add(runId);
  }

  return {
    canonical: [...matchByRunId.values()].filter(
      (match) => !ambiguousRunIds.has(match.run.id),
    ),
    ambiguousRunIds,
  };
}

function canonicalMatchForRun(
  run: ObservatoryAgentizationRun,
  refs: readonly DeliveryRefMatch[],
): MatchedRun | "ambiguous" | null {
  const exact = uniqueMatchesBySha(
    refs.filter(
      (entry) =>
        entry.ref.sha === run.mergeCommitSha ||
        entry.ref.sha === run.promotedHeadSha,
    ),
  );

  if (exact.length > 0) return singleMatch(run, exact);

  const pullRequest = uniqueMatchesBySha(
    refs.filter(
      (entry) => run.prNumber !== null && entry.ref.prNumber === run.prNumber,
    ),
  );

  if (pullRequest.length > 0) return singleMatch(run, pullRequest);

  const trailer = uniqueMatchesBySha(
    refs.filter((entry) => entry.ref.runIds.includes(run.id)),
  );

  return trailer.length === 0 ? null : singleMatch(run, trailer);
}

function singleMatch(
  run: ObservatoryAgentizationRun,
  matches: readonly DeliveryRefMatch[],
): MatchedRun | "ambiguous" {
  return matches.length === 1 ? { run, ...matches[0]! } : "ambiguous";
}

function uniqueMatchesBySha(
  matches: readonly DeliveryRefMatch[],
): DeliveryRefMatch[] {
  return [...new Map(matches.map((match) => [match.ref.sha, match])).values()];
}

function trendMatchesForRun(
  run: ObservatoryAgentizationRun,
  canonical: MatchedRun,
  refs: readonly DeliveryRefMatch[],
): MatchedRun[] {
  const trailered = uniqueMatchesBySha(
    refs.filter((entry) => entry.ref.runIds.includes(run.id)),
  );

  return trailered.length > 0
    ? trailered.map((entry) => ({ run, ...entry }))
    : [canonical];
}

function bucketForKind(
  kind: DeliveryRunKind,
  matches: readonly MatchedRun[],
): AgentizationKindBucket {
  const kindMatches = matches.filter((match) => match.run.runKind === kind);
  const stat = sumRunStats(kindMatches.map((match) => match.run));

  return {
    kind,
    runs: kindMatches.length,
    deliveryUnits: deliveryUnitCount(kindMatches),
    ...stat,
  };
}

function selectedKinds(
  runKind: ObservatoryRunKind,
): readonly DeliveryRunKind[] {
  return runKind === "all" ? DELIVERY_RUN_KINDS : [runKind];
}

function trendPoint(
  bucket: ObservatoryDeliveryBucket,
  matches: readonly MatchedRun[],
): AgentizationTrendPoint {
  const bucketMatches = matches.filter(
    (match) =>
      match.bucket.bucketStart.getTime() === bucket.bucketStart.getTime(),
  );
  const stats = sumRefStats(bucketMatches);
  const denominator = bucket.additions + bucket.deletions;
  const complete = bucketMatches.every(
    (match) => match.ref.diffStat !== undefined,
  );

  return {
    bucketStart: bucket.bucketStart,
    additions: bucket.additions,
    deletions: bucket.deletions,
    aiAdditions: stats.additions,
    aiDeletions: stats.deletions,
    value:
      complete && bucket.commits >= MIN_GROUP_EXECUTIONS && denominator > 0
        ? stats.lines / denominator
        : null,
  };
}

function sumRunStats(
  runs: readonly ObservatoryAgentizationRun[],
): Pick<AgentizationKindBucket, "additions" | "deletions" | "lines"> {
  const stats = runs.reduce(
    (acc, run) => ({
      additions: acc.additions + (run.diffStat?.additions ?? 0),
      deletions: acc.deletions + (run.diffStat?.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  );

  return { ...stats, lines: stats.additions + stats.deletions };
}

function sumRefStats(
  matches: readonly MatchedRun[],
): Pick<AgentizationKindBucket, "additions" | "deletions" | "lines"> {
  const stats = matches.reduce(
    (acc, match) => ({
      additions: acc.additions + (match.ref.diffStat?.additions ?? 0),
      deletions: acc.deletions + (match.ref.diffStat?.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  );

  return { ...stats, lines: stats.additions + stats.deletions };
}

function deliveryUnitCount(matches: readonly MatchedRun[]): number {
  return new Set(
    matches
      .filter(
        (match) =>
          match.ref.parentCount > 1 || match.ref.prNumber !== undefined,
      )
      .map((match) => match.ref.sha),
  ).size;
}

function rate(
  numerator: number,
  denominator: number,
  sampleSize: number,
): AgentizationRate {
  return {
    numerator,
    denominator,
    sampleSize,
    value:
      denominator > 0 && sampleSize >= MIN_GROUP_EXECUTIONS
        ? numerator / denominator
        : null,
  };
}

function unavailableRate(
  numerator: number,
  denominator: number,
): AgentizationRate {
  return { numerator, denominator, sampleSize: denominator, value: null };
}

function latestFetchedAt(
  buckets: readonly ObservatoryDeliveryBucket[],
): Date | null {
  return buckets.reduce<Date | null>(
    (latest, bucket) =>
      latest === null || bucket.fetchedAt > latest ? bucket.fetchedAt : latest,
    null,
  );
}

function humanTouchKind(
  run: ObservatoryFunnelRun,
): "pure_autonomous" | "ai_with_correction" | "human_takeover" {
  if (run.hasHumanTakeover) return "human_takeover";
  if (run.hasHitl || run.hasHumanReview) return "ai_with_correction";

  return "pure_autonomous";
}

function throughputKind(
  run: ObservatoryFunnelRun,
): "platform_promoted" | "failed" | "crashed" | "abandoned" | null {
  if (run.platformPromoted) return "platform_promoted";
  if (run.status === "Failed") return "failed";
  if (run.status === "Crashed") return "crashed";
  if (run.status === "Abandoned") return "abandoned";

  return null;
}

function isTerminalStatus(status: string): boolean {
  return (
    status === "Done" ||
    status === "Failed" ||
    status === "Crashed" ||
    status === "Abandoned"
  );
}

function groupedStrings(
  values: readonly string[],
): Array<{ key: string; count: number }> {
  return [...new Set(values)]
    .sort((left, right) => left.localeCompare(right))
    .map((key) => ({ key, count: count(values, (value) => value === key) }));
}

function count<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): number {
  return values.filter(predicate).length;
}
