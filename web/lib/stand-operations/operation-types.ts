import { z } from "zod";

import {
  knowledgeDeliveryKeySchema,
  knowledgeRevisionSchema,
} from "@/lib/brain/knowledge-types";
import { postgresTextSchema } from "@/lib/text-schema";

export const STAND_OPERATION_BODY_MAX_BYTES = 65_536;
export const STAND_PERMIT_PURPOSES = [
  "dispatch",
  "reconcile",
  "logs",
  "verify",
] as const;
export const STAND_ACTIONS = ["inspect", "logs", "restart", "verify"] as const;
export const STAND_EFFECT_STATES = [
  "not_dispatched",
  "dispatching",
  "confirmed_applied",
  "confirmed_not_applied",
  "unknown",
] as const;
export const STAND_VERIFICATION_STATES = [
  "not_checked",
  "healthy",
  "unhealthy",
  "inconclusive",
] as const;
export const STAND_DISPOSITIONS = [
  "pending",
  "proved_applied",
  "proved_not_applied",
  "unresolved_hold",
  "authorized_successor",
] as const;

export const standOperationInputSchema = z
  .object({
    expectedRevision: knowledgeRevisionSchema,
    inputRevision: knowledgeRevisionSchema,
    componentId: postgresTextSchema.min(1).max(128),
    action: z.enum(STAND_ACTIONS),
    idempotencyKey: knowledgeDeliveryKeySchema,
  })
  .strict();

export const standRestartApprovalSchema = z
  .object({
    expectedRevision: knowledgeRevisionSchema,
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    reason: postgresTextSchema.min(1).max(2000).regex(/\S/),
    idempotencyKey: knowledgeDeliveryKeySchema,
  })
  .strict();

export const standPermitCheckSchema = z
  .object({
    targetIncarnation: z.uuid(),
    resourceKey: z.string().regex(/^[a-f0-9]{64}$/),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    ownerEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    nonce: knowledgeDeliveryKeySchema,
    purpose: z.enum(STAND_PERMIT_PURPOSES),
  })
  .strict();

export const standRecoveryDecisionSchema = z
  .object({
    expectedRevision: knowledgeRevisionSchema,
    decision: z.enum(["hold", "authorize_successor"]),
    inspectionIds: z.array(postgresTextSchema.min(1).max(128)).max(16),
    reason: postgresTextSchema.min(1).max(2000).regex(/\S/),
    idempotencyKey: knowledgeDeliveryKeySchema,
  })
  .strict();

export type StandPermitCheck = z.infer<typeof standPermitCheckSchema>;

export type StandAction = (typeof STAND_ACTIONS)[number];
export type StandOperation = Readonly<{
  id: string;
  assignmentId: string;
  componentId: string;
  targetIncarnation: string;
  requestDigest: string;
  effectState: (typeof STAND_EFFECT_STATES)[number];
  verificationState: (typeof STAND_VERIFICATION_STATES)[number];
  disposition: (typeof STAND_DISPOSITIONS)[number];
  receiptIds: readonly string[];
  verificationIds: readonly string[];
  predecessorId: string | null;
  successorId: string | null;
  revision: number;
}>;
