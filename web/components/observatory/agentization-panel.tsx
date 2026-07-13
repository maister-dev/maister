import type { ReactElement } from "react";
import type { AgentizationPanelProps } from "@/components/observatory/types";

import { AgentizationTrendChart } from "@/components/observatory/agentization-trend-chart";

function formatNumber(locale: string, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}

function formatRate(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

export function AgentizationPanel({
  data,
  labels,
  locale,
}: AgentizationPanelProps): ReactElement {
  const text = labels.agentization;

  return (
    <section
      className="rounded-[14px] border border-line bg-paper p-5"
      data-testid="observatory-agentization"
    >
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="m-0 text-lg font-semibold text-ink">{text.title}</h2>
          <p className="mt-1 max-w-[72ch] text-sm text-mute">{text.subtitle}</p>
        </div>
        {data.fetchedAt ? (
          <span className="rounded-full border border-line bg-ivory px-2 py-[2px] font-mono text-[10px] text-mute">
            {text.asOf} {data.fetchedAt.toLocaleString(locale)}
          </span>
        ) : null}
      </header>
      <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2">
        <RateTile
          label={text.lines}
          rate={data.lines.value}
          raw={`${formatNumber(locale, data.lines.numerator)} / ${formatNumber(locale, data.lines.denominator)}`}
        />
        <RateTile
          label={text.deliveryUnits}
          rate={data.deliveryUnits.value}
          raw={`${formatNumber(locale, data.deliveryUnits.numerator)} / ${formatNumber(locale, data.deliveryUnits.denominator)}`}
        />
      </div>
      {data.availability === "insufficient" ? (
        <p className="mt-3 text-xs text-mute">{text.insufficient}</p>
      ) : null}
      {data.volatile ? (
        <p className="mt-2 text-xs text-amber">{text.volatility}</p>
      ) : null}
      <div className="mt-4 grid gap-2 md:grid-cols-3">
        {data.buckets.map((bucket) => (
          <article
            key={bucket.kind}
            className="rounded-md border border-line-soft bg-ivory px-3 py-2"
          >
            <h3 className="m-0 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
              {text[bucket.kind]}
            </h3>
            <p className="mt-1 text-sm font-semibold text-ink">
              {formatNumber(locale, bucket.lines)} {text.lines.toLowerCase()}
            </p>
            <p className="mt-1 font-mono text-[10px] text-mute">
              +{formatNumber(locale, bucket.additions)} {text.additions} · -
              {formatNumber(locale, bucket.deletions)} {text.deletions}
            </p>
          </article>
        ))}
      </div>
      <div className="mt-4">
        <h3 className="m-0 text-sm font-semibold text-ink">{text.trend}</h3>
        <AgentizationTrendChart
          labels={text}
          locale={locale}
          trend={data.trend}
        />
      </div>
    </section>
  );
}

function RateTile({
  label,
  rate,
  raw,
}: {
  label: string;
  rate: number | null;
  raw: string;
}): ReactElement {
  return (
    <div className="bg-ivory px-3 py-3">
      <div className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
        {label}
      </div>
      <strong className="mt-1 block text-[28px] leading-none text-ink">
        {formatRate(rate)}
      </strong>
      <span className="mt-2 block font-mono text-[10px] text-mute">{raw}</span>
    </div>
  );
}
