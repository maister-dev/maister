import type { ReactElement } from "react";
import type {
  ArtifactListProps,
  ObservatoryDashboardProps,
} from "@/components/observatory/types";

import { AutonomyScoreCard } from "@/components/observatory/autonomy-score-card";
import { CorrectionHeatmap } from "@/components/observatory/correction-heatmap";
import { SignalClusterList } from "@/components/observatory/signal-cluster-list";

export function ObservatorySummary({
  data,
  labels,
  projectSlug,
}: ObservatoryDashboardProps): ReactElement {
  const correction = data.totals.correction;

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <section className="grid grid-cols-1 gap-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <MetricTile
            label={labels.correctionRate}
            sub={labels.correctionFormula}
            value={correction.correctionRate.toFixed(2)}
          />
          <MetricTile
            label={labels.rework}
            value={String(correction.reworkCount)}
          />
          <MetricTile
            label={labels.retries}
            value={String(correction.retryCount)}
          />
        </div>
        <CorrectionHeatmap
          labels={labels}
          nodes={data.nodes}
          projectSlug={projectSlug}
        />
      </section>
      <aside className="grid grid-cols-1 gap-4">
        <AutonomyScoreCard autonomy={data.totals.autonomy} labels={labels} />
        <SignalClusterList
          labels={labels}
          projectSlug={projectSlug}
          signals={data.topSignals}
        />
        <ArtifactList artifacts={data.artifacts} labels={labels} />
      </aside>
    </div>
  );
}

function MetricTile({
  label,
  sub,
  value,
}: {
  label: string;
  sub?: string;
  value: string;
}): ReactElement {
  return (
    <article className="rounded-lg border border-line bg-paper p-4">
      <dt className="font-mono text-[10px] uppercase tracking-[0.1em] text-mute">
        {label}
      </dt>
      <dd className="mt-2 text-[30px] font-semibold leading-none text-ink">
        {value}
      </dd>
      {sub ? <p className="mt-2 text-xs text-mute">{sub}</p> : null}
    </article>
  );
}

function ArtifactList({ artifacts, labels }: ArtifactListProps): ReactElement {
  return (
    <section className="rounded-lg border border-line bg-paper p-4">
      <h2 className="m-0 text-sm font-semibold text-ink">{labels.artifacts}</h2>
      {artifacts.length === 0 ? (
        <p className="mt-2 text-sm text-mute">{labels.noArtifacts}</p>
      ) : (
        <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
          {artifacts.map((artifact) => (
            <li
              key={artifact.artifactKey}
              className="flex items-center justify-between gap-3 rounded-md border border-line-soft bg-ivory px-3 py-2"
            >
              <span className="min-w-0 truncate text-sm font-medium text-ink">
                {artifact.artifactKey}
              </span>
              <span className="shrink-0 font-mono text-xs text-mute">
                {artifact.artifactCount} · {artifact.runCount} {labels.runs}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
