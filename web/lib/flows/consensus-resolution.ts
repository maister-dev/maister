// The consensus-resolution HITL schema: ONE typed shape and ONE tolerant
// decoder shared by the runtime writer, the response validator, the rerun
// resolver and the inbox card. Client-safe on purpose (no server-only, no
// logger): the card decodes the same record the server validates, so the
// pickability both sides compute cannot drift.

export const CONSENSUS_DRAFT_CLASSES = [
  "complete",
  "partial",
  "unavailable",
] as const;
export type ConsensusDraftClass = (typeof CONSENSUS_DRAFT_CLASSES)[number];

export const CONSENSUS_ESCALATION_REASONS = [
  "technical_only",
  "rounds_exhausted",
  "single_pass",
] as const;
export type ConsensusEscalationReason =
  (typeof CONSENSUS_ESCALATION_REASONS)[number];

// Why a partial draft stopped, as the operator needs to read it. The owner
// records an ACP stop reason plus an engine `reason`; this is the closed set
// the card localizes, with `unknown` for anything outside it.
export const CONSENSUS_PARTIAL_CAUSES = [
  "output_cap_exceeded",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
  "host_failure",
  "unknown",
] as const;
export type ConsensusPartialCause = (typeof CONSENSUS_PARTIAL_CAUSES)[number];

export type ConsensusTextBoundsView = Readonly<{
  bytes: number;
  retainedBytes: number;
  droppedBytes: number;
  cap: number;
}>;

export type ConsensusResolutionDraft = Readonly<{
  decision: string;
  slot: number;
  classification?: ConsensusDraftClass;
  stopReason?: string;
  reason?: string;
  excerpt?: string;
  excerptBounds?: ConsensusTextBoundsView;
  artifactRef?: string;
  artifactRunId?: string;
  label?: string;
}>;

export type ConsensusResolutionTechnicalFailure = Readonly<{
  verifierId: string;
  targetParticipantId: string;
  parseStatus: string;
  errorCode: string;
  targetSlot?: number;
}>;

export type ConsensusResolutionDisagreement = Readonly<{
  axis: string;
  summary?: string;
}>;

export type ConsensusResolutionSchema = Readonly<{
  kind: "consensus_resolution";
  nodeAttemptId?: string;
  round: number;
  maxRounds?: number;
  allowedDecisions: readonly string[];
  escalationReason?: ConsensusEscalationReason;
  drafts: readonly ConsensusResolutionDraft[];
  disagreements: readonly ConsensusResolutionDisagreement[];
  technicalFailures: readonly ConsensusResolutionTechnicalFailure[];
  debateLog?: Readonly<{
    excerpt?: string;
    excerptBounds?: ConsensusTextBoundsView;
    artifactRef?: string;
    artifactRunId?: string;
  }>;
}>;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function bounds(value: unknown): ConsensusTextBoundsView | undefined {
  if (!isRecord(value)) return undefined;
  const { bytes, retainedBytes, droppedBytes, cap } = value;

  return [bytes, retainedBytes, droppedBytes, cap].every(
    (item) => typeof item === "number" && Number.isInteger(item) && item >= 0,
  )
    ? {
        bytes: bytes as number,
        retainedBytes: retainedBytes as number,
        droppedBytes: droppedBytes as number,
        cap: cap as number,
      }
    : undefined;
}

