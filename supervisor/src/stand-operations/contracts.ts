import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const StandDispatchPayloadSchema = z
  .object({
    operationId: z.uuid(),
    targetIncarnation: z.uuid(),
    componentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
    action: z.literal("restart"),
    requestDigest: digest,
    resourceKey: digest,
    ownerEpoch: z.number().int().min(1),
    businessOwnerEpoch: z.number().int().min(1),
    nodeAttemptId: z.uuid().nullable(),
    beforeObservationId: z.uuid(),
    predecessorId: z.uuid().optional(),
    before: z
      .object({
        invocationId: z
          .string()
          .regex(/^[a-f0-9]{32}$/)
          .nullable(),
        state: z.enum(["active", "inactive", "failed"]),
      })
      .strict(),
  })
  .strict();

export type StandDispatchPayload = z.infer<typeof StandDispatchPayloadSchema>;
export type DispatchStandRestart = (
  payload: StandDispatchPayload,
) => Promise<Record<string, unknown>>;

export const StandReceiptSelectorSchema = z
  .object({
    operationId: z.uuid(),
    targetIncarnation: z.uuid(),
    requestDigest: digest,
    ownerEpoch: z.number().int().min(1),
  })
  .strict();
export type StandReceiptSelector = z.infer<typeof StandReceiptSelectorSchema>;
export type ReadStandReceipt = (
  selector: StandReceiptSelector,
) => Promise<Record<string, unknown> | null>;
export const StandObservationSelectorSchema = StandReceiptSelectorSchema.extend(
  {
    componentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
    resourceKey: digest,
  },
).strict();
export type StandObservationSelector = z.infer<
  typeof StandObservationSelectorSchema
>;
export type ObserveStandOperation = (
  selector: StandObservationSelector,
) => Promise<Record<string, unknown>>;
export const StandVerifySelectorSchema = StandReceiptSelectorSchema.extend({
  componentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  verificationNonce: z.uuid(),
  issuedAt: z.iso.datetime(),
}).strict();
export type StandVerifySelector = z.infer<typeof StandVerifySelectorSchema>;
export type VerifyStandOperation = (
  selector: StandVerifySelector,
) => Promise<Record<string, unknown>>;
export const StandLogsSelectorSchema = StandReceiptSelectorSchema.extend({
  componentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
}).strict();
export type StandLogsSelector = z.infer<typeof StandLogsSelectorSchema>;
export type ReadStandLogs = (
  selector: StandLogsSelector,
) => Promise<Record<string, unknown>>;
