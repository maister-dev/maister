import type { RunCostSummary } from "@/lib/queries/run";

export interface CostSummaryFact {
  label: string;
  value: string;
}

export interface CostSummaryFactLabels {
  tokenTotal: string;
  inputTokens: string;
  outputTokens: string;
  cacheReadTokens: string;
  cacheCreationTokens: string;
  resumeTax: string;
  // ADR-165: tree-wide facts, appended ONLY when a tree summary is supplied.
  treeTokenTotal?: string;
  treeWallClock?: string;
}

export function formatTokenCount(locale: string, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function buildCostSummaryFacts(
  summary: RunCostSummary,
  labels: CostSummaryFactLabels,
  locale: string,
): CostSummaryFact[] {
  const baseFacts: CostSummaryFact[] = [
    {
      label: labels.tokenTotal,
      value: formatTokenCount(locale, summary.totalTokens),
    },
    {
      label: labels.inputTokens,
      value: formatTokenCount(locale, summary.inputTokens),
    },
    {
      label: labels.outputTokens,
      value: formatTokenCount(locale, summary.outputTokens),
    },
    {
      label: labels.cacheReadTokens,
      value: formatTokenCount(locale, summary.cacheReadTokens),
    },
    {
      label: labels.cacheCreationTokens,
      value: formatTokenCount(locale, summary.cacheCreationTokens),
    },
  ];

  if (summary.resumeTokens <= 0) return baseFacts;

  return [
    ...baseFacts,
    {
      label: labels.resumeTax,
      value: formatTokenCount(locale, summary.resumeTokens),
    },
  ];
}

/**
 * ADR-165 (T8.3): the tree-wide facts, appended after the per-run ones.
 *
 * Returns an EMPTY list when there is no tree summary — the caller concatenates
 * unconditionally, so "this run is not a tree root with children" renders as
 * nothing rather than as a zero.
 */
export function buildTreeCostFacts(
  tree: { totalTokens: number; wallClockMinutes: number } | null | undefined,
  labels: CostSummaryFactLabels,
  locale: string,
): CostSummaryFact[] {
  if (!tree || !labels.treeTokenTotal || !labels.treeWallClock) return [];

  return [
    {
      label: labels.treeTokenTotal,
      value: formatTokenCount(locale, tree.totalTokens),
    },
    {
      label: labels.treeWallClock,
      value: formatTokenCount(locale, Math.round(tree.wallClockMinutes)),
    },
  ];
}