function optional<K extends string, V>(key: K, value: V | undefined) {
  return (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;
}

export function isConsensusResolutionKind(schema: unknown): boolean {
  return (
    isRecord(schema) &&
    (schema.kind === "consensus_resolution" || schema.kind === "consensus")
  );
}

function decodeDrafts(
  schema: Json,
  allowedDecisions: readonly string[],
): ConsensusResolutionDraft[] {
  const pickDecisions = allowedDecisions.filter((decision) =>
    decision.startsWith("pick-draft-"),
  );

  // A legacy record may omit a choice's own decision; its slot then falls back
  // to the allow-listed pick at the same position, never to a renumbering.
  return records(schema.drafts ?? schema.choices).map((draft, index) => ({
    decision:
      text(draft.decision) ?? pickDecisions[index] ?? `pick-draft-${index + 1}`,
    slot: index + 1,
    ...optional(
      "classification",
      oneOf(draft.classification, CONSENSUS_DRAFT_CLASSES),
    ),
    ...optional("stopReason", text(draft.stopReason)),
    ...optional("reason", text(draft.reason)),
    ...optional(
      "excerpt",
      text(draft.excerpt) ?? text(draft.summary) ?? text(draft.preview),
    ),
    ...optional("excerptBounds", bounds(draft.excerptBounds)),
    ...optional("artifactRef", text(draft.artifactRef)),
    ...optional("artifactRunId", text(draft.artifactRunId)),
    ...optional(
      "label",
      text(draft.label) ??
        text(draft.participantLabel) ??
        text(draft.title) ??
        text(draft.name),
    ),
  }));
}

function decodeTechnicalFailures(
  schema: Json,
): ConsensusResolutionTechnicalFailure[] {
  return records(schema.technicalFailures).flatMap((item) => {
    const verifierId = text(item.verifierId);
    const targetParticipantId = text(item.targetParticipantId);
    const parseStatus = text(item.parseStatus);
    const errorCode = text(item.errorCode) ?? parseStatus;
    const targetSlot =
      typeof item.targetSlot === "number" &&
      Number.isInteger(item.targetSlot) &&
      item.targetSlot > 0
        ? item.targetSlot
        : undefined;

    return verifierId && targetParticipantId && parseStatus && errorCode
      ? [
          {
            verifierId,
            targetParticipantId,
            parseStatus,
            errorCode,
            ...optional("targetSlot", targetSlot),
          },
        ]
      : [];
  });
}

function decodeDisagreements(schema: Json): ConsensusResolutionDisagreement[] {
  return records(
    schema.disagreements ?? schema.materialAxisDisagreements,
  ).flatMap((item) => {
    const axis = text(item.axis);
    const summary = text(item.summary) ?? text(item.claim) ?? text(item.reason);

    return axis ? [{ axis, ...optional("summary", summary) }] : [];
  });
}

function decodeDebateLog(
  schema: Json,
): ConsensusResolutionSchema["debateLog"] | undefined {
  const value = schema.debateLog ?? schema.debate_log;

  if (!isRecord(value)) {
    const excerpt = text(schema.debateExcerpt ?? schema.debate_log_excerpt);

    return excerpt ? { excerpt } : undefined;
  }

  return {
    ...optional("excerpt", text(value.excerpt)),
    ...optional("excerptBounds", bounds(value.excerptBounds)),
    ...optional("artifactRef", text(value.artifactRef)),
    ...optional("artifactRunId", text(value.artifactRunId)),
  };
}

/** Decode a stored consensus-resolution schema, or `null` when it is not one.
 * Tolerates legacy aliases; unknown or malformed optional fields are dropped,
 * never invented. */
export function decodeConsensusResolutionSchema(
  schema: unknown,
): ConsensusResolutionSchema | null {
  if (!isRecord(schema) || !isConsensusResolutionKind(schema)) return null;
  const allowed = strings(schema.allowedDecisions);
  const allowedDecisions =
    allowed.length > 0 ? allowed : strings(schema.decisions);

  return {
    kind: "consensus_resolution",
    ...optional("nodeAttemptId", text(schema.nodeAttemptId)),
    round:
      typeof schema.round === "number" &&
      Number.isInteger(schema.round) &&
      schema.round > 0
        ? schema.round
        : 1,
    ...optional(
      "maxRounds",
      typeof schema.maxRounds === "number" ? schema.maxRounds : undefined,
    ),
    allowedDecisions,
    ...optional(
      "escalationReason",
      oneOf(schema.escalationReason, CONSENSUS_ESCALATION_REASONS),
    ),
    drafts: decodeDrafts(schema, allowedDecisions),
    disagreements: decodeDisagreements(schema),
    technicalFailures: decodeTechnicalFailures(schema),
    ...optional("debateLog", decodeDebateLog(schema)),
  };
}

/** A draft slot is pickable unless its stored classification says it has no
 * text. Legacy choices without a classification stay pickable. */
export function isConsensusDraftPickable(
  draft: ConsensusResolutionDraft,
): boolean {
  return draft.classification !== "unavailable";
}

export function consensusDraftForDecision(
  schema: ConsensusResolutionSchema,
  decision: string,
): ConsensusResolutionDraft | undefined {
  return schema.drafts.find((draft) => draft.decision === decision);
}

export function consensusPartialCause(
  draft: Pick<ConsensusResolutionDraft, "reason" | "stopReason">,
): ConsensusPartialCause {
  if (draft.reason === "output_cap_exceeded") return "output_cap_exceeded";

  return (
    oneOf(draft.stopReason, CONSENSUS_PARTIAL_CAUSES) ??
    oneOf(draft.reason, CONSENSUS_PARTIAL_CAUSES) ??
    "unknown"
  );
}
