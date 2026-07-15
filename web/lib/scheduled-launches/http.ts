import "server-only";

import { z } from "zod";

import { MaisterError } from "@/lib/errors";
import { storedDeliveryPolicySchema } from "@/lib/runs/delivery-policy";
import { executionPolicySchema } from "@/lib/runs/execution-policy";

export const scheduledLaunchRequestBodySchema = z
  .object({
    flowId: z.string().min(1).max(255).optional(),
    runnerId: z.string().min(1).max(255).optional(),
    baseBranch: z.string().min(1).max(255).optional(),
    baseCommit: z.string().min(7).max(255).optional(),
    targetBranch: z.string().min(1).max(255).optional(),
    deliveryPolicy: storedDeliveryPolicySchema.optional(),
    executionPolicy: executionPolicySchema.optional(),
    packageVersions: z
      .record(z.enum(["keep", "adopt", "cut_and_adopt", "try_once"]))
      .optional(),
    brainContext: z.boolean().nullable().optional(),
    autoPromote: z.boolean().optional(),
  })
  .strict();

export const createScheduledLaunchBodySchema = z
  .object({
    taskId: z.string().uuid(),
    scheduledLocalTime: z.string().min(1).max(64),
    timezone: z.string().min(1).max(255),
    disambiguation: z.enum(["earlier", "later"]).optional(),
    launchRequest: scheduledLaunchRequestBodySchema,
  })
  .strict();

export const patchScheduledLaunchBodySchema = z
  .object({
    scheduledLocalTime: z.string().min(1).max(64),
    timezone: z.string().min(1).max(255),
    disambiguation: z.enum(["earlier", "later"]).optional(),
    launchRequest: scheduledLaunchRequestBodySchema,
  })
  .strict();

export function parseCreateScheduledLaunchBody(
  input: unknown,
): z.infer<typeof createScheduledLaunchBodySchema> {
  const parsed = createScheduledLaunchBodySchema.safeParse(input);

  if (parsed.success) return parsed.data;

  throw new MaisterError("CONFIG", "scheduled launch request is invalid");
}

export function parsePatchScheduledLaunchBody(
  input: unknown,
): z.infer<typeof patchScheduledLaunchBodySchema> {
  const parsed = patchScheduledLaunchBodySchema.safeParse(input);

  if (parsed.success) return parsed.data;

  throw new MaisterError("CONFIG", "scheduled launch update is invalid");
}

export function parseIfMatch(value: string | null): number {
  const match = value?.match(/^"([1-9][0-9]*)"$/);

  if (!match?.[1]) {
    throw new MaisterError(
      "CONFLICT",
      "If-Match must contain the current quoted scheduled launch revision",
    );
  }

  return Number(match[1]);
}

export function revisionHeaders(revision: number): HeadersInit {
  return { ETag: `"${revision}"` };
}
