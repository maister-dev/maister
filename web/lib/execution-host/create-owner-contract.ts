import { z } from "zod";

const id = z.string().min(1).max(128);

export const FlowCreateOwnerSchema = z.discriminatedUnion("variant", [
  z
    .object({
      variant: z.literal("node"),
      nodeAttemptId: id,
      promptOrdinal: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      variant: z.literal("gate_ai"),
      nodeAttemptId: id,
      gateId: id,
      evaluationId: id,
    })
    .strict(),
  z
    .object({
      variant: z.literal("gate_skill"),
      nodeAttemptId: id,
      gateId: id,
      evaluationId: id,
    })
    .strict(),
]);
export type FlowCreateOwner = z.infer<typeof FlowCreateOwnerSchema>;
export const SessionCreateOwnerSchema = z.discriminatedUnion("variant", [
  ...FlowCreateOwnerSchema.options,
  z
    .object({
      variant: z.literal("agent"),
      turnId: id,
      promptOrdinal: z.number().int().nonnegative(),
    })
    .strict(),
  // ADR-185: a librarian turn opens its own session on the conversation run.
  z
    .object({
      variant: z.literal("librarian"),
      turnId: id,
      promptOrdinal: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      variant: z.literal("consensus_verifier"),
      nodeAttemptId: id,
      round: z.number().int().nonnegative(),
      verifierId: id,
      targetId: id,
      verdictId: id,
    })
    .strict(),
  z
    .object({
      variant: z.literal("consensus_synthesis"),
      nodeAttemptId: id,
      round: z.number().int().nonnegative(),
      synthesisId: id,
    })
    .strict(),
  z
    .object({
      variant: z.literal("scratch"),
      scratchRunId: id,
      turnId: id,
      promptOrdinal: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      variant: z.literal("package_scratch"),
      scratchRunId: id,
      turnId: id,
      promptOrdinal: z.number().int().nonnegative(),
      localPackageId: id,
      postprocessActionId: id,
      lockGeneration: id,
    })
    .strict(),
  z
    .object({
      variant: z.literal("gate_chat"),
      hitlRequestId: id,
      turnId: id,
      userMessageId: id,
    })
    .strict(),
  z
    .object({
      variant: z.literal("sync_resolver"),
      syncAttemptId: id,
      operationAttemptId: id,
      promptOrdinal: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      variant: z.literal("flow_resume"),
      runSessionId: id,
      sourceIncarnationId: id,
    })
    .strict(),
  z
    .object({
      variant: z.literal("scratch_resume"),
      runSessionId: id,
      sourceIncarnationId: id,
    })
    .strict(),
]);

export type SessionCreateOwner = z.infer<typeof SessionCreateOwnerSchema>;
export type ConsensusCreateOwner = Extract<
  SessionCreateOwner,
  { variant: "consensus_verifier" | "consensus_synthesis" }
>;
export type ScratchCreateOwner = Extract<
  SessionCreateOwner,
  { variant: "scratch" | "package_scratch" }
>;
export type GateChatCreateOwner = Extract<
  SessionCreateOwner,
  { variant: "gate_chat" }
>;
export type SyncCreateOwner = Extract<
  SessionCreateOwner,
  { variant: "sync_resolver" }
>;
export type ResumeCreateOwner = Extract<
  SessionCreateOwner,
  { variant: "flow_resume" | "scratch_resume" }
>;

/** Closed private owner shapes shared by the runtime and database constraint. */
export const SESSION_CREATE_OWNER_SHAPES = SessionCreateOwnerSchema.options.map(
  (shape) => ({
    variant: shape.shape.variant.value,
    keys: Object.keys(shape.shape),
  }),
);

type AdditionalCreateOwnerVariant = Exclude<
  SessionCreateOwner["variant"],
  "node" | "gate_ai" | "gate_skill" | "agent" | "librarian"
>;
type CreateOperationParts = Readonly<{
  prefix: string;
  fields: readonly string[];
}>;
const additionalOperationParts: Readonly<
  Record<AdditionalCreateOwnerVariant, CreateOperationParts>
> = {
  consensus_verifier: {
    prefix: "consensus-create:verifier:",
    fields: ["verdictId"],
  },
  consensus_synthesis: {
    prefix: "consensus-create:synthesis:",
    fields: ["synthesisId"],
  },
  scratch: { prefix: "scratch-create:", fields: ["turnId", "promptOrdinal"] },
  package_scratch: {
    prefix: "package_scratch-create:",
    fields: ["turnId", "promptOrdinal"],
  },
  gate_chat: { prefix: "gate-chat-create:", fields: ["turnId"] },
  sync_resolver: {
    prefix: "sync-resolver-create:",
    fields: ["syncAttemptId", "promptOrdinal"],
  },
  flow_resume: {
    prefix: "flow_resume-create:",
    fields: ["sourceIncarnationId"],
  },
  scratch_resume: {
    prefix: "scratch_resume-create:",
    fields: ["sourceIncarnationId"],
  },
};

export const ADDITIONAL_CREATE_OWNER_SHAPES =
  SessionCreateOwnerSchema.options.flatMap((shape) => {
    const variant = shape.shape.variant.value;

    switch (variant) {
      case "node":
      case "gate_ai":
      case "gate_skill":
      case "agent":
      case "librarian":
        return [];
      default:
        return [
          {
            variant,
            keys: Object.keys(shape.shape),
            operation: additionalOperationParts[variant],
          },
        ];
    }
  });
