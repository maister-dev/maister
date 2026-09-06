import { z } from "zod";

const id = z.string().min(1).max(128);
const ordinal = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const common = {
  version: z.literal(1),
  runId: id,
  runSessionId: id,
  incarnationId: id,
  assignmentId: id,
  assignmentEpoch: z.number().int().min(1).max(2_147_483_647),
};
const node = { ...common, nodeAttemptId: id, promptOrdinal: ordinal };
const round = { ...common, nodeAttemptId: id, round: ordinal };
const turn = { ...common, turnId: id, promptOrdinal: ordinal };
const scratch = { ...turn, scratchRunId: id };
const packageTurn = {
  ...scratch,
  localPackageId: id,
  postprocessActionId: id,
  lockGeneration: id,
};

const flowRefs = [
  z.object({ ...node, variant: z.literal("node") }).strict(),
  z
    .object({
      ...node,
      variant: z.literal("permission_resume"),
      hitlRequestId: id,
    })
    .strict(),
  z
    .object({
      ...node,
      variant: z.literal("gate_skill"),
      gateId: id,
      evaluationId: id,
    })
    .strict(),
  z
    .object({
      ...node,
      variant: z.literal("gate_ai"),
      gateId: id,
      evaluationId: id,
    })
    .strict(),
  z
    .object({
      ...round,
      variant: z.literal("consensus_verifier"),
      verifierId: id,
      targetId: id,
      verdictId: id,
    })
    .strict(),
  z
    .object({
      ...round,
      variant: z.literal("consensus_synthesis"),
      synthesisId: id,
    })
    .strict(),
] as const;
const agentRefs = [
  z.object({ ...turn, variant: z.literal("initial") }).strict(),
  z.object({ ...turn, variant: z.literal("resume") }).strict(),
  z.object({ ...turn, variant: z.literal("rework") }).strict(),
  z
    .object({ ...turn, variant: z.literal("live_message"), messageId: id })
    .strict(),
  z
    .object({
      ...turn,
      variant: z.literal("persistent_message"),
      messageId: id,
    })
    .strict(),
  z
    .object({
      ...turn,
      variant: z.literal("consensus_draft"),
      nodeAttemptId: id,
      round: ordinal,
      participantId: id,
    })
    .strict(),
] as const;
const scratchRefs = [
  z.object({ ...scratch, variant: z.literal("initial") }).strict(),
  z
    .object({ ...scratch, variant: z.literal("message"), messageId: id })
    .strict(),
  z.object({ ...scratch, variant: z.literal("recovery") }).strict(),
  z.object({ ...packageTurn, variant: z.literal("package_initial") }).strict(),
  z
    .object({
      ...packageTurn,
      variant: z.literal("package_message"),
      messageId: id,
    })
    .strict(),
  z.object({ ...packageTurn, variant: z.literal("package_recovery") }).strict(),
] as const;
const gateRef = z
  .object({
    ...common,
    variant: z.literal("reply"),
    hitlRequestId: id,
    turnId: id,
    userMessageId: id,
    leaseGeneration: id,
  })
  .strict();
const syncRef = z
  .object({
    ...common,
    variant: z.literal("resolver"),
    syncAttemptId: id,
    operationAttemptId: id,
    expectedPhase: z.literal("agent_running"),
    promptOrdinal: ordinal,
  })
  .strict();

export const PromptOwnerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("flow_node_attempt"),
      ref: z.discriminatedUnion("variant", flowRefs),
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent_turn"),
      ref: z.discriminatedUnion("variant", agentRefs),
    })
    .strict(),
  z
    .object({
      kind: z.literal("scratch_message"),
      ref: z.discriminatedUnion("variant", scratchRefs),
    })
    .strict(),
  z.object({ kind: z.literal("gate_chat"), ref: gateRef }).strict(),
  z.object({ kind: z.literal("sync_resolution"), ref: syncRef }).strict(),
]);

export type PromptOwner = z.infer<typeof PromptOwnerSchema>;
export type PromptOwnerReference = PromptOwner["ref"];

// The database CHECK derives required/allowed keys from these same closed schemas.
export const PROMPT_OWNER_SHAPES = [
  ...flowRefs.map((ref) => ({ kind: "flow_node_attempt", ref })),
  ...agentRefs.map((ref) => ({ kind: "agent_turn", ref })),
  ...scratchRefs.map((ref) => ({ kind: "scratch_message", ref })),
  { kind: "gate_chat", ref: gateRef },
  { kind: "sync_resolution", ref: syncRef },
].map(({ kind, ref }) => ({
  kind,
  variant: ref.shape.variant.value,
  keys: Object.keys(ref.shape),
}));
