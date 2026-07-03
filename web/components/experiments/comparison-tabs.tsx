import type {
  ExperimentComparisonDTO,
  ExperimentComparisonRunDTO,
} from "@/lib/experiments/comparison";
import type { ReactElement, ReactNode } from "react";

import { computeDiffOfDiffs } from "@/lib/experiments/diff-of-diffs";
import { buildFilesMatrix } from "@/lib/experiments/files-matrix";

export interface ComparisonTabLabels {
  pair: string;
  snapshot: string;
  refsGone: string;
  truncated: string;
  missingSnapshot: string;
  identical: string;
  partial: string;
  filesAll: string;
  filesDifferent: string;
  filesSame: string;
  contentUnavailable: string;
  noGates: string;
  confidence: string;
  noCost: string;
  tokensCaption: string;
  duration: string;
  inputTokens: string;
  outputTokens: string;
  cacheReadTokens: string;
  cacheCreationTokens: string;
  resumeTokens: string;
  byModel: string;
  byRunner: string;
}

function latestRuns(comparison: ExperimentComparisonDTO): ExperimentComparisonRunDTO[] {
  return comparison.variants
    .map((variant) =>
      comparison.runs
        .filter((run) => run.variantKey === variant.key)
        .sort((left, right) => right.replicateOrdinal - left.replicateOrdinal)[0],
    )
    .filter((run): run is ExperimentComparisonRunDTO => run !== undefined);
}

function variantLabel(
  comparison: ExperimentComparisonDTO,
  variantKey: string,
): string {
  return (
    comparison.variants.find((variant) => variant.key === variantKey)?.label ??
    variantKey
  );
}

function pairs(runs: ExperimentComparisonRunDTO[]): Array<[
  ExperimentComparisonRunDTO,
  ExperimentComparisonRunDTO,
]> {
  const result: Array<[ExperimentComparisonRunDTO, ExperimentComparisonRunDTO]> =
    [];

  for (let left = 0; left < runs.length; left += 1) {
    for (let right = left + 1; right < runs.length; right += 1) {
      result.push([runs[left], runs[right]]);
    }
  }

  return result;
}

function durationLabel(value: number | null): string {
  if (value === null) return "-";

  const seconds = Math.round(value / 1000);
  const minutes = Math.floor(seconds / 60);

  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds % 60}s`;
}

function Section({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="rounded-[12px] border border-line bg-paper p-4">
      <h3 className="m-0 mb-3 font-mono text-[10.5px] font-bold uppercase tracking-[0.1em] text-mute">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function DiffTab({
  comparison,
  labels,
}: {
  comparison: ExperimentComparisonDTO;
  labels: ComparisonTabLabels;
}): ReactElement {
  const runs = latestRuns(comparison);
  const runPairs = pairs(runs);

  return (
    <div className="grid grid-cols-1 gap-4">
      {runPairs.length > 1 ? (
        <Section title={labels.pair}>
          <div className="flex flex-wrap gap-2">
            {runPairs.map(([left, right]) => (
              <span
                key={`${left.runId}:${right.runId}`}
                className="rounded-full border border-line bg-ivory px-2 py-1 font-mono text-[11px] text-ink"
              >
                {variantLabel(comparison, left.variantKey)} ↔{" "}
                {variantLabel(comparison, right.variantKey)}
              </span>
            ))}
          </div>
        </Section>
      ) : null}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {runs.map((run) => (
          <Section
            key={run.runId}
            title={`${variantLabel(comparison, run.variantKey)} #${run.replicateOrdinal}`}
          >
            <div className="mb-2 flex flex-wrap gap-2">
              <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
                {labels.snapshot}
              </span>
              {run.diff.snapshot ? (
                <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
                  {labels.refsGone}
                </span>
              ) : null}
              {run.diff.truncated ? (
                <span className="rounded-full border border-amber-line bg-amber-soft px-2 py-px font-mono text-[10px] uppercase tracking-[0.08em] text-amber">
                  {labels.truncated}
                </span>
              ) : null}
            </div>
            {run.diff.snapshot ? (
              <pre className="max-h-[360px] overflow-auto rounded-[10px] border border-line bg-ivory p-3 font-mono text-[11px] leading-5 text-ink">
                {run.diff.snapshot}
              </pre>
            ) : (
              <p className="m-0 text-sm text-mute">{labels.missingSnapshot}</p>
            )}
          </Section>
        ))}
      </div>
    </div>
  );
}

export function DiffOfDiffsTab({
  comparison,
  labels,
}: {
  comparison: ExperimentComparisonDTO;
  labels: ComparisonTabLabels;
}): ReactElement {
  const [left, right] = latestRuns(comparison);

  if (!left || !right || !left.diff.snapshot || !right.diff.snapshot) {
    return (
      <Section title={labels.pair}>
        <p className="m-0 text-sm text-mute">{labels.missingSnapshot}</p>
      </Section>
    );
  }

  const result = computeDiffOfDiffs(
    { text: left.diff.snapshot, truncated: left.diff.truncated },
    { text: right.diff.snapshot, truncated: right.diff.truncated },
  );
  const comparedPaths = [
    ...new Set([...left.files, ...right.files].map((file) => file.path)),
  ];

  return (
    <Section
      title={`${variantLabel(comparison, left.variantKey)} ↔ ${variantLabel(
        comparison,
        right.variantKey,
      )}`}
    >
      {result.partial ? (
        <p className="m-0 mb-2 text-sm text-amber">{labels.partial}</p>
      ) : null}
      {comparedPaths.length > 0 ? (
        <p className="m-0 mb-2 font-mono text-[11px] text-mute">
          {comparedPaths.join(", ")}
        </p>
      ) : null}
      {result.identical ? (
        <p className="m-0 text-sm text-mute">{labels.identical}</p>
      ) : (
        <pre className="max-h-[360px] overflow-auto rounded-[10px] border border-line bg-ivory p-3 font-mono text-[11px] leading-5 text-ink">
          {result.lines
            .map((line) => `${line.kind === "added" ? "+" : "-"} ${line.line}`)
            .join("\n")}
        </pre>
      )}
    </Section>
  );
}

