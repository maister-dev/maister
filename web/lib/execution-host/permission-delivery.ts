import "server-only";

import type { Db } from "./db";

import { eq } from "drizzle-orm";
import { z } from "zod";

import { isRefusedPermissionDelivery } from "./permission-handoff-evidence";
import { PromptOwnerInvariantError } from "./prompt-owners";

import { executionCommands, hitlRequests } from "@/lib/db/schema";

export const deliveryIntentSchema = z
  .object({
    commandId: z.string().min(1),
    hostSessionId: z.string().min(1),
    payload: z
      .object({
        kind: z.literal("permission"),
        action: z.literal("select"),
        requestId: z.string().min(1),
        optionId: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type DeliveryOwner = Readonly<{
  assignmentId: string;
  supervisorSessionId: string;
  requestId: string;
}>;

/** Withdraw a delivery intent whose `session.input` the host definitively
 * refused. The command never reached a deferred, so the stored answer is still
 * undelivered and a fresh input may carry it: the live retry mints one at
 * once, the idle resume re-delivers against the resumed session's reissued
 * request. Any other intent is kept — an unknown outcome may still be admitted
 * host-side, and reattaching to it is the only safe move.
 *
 * Returns the withdrawn response, or `null` when the intent was not refused.
 */
export async function withdrawRefusedPermissionDelivery(
  tx: Db,
  hitl: Readonly<{ id: string; runId: string }>,
  response: Record<string, unknown>,
  owner: DeliveryOwner,
): Promise<Record<string, unknown> | null> {
  const parsed = deliveryIntentSchema.safeParse(response._delivery);

  if (!parsed.success)
    throw new PromptOwnerInvariantError("permission_delivery_intent");
  const intent = parsed.data;
  const [prior] = await tx
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, intent.commandId));

  if (!prior || !isRefusedPermissionDelivery(prior)) return null;
  if (
    prior.runId !== hitl.runId ||
    prior.executionAssignmentId !== owner.assignmentId ||
    prior.targetSessionId !== owner.supervisorSessionId ||
    prior.payload.requestId !== owner.requestId ||
    prior.payload.optionId !== response.optionId
  )
    throw new PromptOwnerInvariantError("permission_retry_identity");
  const { _delivery, ...retained } = response;

  void _delivery;
  const withdrawn = {
    ...retained,
    _audit: {
      ...(typeof retained._audit === "object" && retained._audit !== null
        ? retained._audit
        : {}),
      previousDeliveryCommandId: intent.commandId,
    },
  };

  await tx
    .update(hitlRequests)
    .set({ response: withdrawn })
    .where(eq(hitlRequests.id, hitl.id));

  return withdrawn;
}
