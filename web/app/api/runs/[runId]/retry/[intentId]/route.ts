import { NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { getAgentRetryReceipt } from "@/lib/agents/retry";
import { agentRetryErrorResponse } from "@/lib/agents/retry-http";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string; intentId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const { runId, intentId } = await params;

    return NextResponse.json(
      await getAgentRetryReceipt(getDb(), runId, intentId, user.id),
    );
  } catch (error) {
    return agentRetryErrorResponse(error);
  }
}