export function FilesTab({
  comparison,
  labels,
}: {
  comparison: ExperimentComparisonDTO;
  labels: ComparisonTabLabels;
}): ReactElement {
  const runs = latestRuns(comparison);
  const matrix = buildFilesMatrix(
    runs.map((run) => ({
      variantKey: run.variantKey,
      replicateOrdinal: run.replicateOrdinal,
      files: run.files,
    })),
  );

  return (
    <Section title={labels.filesAll}>
      <div className="mb-3 flex flex-wrap gap-2">
        <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[10px] text-mute">
          {labels.filesAll}: {matrix.filters.all.length}
        </span>
        <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[10px] text-mute">
          {labels.filesDifferent}: {matrix.filters.different.length}
        </span>
        <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[10px] text-mute">
          {labels.filesSame}: {matrix.filters.same.length}
        </span>
      </div>
      <div className="overflow-hidden rounded-[10px] border border-line">
        {matrix.rows.map((row) => (
          <div
            key={row.path}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-line px-3 py-2 last:border-0"
          >
            <div className="min-w-0">
              <p className="m-0 truncate font-mono text-[12px] text-ink">
                {row.path}
              </p>
              <p className="m-0 mt-1 font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
                {row.touchedBy.join(", ")}
              </p>
            </div>
            <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
              {row.classification === "different"
                ? labels.filesDifferent
                : row.classification === "same"
                  ? labels.filesSame
                  : labels.contentUnavailable}
            </span>
          </div>
        ))}
      </div>
      {runs.some((run) => run.diff.snapshot === null) ? (
        <p className="m-0 mt-3 text-sm text-mute">{labels.contentUnavailable}</p>
      ) : null}
    </Section>
  );
}

export function GatesTab({
  comparison,
  labels,
}: {
  comparison: ExperimentComparisonDTO;
  labels: ComparisonTabLabels;
}): ReactElement {
  const runs = latestRuns(comparison);

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {runs.map((run) => (
        <Section
          key={run.runId}
          title={variantLabel(comparison, run.variantKey)}
        >
          {run.gates.length === 0 ? (
            <p className="m-0 text-sm text-mute">{labels.noGates}</p>
          ) : (
            <div className="grid grid-cols-1 gap-2">
              {run.gates.map((gate) => {
                const verdict = gate.verdict as
                  | { verdict?: string; confidence?: number }
                  | null;

                return (
                  <div
                    key={`${gate.gateId}:${gate.mode}`}
                    className="rounded-[10px] border border-line bg-ivory px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-[12px] text-ink">
                        {gate.kind}
                      </span>
                      <span className="font-mono text-[11px] text-mute">
                        {gate.status}
                      </span>
                    </div>
                    {verdict?.confidence !== undefined ? (
                      <p className="m-0 mt-1 font-mono text-[11px] text-mute">
                        {labels.confidence}: {verdict.confidence}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </Section>
      ))}
    </div>
  );
}

export function CostTab({
  comparison,
  labels,
}: {
  comparison: ExperimentComparisonDTO;
  labels: ComparisonTabLabels;
}): ReactElement {
  const runs = latestRuns(comparison);

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {runs.map((run) => (
        <Section
          key={run.runId}
          title={variantLabel(comparison, run.variantKey)}
        >
          <p className="m-0 mb-3 text-[12px] text-mute">
            {labels.tokensCaption}
          </p>
          {run.cost.hasData ? (
            <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
              <Metric label={labels.inputTokens} value={run.cost.inputTokens} />
              <Metric
                label={labels.outputTokens}
                value={run.cost.outputTokens}
              />
              <Metric
                label={labels.cacheReadTokens}
                value={run.cost.cacheReadTokens}
              />
              <Metric
                label={labels.cacheCreationTokens}
                value={run.cost.cacheCreationTokens}
              />
              <Metric
                label={labels.resumeTokens}
                value={
                  run.cost.resumeInputTokens +
                  run.cost.resumeOutputTokens +
                  run.cost.resumeCacheReadTokens +
                  run.cost.resumeCacheCreationTokens
                }
              />
              <Metric
                label={labels.duration}
                value={durationLabel(run.durationMs)}
              />
              <pre className="col-span-2 overflow-auto rounded-[8px] border border-line bg-ivory p-2 text-[10px]">
                {labels.byModel}: {JSON.stringify(run.cost.byModel)}
                {"\n"}
                {labels.byRunner}: {JSON.stringify(run.cost.byRunner)}
              </pre>
            </div>
          ) : (
            <p className="m-0 text-sm text-mute">{labels.noCost}</p>
          )}
        </Section>
      ))}
    </div>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: number | string;
}): ReactElement {
  return (
    <div className="rounded-[8px] border border-line bg-ivory px-2 py-1.5">
      <span className="block text-[10px] uppercase tracking-[0.08em] text-mute">
        {label}
      </span>
      <span className="text-ink">{value}</span>
    </div>
  );
}
