import "server-only";

import type { NextResponse } from "next/server";

import { handleOwnedAgentWebhook } from "./owned-webhook-http";

import { submitProjectWebhookAssignment } from "@/lib/specialist-assignments/project-webhook-intake";

/** Explicit project negotiation keeps native assignments separate from legacy project-token payloads. */
export async function handleProjectAgentWebhook(
  request: Request,
  rawAgentId: string,
): Promise<NextResponse> {
  return handleOwnedAgentWebhook(
    request,
    rawAgentId,
    submitProjectWebhookAssignment,
  );
}
