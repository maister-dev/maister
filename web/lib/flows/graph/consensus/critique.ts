import type {
  ConsensusDraftEvidence,
  ConsensusVerdictEvidence,
} from "./ledger";

import pino from "pino";

import {
  boundConsensusText,
  CONSENSUS_DRAFT_OUTPUT_CAP_BYTES,
  CONSENSUS_PROMPT_TEXT_CAP_BYTES,
} from "./text";

export type ConsensusTechnicalFailure = Readonly<{
  verifierId: string;
  targetParticipantId: string;
  parseStatus: string;
  errorCode: string;
}>;

export type ConsensusRoundCritique = Readonly<{
  actionable: boolean;
  technicalFailures: readonly ConsensusTechnicalFailure[];
  participantPrompts: ReadonlyMap<string, string>;
}>;

const TRAILER =
  "Return the complete draft as your final message text. File writes are refused in this workspace. Do not reference files as the deliverable. Include the full draft in the final message, even when revising a previous draft.";

export function consensusDraftTrailer(): string {
  return TRAILER;
}

const log = pino({
  name: "consensus-critique",
  level: process.env.LOG_LEVEL ?? "info",
});

function excerpt(
  value: string,
  cap: number,
  role: string,
  participantId: string,
  round: number,
): string {
  const bounded = boundConsensusText(value, cap);

  if (bounded.truncated)
    log.warn(
      {
        role,
        participantId,
        round,
        bytes: bounded.bounds.bytes,
        cap,
        droppedBytes: bounded.bounds.droppedBytes,
      },
      "consensus-text-truncated",
    );

  return bounded.text;
}

function materialRows(verdict: ConsensusVerdictEvidence) {
  return verdict.parseStatus === "parsed"
    ? verdict.disagreements.filter(
        (row) => row.claim.trim() || row.counterEvidence.trim(),
      )
    : [];
}

function failedAxes(
  verdict: ConsensusVerdictEvidence,
  axes: readonly string[],
) {
  return verdict.parseStatus === "parsed"
    ? axes.filter((axis) => verdict.axes[axis] === false)
    : [];
}

export function hasActionableConsensusCritique(
  verdicts: readonly ConsensusVerdictEvidence[],
  axes: readonly string[],
): boolean {
  return verdicts.some(
    (verdict) =>
      verdict.errorCode === "draft_partial" ||
      verdict.errorCode === "draft_unavailable" ||
      materialRows(verdict).length > 0 ||
      failedAxes(verdict, axes).length > 0,
  );
}

export function technicalConsensusFailures(
  verdicts: readonly ConsensusVerdictEvidence[],
): ConsensusTechnicalFailure[] {
  return verdicts
    .filter(
      (verdict) =>
        verdict.errorCode !== "draft_partial" &&
        verdict.errorCode !== "draft_unavailable" &&
        (verdict.parseStatus !== "parsed" || !!verdict.errorCode),
    )
    .map((verdict) => ({
      verifierId: verdict.verifierId,
      targetParticipantId: verdict.targetParticipantId,
      parseStatus: verdict.parseStatus,
      errorCode: verdict.errorCode ?? verdict.parseStatus,
    }));
}

function addressedVerdict(
  participantId: string,
  drafts: readonly ConsensusDraftEvidence[],
  verdicts: readonly ConsensusVerdictEvidence[],
  axes: readonly string[],
  round: number,
): string {
  const verdict = verdicts.find(
    (cell) => cell.targetParticipantId === participantId,
  );
  const draft = drafts.find((item) => item.participantId === participantId);

  if (verdict?.errorCode === "draft_partial") {
    const retainedBytes = Buffer.byteLength(draft?.artifactText ?? "", "utf8");

    return draft?.reason === "output_cap_exceeded"
      ? `Your round-${round} draft exceeded the ${CONSENSUS_DRAFT_OUTPUT_CAP_BYTES}-byte output cap after ${retainedBytes} retained UTF-8 bytes; deliver a complete draft.`
      : `Your round-${round} draft was cut by ${draft?.stopReason ?? "an unknown stop reason"} after ${retainedBytes} UTF-8 bytes; deliver a complete draft.`;
  }
  if (verdict?.errorCode === "draft_unavailable")
    return `Your round-${round} draft was unavailable; deliver a complete draft.`;
  if (!verdict) return `No verdict on your round-${round} draft is available.`;

  const rows = materialRows(verdict);
  const failures = failedAxes(verdict, axes);
  const detail = [
    ...failures
      .slice(0, 12)
      .map(
        (axis) =>
          `axis ${excerpt(axis, 256, "addressed-axis", participantId, round)} judged false by verifier ${excerpt(verdict.verifierId, 256, "addressed-verifier", participantId, round)}`,
      ),
    ...rows
      .slice(0, 12)
      .map(
        (row) =>
          `[${excerpt(row.axis, 256, "addressed-axis", participantId, round)}] ${excerpt(row.claim, 1024, "addressed-claim", participantId, round)} (${excerpt(row.counterEvidence, 1024, "addressed-evidence", participantId, round)})`,
      ),
  ];

  if (rows.length > 12 || failures.length > 12)
    detail.push(
      `Omitted ${Math.max(0, rows.length - 12)} rows and ${Math.max(0, failures.length - 12)} axes; see verdict ${verdict.rawOutputArtifactId ?? "ledger"}.`,
    );

  return detail.length > 0
    ? `Verifier ${verdict.verifierId} on ${participantId}:\n${detail.join("\n")}`
    : `Verifier ${verdict.verifierId} gave no content criticism of ${participantId}.`;
}

