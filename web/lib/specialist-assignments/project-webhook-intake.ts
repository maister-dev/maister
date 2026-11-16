import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { SpecialistIntakeReceipt } from "./intake-types";

import { projectWebhookAssignmentSchema } from "./project-webhook-types";
import { submitProjectUserRequest } from "./project-request-intake";

import { knowledgeDeliveryKeySchema } from "@/lib/brain/knowledge-types";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";

/** Stable actual user/project/specialist identity survives token rotation; replay enters the existing receipt path before provider resolution. */
export async function submitProjectWebhookAssignment(
  db: Db,
  userId: string,
  agentId: string,
  deliveryId: string | null,
  value: unknown,
): Promise<SpecialistIntakeReceipt> {
  const parsed = projectWebhookAssignmentSchema.safeParse(value);
  const key = knowledgeDeliveryKeySchema.safeParse(deliveryId);

  if (!parsed.success || !key.success)
    throw new MaisterError(
      "CONFIG",
      "Project webhook intake requires a version-one project assignment and bounded Idempotency-Key",
    );
  const request = parsed.data.assignment;
  const origin = {
    kind: "webhook" as const,
    endpointId: contentDigest({
      schemaVersion: 1,
      kind: "project_agent_webhook",
      projectId: request.owner.projectId,
      userId,
      agentId,
    }),
    deliveryId: key.data,
  };

  return submitProjectUserRequest(db, userId, request, {
    origin,
    destination: { kind: "inbox", userId },
    trigger: { source: "webhook", payload: { schemaVersion: 1, origin } },
    scheduledRequest: null,
    taskId: null,
    addressedAgentId: agentId,
  });
}
