import type {
  ExperimentComparisonDTO,
  ExperimentComparisonRunDTO,
} from "@/lib/experiments/comparison";

export type ComparisonSelectionState = {
  pairKey?: string | null;
  replicateOrdinal?: number | null;
};

export function latestComparisonRuns(
  comparison: ExperimentComparisonDTO,
): ExperimentComparisonRunDTO[] {
  return comparison.variants
    .map(
      (variant) =>
        comparison.runs
          .filter((run) => run.variantKey === variant.key)
          .sort((left, right) => right.replicateOrdinal - left.replicateOrdinal)[0],
    )
    .filter((run): run is ExperimentComparisonRunDTO => run !== undefined);
}

export function comparisonReplicateOrdinals(
  comparison: ExperimentComparisonDTO,
): number[] {
  return [
    ...new Set(
      comparison.runs
        .map((run) => run.replicateOrdinal)
        .filter((value) => Number.isFinite(value)),
    ),
  ].sort((left, right) => left - right);
}

export function selectedComparisonReplicateOrdinal(
  comparison: ExperimentComparisonDTO,
  state?: ComparisonSelectionState,
): number | null {
  const ordinals = comparisonReplicateOrdinals(comparison);

  if (ordinals.length === 0) return null;
  if (
    state?.replicateOrdinal !== null &&
    state?.replicateOrdinal !== undefined &&
    ordinals.includes(state.replicateOrdinal)
  ) {
    return state.replicateOrdinal;
  }

  return ordinals[ordinals.length - 1];
}

export function comparisonRunsForReplicate(
  comparison: ExperimentComparisonDTO,
  state?: ComparisonSelectionState,
): ExperimentComparisonRunDTO[] {
  const ordinal = selectedComparisonReplicateOrdinal(comparison, state);

  if (ordinal === null) return latestComparisonRuns(comparison);

  return comparison.variants
    .map((variant) =>
      comparison.runs.find(
        (run) =>
          run.variantKey === variant.key && run.replicateOrdinal === ordinal,
      ),
    )
    .filter((run): run is ExperimentComparisonRunDTO => run !== undefined);
}

export function comparisonRunPairs(
  runs: ExperimentComparisonRunDTO[],
): Array<[ExperimentComparisonRunDTO, ExperimentComparisonRunDTO]> {
  return runs.flatMap((leftRun, leftIndex) =>
    runs
      .slice(leftIndex + 1)
      .map(
        (rightRun) =>
          [leftRun, rightRun] as [
            ExperimentComparisonRunDTO,
            ExperimentComparisonRunDTO,
          ],
      ),
  );
}

export function comparisonPairKey(
  left: ExperimentComparisonRunDTO,
  right: ExperimentComparisonRunDTO,
): string {
  return `${left.variantKey}:${right.variantKey}`;
}

export function selectedComparisonPair(
  runPairs: Array<[ExperimentComparisonRunDTO, ExperimentComparisonRunDTO]>,
  state?: ComparisonSelectionState,
): [ExperimentComparisonRunDTO, ExperimentComparisonRunDTO] | null {
  if (runPairs.length === 0) return null;

  return (
    runPairs.find(
      ([left, right]) => comparisonPairKey(left, right) === state?.pairKey,
    ) ?? runPairs[0]
  );
}

export function selectComparisonDiffRunsForPreparation(
  comparison: ExperimentComparisonDTO,
  state?: ComparisonSelectionState,
): ExperimentComparisonRunDTO[] {
  const runs = comparisonRunsForReplicate(comparison, state);
  const selectedPair = selectedComparisonPair(comparisonRunPairs(runs), state);

  return selectedPair === null ? runs : [selectedPair[0], selectedPair[1]];
}
