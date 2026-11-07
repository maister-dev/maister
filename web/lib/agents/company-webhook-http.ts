import "server-only";

import type { NextResponse } from "next/server";

import { handleOwnedAgentWebhook } from "./owned-webhook-http";

import { submitCompanyWebhookAssignment } from "@/lib/specialist-assignments/company-webhook-intake";

/** Explicit company negotiation retains the existing native company request contract. */
export async function handleCompanyAgentWebhook(
  request: Request,
  rawAgentId: string,
): Promise<NextResponse> {
  return handleOwnedAgentWebhook(
    request,
    rawAgentId,
    submitCompanyWebhookAssignment,
  );
}
