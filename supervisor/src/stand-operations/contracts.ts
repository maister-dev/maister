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
