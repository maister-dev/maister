import type {
  ConsensusDraftEvidence,
  ConsensusVerdictEvidence,
} from "./ledger";

import { boundLoggedConsensusText } from "./bounded-log";
import {
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

type CritiqueOwner = Readonly<{
  runId: string;
  nodeAttemptId: string;
  round: number;
}>;

export const CONSENSUS_CRITIQUE_ROW_LIMIT = 12;
export const CONSENSUS_CRITIQUE_FIELD_CAP_BYTES = 1024;
export const CONSENSUS_CRITIQUE_LABEL_CAP_BYTES = 256;
// Below this a section cannot carry even its truncation marker usefully.
const MIN_SECTION_BYTES = 512;

const TRAILER =
  "Return the complete draft as your final message text. File writes are refused in this workspace. Do not reference files as the deliverable. Include the full draft in the final message, even when revising a previous draft.";

export function consensusDraftTrailer(): string {
  return TRAILER;
}

function bounded(
  owner: CritiqueOwner,
  value: string,
  cap: number,
  role: string,
  participantId: string,
): string {
  return boundLoggedConsensusText(value, cap, {
    ...owner,
    role,
    participantId,
  }).text;
}

function label(owner: CritiqueOwner, value: string, participantId: string) {
  return bounded(
    owner,
    value,
    CONSENSUS_CRITIQUE_LABEL_CAP_BYTES,
    "critique-label",
    participantId,
  );
}

function field(owner: CritiqueOwner, value: string, participantId: string) {
  return bounded(
    owner,
    value,
    CONSENSUS_CRITIQUE_FIELD_CAP_BYTES,
    "critique-field",
    participantId,
  );
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

function isDrafterSide(verdict: ConsensusVerdictEvidence): boolean {
  return (
    verdict.errorCode === "draft_partial" ||
    verdict.errorCode === "draft_unavailable"
  );
}

export function hasActionableConsensusCritique(
  verdicts: readonly ConsensusVerdictEvidence[],
  axes: readonly string[],
): boolean {
  return verdicts.some(
    (verdict) =>
      isDrafterSide(verdict) ||
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
        !isDrafterSide(verdict) &&
        (verdict.parseStatus !== "parsed" || !!verdict.errorCode),
    )
    .map((verdict) => ({
      verifierId: verdict.verifierId,
      targetParticipantId: verdict.targetParticipantId,
      parseStatus: verdict.parseStatus,
      errorCode: verdict.errorCode ?? verdict.parseStatus,
    }));
}

function rowLine(
  owner: CritiqueOwner,
  row: { axis: string; claim: string; counterEvidence: string },
  participantId: string,
): string {
  return `[${label(owner, row.axis, participantId)}] ${field(owner, row.claim, participantId)} (${field(owner, row.counterEvidence, participantId)})`;
}

function addressedVerdict(
  owner: CritiqueOwner,
  participantId: string,
  drafts: readonly ConsensusDraftEvidence[],
  verdicts: readonly ConsensusVerdictEvidence[],
  axes: readonly string[],
): string {
  const verdict = verdicts.find(
    (cell) => cell.targetParticipantId === participantId,
  );
  const draft = drafts.find((item) => item.participantId === participantId);

  if (verdict?.errorCode === "draft_partial") {
    const retainedBytes = Buffer.byteLength(draft?.artifactText ?? "", "utf8");

    return draft?.reason === "output_cap_exceeded"
      ? `Your round-${owner.round} draft exceeded the ${CONSENSUS_DRAFT_OUTPUT_CAP_BYTES}-byte output cap after ${retainedBytes} retained UTF-8 bytes; deliver a complete draft.`
      : `Your round-${owner.round} draft was cut by ${draft?.stopReason ?? "an unknown stop reason"} after ${retainedBytes} UTF-8 bytes; deliver a complete draft.`;
  }
  if (verdict?.errorCode === "draft_unavailable")
    return `Your round-${owner.round} draft was unavailable; deliver a complete draft.`;
  if (!verdict)
    return `No verdict on your round-${owner.round} draft is available.`;

  const rows = materialRows(verdict);
  const failures = failedAxes(verdict, axes);
  const verifier = label(owner, verdict.verifierId, participantId);
  const detail = [
    ...failures
      .slice(0, CONSENSUS_CRITIQUE_ROW_LIMIT)
      .map(
        (axis) =>
          `axis ${label(owner, axis, participantId)} judged false by verifier ${verifier}`,
      ),
    ...rows
      .slice(0, CONSENSUS_CRITIQUE_ROW_LIMIT)
      .map((row) => rowLine(owner, row, participantId)),
  ];

  if (
    rows.length > CONSENSUS_CRITIQUE_ROW_LIMIT ||
    failures.length > CONSENSUS_CRITIQUE_ROW_LIMIT
  )
    detail.push(
      `Omitted ${Math.max(0, rows.length - CONSENSUS_CRITIQUE_ROW_LIMIT)} rows and ${Math.max(0, failures.length - CONSENSUS_CRITIQUE_ROW_LIMIT)} axes; see verdict ${verdict.rawOutputArtifactId ?? "ledger"}.`,
    );

  return detail.length > 0
    ? `Verifier ${verifier} on ${participantId}:\n${detail.join("\n")}`
    : `Verifier ${verifier} gave no content criticism of ${participantId}.`;
}

function unionCritique(
  owner: CritiqueOwner,
  verdicts: readonly ConsensusVerdictEvidence[],
  axes: readonly string[],
): string {
  const rows = verdicts.flatMap((verdict) => materialRows(verdict));
  const failed = axes.filter((axis) =>
    verdicts.some((verdict) => failedAxes(verdict, axes).includes(axis)),
  );

  return [
    ...rows
      .slice(0, CONSENSUS_CRITIQUE_ROW_LIMIT)
      .map((row) => rowLine(owner, row, "round")),
    ...failed.slice(0, CONSENSUS_CRITIQUE_ROW_LIMIT).map((axis) => {
      const judges = verdicts
        .filter((verdict) => failedAxes(verdict, axes).includes(axis))
        .map(
          (verdict) =>
            `${label(owner, verdict.verifierId, "round")} on ${label(owner, verdict.targetParticipantId, "round")}`,
        );

      return `axis ${label(owner, axis, "round")} judged false: ${judges.join(", ")}`;
    }),
    `Omitted ${Math.max(0, rows.length - CONSENSUS_CRITIQUE_ROW_LIMIT)} rows and ${Math.max(0, failed.length - CONSENSUS_CRITIQUE_ROW_LIMIT)} axes.`,
  ].join("\n");
}

function technicalNotes(
  owner: CritiqueOwner,
  failures: readonly ConsensusTechnicalFailure[],
): string {
  const shown = failures
    .slice(0, CONSENSUS_CRITIQUE_ROW_LIMIT)
    .map(
      (item) =>
        `${label(owner, item.verifierId, item.targetParticipantId)} on ${label(owner, item.targetParticipantId, item.targetParticipantId)}: ${label(owner, item.parseStatus, item.targetParticipantId)} (${label(owner, item.errorCode, item.targetParticipantId)})`,
    );

  if (shown.length === 0) return "None.";
  if (failures.length > CONSENSUS_CRITIQUE_ROW_LIMIT)
    shown.push(
      `Omitted ${failures.length - CONSENSUS_CRITIQUE_ROW_LIMIT} technical failures.`,
    );

  return shown.join("\n");
}

/** The addressed verdict, union and technical notes share ONE prompt-text
 * budget, spent in that order, so a long union can never crowd out the verdict
 * a participant must answer. The own prior draft is its own D1 slot. */
function budgeted(
  owner: CritiqueOwner,
  participantId: string,
  sections: ReadonlyArray<{ role: string; text: string }>,
): string[] {
  let remaining = CONSENSUS_PROMPT_TEXT_CAP_BYTES;

  return sections.map((section) => {
    if (remaining < MIN_SECTION_BYTES)
      return "Omitted to fit the prompt budget; see the round ledger.";
    const text = bounded(
      owner,
      section.text,
      remaining,
      section.role,
      participantId,
    );

    remaining -= Buffer.byteLength(text, "utf8");

    return text;
  });
}

export function composeConsensusRoundCritique(input: {
  runId: string;
  nodeAttemptId: string;
  round: number;
  participants: readonly string[];
  drafts: readonly ConsensusDraftEvidence[];
  verdicts: readonly ConsensusVerdictEvidence[];
  axes: readonly string[];
}): ConsensusRoundCritique {
  const owner: CritiqueOwner = {
    runId: input.runId,
    nodeAttemptId: input.nodeAttemptId,
    round: input.round,
  };
  const technicalFailures = technicalConsensusFailures(input.verdicts);
  const union = unionCritique(owner, input.verdicts, input.axes);
  const technical = technicalNotes(owner, technicalFailures);
  const prompts = new Map<string, string>();

  for (const participantId of input.participants) {
    const own = input.drafts.find(
      (draft) => draft.participantId === participantId,
    );
    const prior = own?.artifactText
      ? bounded(
          owner,
          own.artifactText,
          CONSENSUS_PROMPT_TEXT_CAP_BYTES,
          "participant-prior-draft",
          participantId,
        )
      : "No previous draft text is available.";
    const [addressed, roundCritique, technicalText] = budgeted(
      owner,
      participantId,
      [
        {
          role: "addressed-verdict",
          text: addressedVerdict(
            owner,
            participantId,
            input.drafts,
            input.verdicts,
            input.axes,
          ),
        },
        { role: "union-critique", text: union },
        { role: "technical-notes", text: technical },
      ],
    );

    prompts.set(
      participantId,
      [
        "Verdict on your previous draft:",
        addressed,
        "Your previous draft:",
        prior,
        `Prior draft artifact: ${own?.artifactId ?? "none"} on run ${own?.runId ?? "none"}.`,
        "Round critique:",
        roundCritique,
        "Technical verifier failures:",
        technicalText,
      ].join("\n\n"),
    );
  }

  return {
    actionable: hasActionableConsensusCritique(input.verdicts, input.axes),
    technicalFailures,
    participantPrompts: prompts,
  };
}
