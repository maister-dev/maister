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
}

const tokenFormatter = new Intl.NumberFormat("en-US");

export function formatTokenCount(value: number): string {
  return tokenFormatter.format(value);
}

export function buildCostSummaryFacts(
  summary: RunCostSummary,
  labels: CostSummaryFactLabels,
): CostSummaryFact[] {
  const baseFacts: CostSummaryFact[] = [
    {
      label: labels.tokenTotal,
      value: formatTokenCount(summary.totalTokens),
    },
    {
      label: labels.inputTokens,
      value: formatTokenCount(summary.inputTokens),
    },
    {
      label: labels.outputTokens,
      value: formatTokenCount(summary.outputTokens),
    },
    {
      label: labels.cacheReadTokens,
      value: formatTokenCount(summary.cacheReadTokens),
    },
    {
      label: labels.cacheCreationTokens,
      value: formatTokenCount(summary.cacheCreationTokens),
    },
  ];

  if (summary.resumeTokens <= 0) return baseFacts;

  return [
    ...baseFacts,
    {
      label: labels.resumeTax,
      value: formatTokenCount(summary.resumeTokens),
    },
  ];
}
