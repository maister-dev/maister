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
