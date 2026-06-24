import type { ConsensusDisagreement, ParsedConsensusVerdict } from "./verdict";

export type ConsensusTallyInput = {
  materialAxes: readonly string[];
  verdicts: readonly ParsedConsensusVerdict[];
};

export type ConsensusTallyResult = {
  agreementReached: boolean;
  disagreementCount: number;
  failedAxes: string[];
  disagreements: ConsensusDisagreement[];
  invalidVerdictCount: number;
};

export function tallyConsensus({
  materialAxes,
  verdicts,
}: ConsensusTallyInput): ConsensusTallyResult {
  const failedAxes = new Set<string>();
  const disagreements: ConsensusDisagreement[] = [];
  let disagreementCount = 0;
  let invalidVerdictCount = 0;

  for (const verdict of verdicts) {
    const invalid = verdict.parseStatus !== "parsed";
    const disagreed = invalid || verdict.verdict !== "agree";
    const falseAxes = materialAxes.filter(
      (axis) => verdict.axes[axis] !== true,
    );

    if (invalid) invalidVerdictCount += 1;
    if (disagreed || falseAxes.length > 0) disagreementCount += 1;

    for (const axis of falseAxes) {
      failedAxes.add(axis);
    }
    disagreements.push(...verdict.disagreements);
  }

  return {
    agreementReached:
      verdicts.length > 0 && disagreementCount === 0 && failedAxes.size === 0,
    disagreementCount,
    failedAxes: [...failedAxes],
    disagreements,
    invalidVerdictCount,
  };
}
