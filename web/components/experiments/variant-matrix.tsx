import type { ExperimentComparisonDTO } from "@/lib/experiments/comparison";
import type { ReactElement } from "react";

import Link from "next/link";

import {
  RunStatusStrip,
  type RunStatusLabels,
} from "@/components/experiments/run-status-strip";

export interface VariantMatrixLabels {
  variants: string;
  latestReplicate: string;
  queuePosition: string;
  duration: string;
  openRun: string;
  noRuns: string;
  crashedConcludable: string;
  provenanceLocalCut: string;
  provenanceUpstream: string;
  flowRevisionDelta: string;
  runStatus: RunStatusLabels;
}

function durationLabel(value: number | null): string {
  if (value === null) return "-";

  const seconds = Math.round(value / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;

  if (minutes === 0) return `${rest}s`;
  if (rest === 0) return `${minutes}m`;

  return `${minutes}m ${rest}s`;
}

export function VariantMatrix({
  comparison,
  labels,
}: {
  comparison: ExperimentComparisonDTO;
  labels: VariantMatrixLabels;
}): ReactElement {
  const hasCrashed = comparison.runs.some((run) => run.status === "Crashed");

  return (
    <section className="mt-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 text-base font-bold text-ink">{labels.variants}</h2>
        <span className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-mute">
          {comparison.flowRevisionDelta ? (
            <span className="rounded-full border border-amber-line bg-amber-soft px-2 py-px text-[10px] font-bold uppercase tracking-[0.06em] text-amber">
              {labels.flowRevisionDelta}
            </span>
          ) : null}
          {labels.latestReplicate}
        </span>
      </div>
      {hasCrashed && comparison.experiment.status === "comparable" ? (
        <div className="mb-3 rounded-[10px] border border-red-300 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {labels.crashedConcludable}
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {comparison.variants.map((variant) => {
          const runs = comparison.runs.filter(
            (run) => run.variantKey === variant.key,
          );

          return (
            <article
              key={variant.key}
              className="rounded-[12px] border border-line bg-paper p-4"
            >
              <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <h3 className="m-0 text-sm font-semibold text-ink">
                    {variant.label}
                  </h3>
                  <p className="m-0 mt-1 font-mono text-[11px] text-mute">
                    {variant.key}
                  </p>
                </div>
                <span className="flex flex-wrap items-center gap-1.5">
                  {variant.config.runnerId ? (
                    <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
                      {variant.config.runnerId}
                    </span>
                  ) : null}
                  {(() => {
                    // ADR-129: provenance badges — package name · version ·
                    // local-cut vs upstream chip (runnerId badge idiom).
                    const provenance = runs.find(
                      (run) => run.provenance !== null,
                    )?.provenance;

                    if (!provenance) return null;

                    return (
                      <>
                        <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[10px] tracking-[0.02em] text-mute">
                          {provenance.packageName} · {provenance.versionLabel}
                        </span>
                        <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
                          {provenance.kind === "local_cut"
                            ? labels.provenanceLocalCut
                            : labels.provenanceUpstream}
                        </span>
                      </>
                    );
                  })()}
                </span>
              </header>
              {runs.length === 0 ? (
                <p className="m-0 text-sm text-mute">{labels.noRuns}</p>
              ) : (
                <div className="grid grid-cols-1 gap-2">
                  {runs.map((run) => (
                    <div
                      key={run.runId}
                      className="rounded-[10px] border border-line-soft bg-ivory p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <RunStatusStrip labels={labels.runStatus} run={run} />
                        <Link
                          className="font-mono text-[11px] font-semibold text-amber hover:text-amber-2"
                          href={`/runs/${run.runId}`}
                        >
                          {labels.openRun}
                        </Link>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2 font-mono text-[11px] text-mute">
                        <span>#{run.replicateOrdinal}</span>
                        <span>
                          {labels.duration}: {durationLabel(run.durationMs)}
                        </span>
                        {run.queuePosition !== null ? (
                          <span>
                            {labels.queuePosition} #{run.queuePosition}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
