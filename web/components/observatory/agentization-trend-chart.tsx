import type { ReactElement } from "react";
import type { ObservatoryAgentizationLabels } from "@/components/observatory/types";
import type { AgentizationTrendPoint } from "@/lib/queries/observatory-agentization-core";

const CHART = {
  width: 720,
  height: 176,
  left: 28,
  right: 8,
  top: 12,
  bottom: 28,
} as const;

const GRID_RATES = [0, 0.5, 1] as const;

type AgentizationTrendChartProps = {
  trend: readonly AgentizationTrendPoint[];
  labels: ObservatoryAgentizationLabels;
  locale: string;
};

export function AgentizationTrendChart({
  trend,
  labels,
  locale,
}: AgentizationTrendChartProps): ReactElement {
  const hasObservedRate = trend.some((point) => point.value !== null);

  if (!hasObservedRate) {
    return (
      <p className="mt-2 rounded-md border border-line-soft bg-ivory px-3 py-2 text-xs text-mute">
        {labels.trendNoData}
      </p>
    );
  }

  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const step = plotWidth / trend.length;
  const barWidth = Math.max(3, Math.min(28, step - 6));

  return (
    <figure className="mt-2">
      <svg
        aria-label={labels.trendValue}
        className="h-44 w-full"
        role="img"
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
      >
        <title>{labels.trendValue}</title>
        {GRID_RATES.map((rate) => {
          const y = valueToY(rate, plotHeight);

          return (
            <g key={rate}>
              <line
                stroke="var(--line-soft)"
                x1={CHART.left}
                x2={CHART.width - CHART.right}
                y1={y}
                y2={y}
              />
              <text
                fill="var(--mute)"
                fontFamily="var(--mono)"
                fontSize="8"
                textAnchor="end"
                x={CHART.left - 5}
                y={y + 3}
              >
                {Math.round(rate * 100)}%
              </text>
            </g>
          );
        })}
        {trend.map((point, index) => {
          const x = CHART.left + index * step + (step - barWidth) / 2;
          const rate = point.value ?? 0;
          const y = valueToY(rate, plotHeight);

          return (
            <g key={point.bucketStart.toISOString()}>
              <title>{describePoint(point, labels, locale)}</title>
              {point.value === null ? (
                <line
                  stroke="var(--mute-2)"
                  strokeDasharray="2 2"
                  strokeWidth="2"
                  x1={x + barWidth / 2}
                  x2={x + barWidth / 2}
                  y1={CHART.top + plotHeight - 4}
                  y2={CHART.top + plotHeight}
                />
              ) : rate === 0 ? (
                <line
                  stroke="var(--amber)"
                  strokeWidth="2"
                  x1={x}
                  x2={x + barWidth}
                  y1={CHART.top + plotHeight - 1}
                  y2={CHART.top + plotHeight - 1}
                />
              ) : (
                <rect
                  fill="var(--amber)"
                  height={CHART.top + plotHeight - y}
                  rx={Math.min(3, barWidth / 2)}
                  width={barWidth}
                  x={x}
                  y={y}
                />
              )}
              {shouldShowDateLabel(index, trend.length) ? (
                <text
                  fill="var(--mute)"
                  fontFamily="var(--mono)"
                  fontSize="8"
                  textAnchor="middle"
                  x={x + barWidth / 2}
                  y={CHART.height - 8}
                >
                  {point.bucketStart.toLocaleDateString(locale, {
                    day: "numeric",
                    month: "short",
                  })}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-mute">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-2 rounded-sm bg-amber" />
          {labels.trendValue}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="w-3 border-t border-dashed border-mute-2"
          />
          {labels.trendNoData}
        </span>
      </figcaption>
    </figure>
  );
}

function valueToY(rate: number, plotHeight: number): number {
  return CHART.top + plotHeight - rate * plotHeight;
}

function shouldShowDateLabel(index: number, length: number): boolean {
  if (length <= 4) return true;

  return (
    index === 0 || index === length - 1 || index === Math.floor(length / 2)
  );
}

function describePoint(
  point: AgentizationTrendPoint,
  labels: ObservatoryAgentizationLabels,
  locale: string,
): string {
  const totalLines = point.additions + point.deletions;
  const aiLines = point.aiAdditions + point.aiDeletions;
  const date = point.bucketStart.toLocaleDateString(locale, {
    day: "numeric",
    month: "long",
  });

  return `${date}: ${labels.trendValue} ${formatRate(point.value)}; ${labels.trendAiLines} ${formatNumber(locale, aiLines)}; ${labels.trendAllLines} ${formatNumber(locale, totalLines)}`;
}

function formatRate(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function formatNumber(locale: string, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}
