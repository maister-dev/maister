import type { AutonomyMetric } from "@/lib/queries/observatory-core";
import type { ReactElement } from "react";
import type { ObservatoryLabels } from "@/components/observatory/types";

import clsx from "clsx";

export function AutonomyScoreCard({
  autonomy,
  labels,
}: {
  autonomy: AutonomyMetric;
  labels: ObservatoryLabels;
}): ReactElement {
  const percent = Math.round(autonomy.autonomyScore * 100);
  const tone =
    percent >= 80 ? "bg-accent-4" : percent >= 55 ? "bg-amber" : "bg-danger";

  return (
    <article className="rounded-lg border border-line bg-paper p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="m-0 text-sm font-semibold text-ink">
            {labels.autonomyScore}
          </h2>
          <p className="mt-1 text-xs leading-5 text-mute">
            {labels.reviewDwellExcluded}
          </p>
        </div>
        {autonomy.volatile ? (
          <span className="rounded-full border border-amber-line bg-amber-soft px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-amber">
            {labels.volatile}
          </span>
        ) : null}
      </div>
      <div className="mb-3 flex items-end gap-2">
        <strong className="text-[34px] font-semibold leading-none text-ink">
          {percent}%
        </strong>
        <span className="pb-1 font-mono text-xs text-mute">
          {formatSeconds(autonomy.waitSeconds)} /{" "}
          {formatSeconds(autonomy.totalSeconds)}
        </span>
      </div>
      <div
        aria-label={labels.autonomyScore}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percent}
        className="h-2 overflow-hidden rounded-full bg-line-soft"
        role="meter"
      >
        <div
          className={clsx("h-full rounded-full", tone)}
          style={{ width: `${percent}%` }}
        />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <Metric
          label={labels.waitTime}
          value={formatSeconds(autonomy.waitSeconds)}
        />
        <Metric
          label={labels.openWaits}
          value={String(autonomy.openWaitCount)}
        />
      </dl>
    </article>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactElement {
  return (
    <div className="rounded-md border border-line-soft bg-ivory px-3 py-2">
      <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
        {label}
      </dt>
      <dd className="mt-1 text-sm font-semibold text-ink">{value}</dd>
    </div>
  );
}

function formatSeconds(value: number): string {
  if (value < 60) return `${value}s`;

  const minutes = Math.round(value / 60);

  if (minutes < 60) return `${minutes}m`;

  return `${Math.round(minutes / 60)}h`;
}
