import type { ExperimentComparisonDTO } from "@/lib/experiments/comparison";
import type { DiffPrepResult } from "@/lib/diff/prepare";
import type { ReactElement, ReactNode } from "react";

import {
  DiffView,
  type DiffViewLabels,
} from "@/components/workbench/diff-view";
import {
  comparisonPairKey,
  comparisonReplicateOrdinals,
  comparisonRunPairs,
  comparisonRunsForReplicate,
  latestComparisonRuns,
  selectComparisonDiffRunsForPreparation,
  selectedComparisonPair,
  selectedComparisonReplicateOrdinal,
  type ComparisonSelectionState,
} from "@/lib/experiments/comparison-selection";
import { computeDiffOfDiffs } from "@/lib/experiments/diff-of-diffs";
import { buildFilesMatrix } from "@/lib/experiments/files-matrix";

export interface ComparisonTabLabels {
  pair: string;
  replicate: string;
  snapshot: string;
  refsGone: string;
  truncated: string;
  missingSnapshot: string;
  identical: string;
  partial: string;
  fileDrilldown: string;
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
  diffEmpty: string;
  diffBodyUnavailable: string;
  diffAdded: string;
  diffRemoved: string;
  diffDisplayMode: string;
  diffRich: string;
  diffRaw: string;
  diffFilterFiles: string;
  diffFilterFilesPlaceholder: string;
  diffFilterNoMatches: string;
  diffShowFiles: string;
  diffHideFiles: string;
  diffRefresh: string;
  diffViewMode: string;
  diffSplit: string;
  diffUnified: string;
}

export type ComparisonFilesFilter = "all" | "different" | "same";

export type ComparisonTabState = ComparisonSelectionState & {
  baseHref?: string;
  filesFilter?: ComparisonFilesFilter | null;
};

function variantLabel(
  comparison: ExperimentComparisonDTO,
  variantKey: string,
): string {
  return (
    comparison.variants.find((variant) => variant.key === variantKey)?.label ??
    variantKey
  );
}

function tabHref(
  state: ComparisonTabState | undefined,
  patch: {
    tab?: string;
    pair?: string | null;
    replicate?: number | null;
    filesFilter?: ComparisonFilesFilter | null;
  },
): string {
  const baseHref = state?.baseHref ?? "#";
  const params = new URLSearchParams();

  if (patch.tab) params.set("tab", patch.tab);
  const pair = patch.pair ?? state?.pairKey ?? null;
  const replicate = patch.replicate ?? state?.replicateOrdinal ?? null;
  const filesFilter = patch.filesFilter ?? state?.filesFilter ?? null;

  if (pair) params.set("pair", pair);
  if (replicate !== null) params.set("replicate", String(replicate));
  if (filesFilter) params.set("filesFilter", filesFilter);

  const query = params.toString();

  return query.length > 0 ? `${baseHref}?${query}` : baseHref;
}

function diffViewLabels(labels: ComparisonTabLabels): DiffViewLabels {
  return {
    empty: labels.diffEmpty,
    bodyUnavailable: labels.diffBodyUnavailable,
    added: labels.diffAdded,
    removed: labels.diffRemoved,
    displayMode: labels.diffDisplayMode,
    rich: labels.diffRich,
    raw: labels.diffRaw,
    filterFiles: labels.diffFilterFiles,
    filterFilesPlaceholder: labels.diffFilterFilesPlaceholder,
    filterNoMatches: labels.diffFilterNoMatches,
    showFiles: labels.diffShowFiles,
    hideFiles: labels.diffHideFiles,
    refresh: labels.diffRefresh,
    viewMode: labels.diffViewMode,
    split: labels.diffSplit,
    unified: labels.diffUnified,
    truncated: labels.truncated,
  };
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
  state,
  preparedDiffs,
}: {
  comparison: ExperimentComparisonDTO;
  labels: ComparisonTabLabels;
  state?: ComparisonTabState;
  preparedDiffs?: Record<string, DiffPrepResult>;
}): ReactElement {
  const runs = comparisonRunsForReplicate(comparison, state);
  const visibleRuns = selectComparisonDiffRunsForPreparation(comparison, state);
  const runPairs = comparisonRunPairs(runs);
  const ordinals = comparisonReplicateOrdinals(comparison);
  const currentReplicate = selectedComparisonReplicateOrdinal(
    comparison,
    state,
  );

  return (
    <div className="grid grid-cols-1 gap-4">
      {ordinals.length > 0 ? (
        <Section title={labels.replicate}>
          <div className="flex flex-wrap gap-2">
            {ordinals.map((ordinal) => (
              <a
                key={ordinal}
                aria-current={ordinal === currentReplicate ? "page" : undefined}
                className="rounded-full border border-line bg-ivory px-2 py-1 font-mono text-[11px] text-ink aria-[current]:border-amber aria-[current]:bg-amber-soft"
                href={tabHref(state, { tab: "diff", replicate: ordinal })}
              >
                #{ordinal}
              </a>
            ))}
          </div>
        </Section>
      ) : null}
      {runPairs.length > 1 ? (
        <Section title={labels.pair}>
          <div className="flex flex-wrap gap-2">
            {runPairs.map(([left, right]) => {
              const currentPairKey = comparisonPairKey(left, right);

              return (
                <a
                  key={`${left.runId}:${right.runId}`}
                  aria-current={
                    currentPairKey ===
                    (state?.pairKey ??
                      comparisonPairKey(runPairs[0][0], runPairs[0][1]))
                      ? "page"
                      : undefined
                  }
                  className="rounded-full border border-line bg-ivory px-2 py-1 font-mono text-[11px] text-ink aria-[current]:border-amber aria-[current]:bg-amber-soft"
                  href={tabHref(state, { tab: "diff", pair: currentPairKey })}
                >
                  {variantLabel(comparison, left.variantKey)} ↔{" "}
                  {variantLabel(comparison, right.variantKey)}
                </a>
              );
            })}
          </div>
        </Section>
      ) : null}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {visibleRuns.map((run) => {
          const prepared = preparedDiffs?.[run.runId];

          return (
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
              {prepared ? (
                <DiffView
                  renderUnavailable
                  files={prepared.files}
                  labels={diffViewLabels(labels)}
                  perFile={prepared.perFile}
                  truncated={prepared.truncated}
                />
              ) : run.diff.snapshot ? (
                <div className="rounded-[10px] border border-line bg-ivory p-3 font-mono text-[11px] leading-5 text-mute">
                  {labels.diffBodyUnavailable}
                </div>
              ) : (
                <p className="m-0 text-sm text-mute">
                  {labels.missingSnapshot}
                </p>
              )}
            </Section>
          );
        })}
      </div>
    </div>
  );
}