function unionCritique(
  verdicts: readonly ConsensusVerdictEvidence[],
  axes: readonly string[],
  round: number,
): string {
  const rows = verdicts.flatMap((verdict) => materialRows(verdict));
  const failed = axes.filter((axis) =>
    verdicts.some((verdict) => failedAxes(verdict, axes).includes(axis)),
  );
  const parts = [
    ...rows
      .slice(0, 12)
      .map(
        (row) =>
          `[${excerpt(row.axis, 256, "union-axis", "round", round)}] ${excerpt(row.claim, 1024, "union-claim", "round", round)} (${excerpt(row.counterEvidence, 1024, "union-evidence", "round", round)})`,
      ),
    ...failed.slice(0, 12).map((axis) => {
      const judges = verdicts
        .filter((verdict) => failedAxes(verdict, axes).includes(axis))
        .map(
          (verdict) =>
            `${verdict.verifierId} on ${verdict.targetParticipantId}`,
        );

      return `axis ${excerpt(axis, 256, "union-axis", "round", round)} judged false: ${judges.join(", ")}`;
    }),
    `Omitted ${Math.max(0, rows.length - 12)} rows and ${Math.max(0, failed.length - 12)} axes.`,
  ];

  return excerpt(
    parts.join("\n"),
    CONSENSUS_PROMPT_TEXT_CAP_BYTES,
    "union-critique",
    "round",
    round,
  );
}

export function composeConsensusRoundCritique(input: {
  round: number;
  participants: readonly string[];
  drafts: readonly ConsensusDraftEvidence[];
  verdicts: readonly ConsensusVerdictEvidence[];
  axes: readonly string[];
}): ConsensusRoundCritique {
  const technicalFailures = technicalConsensusFailures(input.verdicts);
  const technical = technicalFailures
    .slice(0, 12)
    .map(
      (item) =>
        `${excerpt(item.verifierId, 256, "technical-verifier", item.targetParticipantId, input.round)} on ${excerpt(item.targetParticipantId, 256, "technical-target", item.targetParticipantId, input.round)}: ${excerpt(item.parseStatus, 256, "technical-status", item.targetParticipantId, input.round)} (${excerpt(item.errorCode, 256, "technical-error", item.targetParticipantId, input.round)})`,
    )
    .join("\n");
  const union = unionCritique(input.verdicts, input.axes, input.round);
  const prompts = new Map<string, string>();

  for (const participantId of input.participants) {
    const own = input.drafts.find(
      (draft) => draft.participantId === participantId,
    );
    const prior = own?.artifactText
      ? excerpt(
          own.artifactText,
          CONSENSUS_PROMPT_TEXT_CAP_BYTES,
          "participant-prior-draft",
          participantId,
          input.round,
        )
      : "No previous draft text is available.";
    const content = [
      "Verdict on your previous draft:",
      excerpt(
        addressedVerdict(
          participantId,
          input.drafts,
          input.verdicts,
          input.axes,
          input.round,
        ),
        CONSENSUS_PROMPT_TEXT_CAP_BYTES,
        "addressed-verdict",
        participantId,
        input.round,
      ),
      "Your previous draft:",
      prior,
      `Prior draft artifact: ${own?.artifactId ?? "none"} on run ${own?.runId ?? "none"}.`,
      "Round critique:",
      union,
      "Technical verifier failures:",
      technical || "None.",
      ...(technicalFailures.length > 12
        ? [`Omitted ${technicalFailures.length - 12} technical failures.`]
        : []),
    ].join("\n\n");

    prompts.set(participantId, content);
  }

  return {
    actionable: hasActionableConsensusCritique(input.verdicts, input.axes),
    technicalFailures,
    participantPrompts: prompts,
  };
}