export function DiffOfDiffsTab({
  comparison,
  labels,
  state,
}: {
  comparison: ExperimentComparisonDTO;
  labels: ComparisonTabLabels;
  state?: ComparisonTabState;
}): ReactElement {
  const runPairs = comparisonRunPairs(
    comparisonRunsForReplicate(comparison, state),
  );
  const selected = selectedComparisonPair(runPairs, state);

  if (!selected) {
    return (
      <Section title={labels.pair}>
        <p className="m-0 text-sm text-mute">{labels.missingSnapshot}</p>
      </Section>
    );
  }

  const [left, right] = selected;

  if (!left.diff.snapshot || !right.diff.snapshot) {
    return (
      <Section
        title={`${variantLabel(comparison, left.variantKey)} ↔ ${variantLabel(
          comparison,
          right.variantKey,
        )}`}
      >
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
        <div className="max-h-[360px] overflow-auto rounded-[10px] border border-line bg-ivory p-3 font-mono text-[11px] leading-5 text-ink">
          {result.lines.map((line, index) => (
            <div
              key={`${line.kind}:${index}:${line.line}`}
              className={
                line.kind === "added" ? "text-[#1a7f37]" : "text-[#cf222e]"
              }
            >
              {line.kind === "added" ? "+" : "-"} {line.line}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

export function FilesTab({
  comparison,
  labels,
  state,
}: {
  comparison: ExperimentComparisonDTO;
  labels: ComparisonTabLabels;
  state?: ComparisonTabState;
}): ReactElement {
  const runs = comparisonRunsForReplicate(comparison, state);
  const matrix = buildFilesMatrix(
    runs.map((run) => ({
      variantKey: run.variantKey,
      replicateOrdinal: run.replicateOrdinal,
      files: run.files,
    })),
  );
  const activeFilter = state?.filesFilter ?? "all";
  const differentRows = matrix.rows.filter(
    (row) => row.classification !== "same",
  );
  const rows =
    activeFilter === "different" ? differentRows : matrix.filters[activeFilter];
  const filters: Array<{
    key: ComparisonFilesFilter;
    label: string;
    count: number;
  }> = [
    { key: "all", label: labels.filesAll, count: matrix.filters.all.length },
    {
      key: "different",
      label: labels.filesDifferent,
      count: differentRows.length,
    },
    { key: "same", label: labels.filesSame, count: matrix.filters.same.length },
  ];

  return (
    <Section title={labels.filesAll}>
      <div className="mb-3 flex flex-wrap gap-2">
        {filters.map((filter) => (
          <a
            key={filter.key}
            aria-current={filter.key === activeFilter ? "page" : undefined}
            className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[10px] text-mute aria-[current]:border-amber aria-[current]:bg-amber-soft aria-[current]:text-ink"
            href={tabHref(state, {
              tab: "files",
              filesFilter: filter.key,
            })}
          >
            {filter.label}: {filter.count}
          </a>
        ))}
      </div>
      <div className="overflow-hidden rounded-[10px] border border-line">
        {rows.map((row) => (
          <details
            key={row.path}
            className="border-b border-line px-3 py-2 last:border-0"
          >
            <summary className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-3">
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
            </summary>
            <div className="mt-2 rounded-[8px] border border-line-soft bg-ivory p-2">
              <p className="m-0 mb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
                {labels.fileDrilldown}
              </p>
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                {Object.entries(row.variants).map(([variantKey, file]) => (
                  <div
                    key={`${row.path}:${variantKey}`}
                    className="rounded border border-line bg-paper px-2 py-1 font-mono text-[10.5px] text-mute"
                  >
                    <span className="block font-semibold text-ink">
                      {variantLabel(comparison, variantKey)}
                    </span>
                    {file ? (
                      <span>
                        {file.status} +{file.additions} -{file.deletions}
                      </span>
                    ) : (
                      <span>{labels.contentUnavailable}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </details>
        ))}
      </div>
      {runs.some((run) => run.diff.snapshot === null) ? (
        <p className="m-0 mt-3 text-sm text-mute">
          {labels.contentUnavailable}
        </p>
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
  const runs = latestComparisonRuns(comparison);

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
                const verdict = gate.verdict as {
                  verdict?: string;
                  confidence?: number;
                } | null;

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
  const runs = latestComparisonRuns(comparison);

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
