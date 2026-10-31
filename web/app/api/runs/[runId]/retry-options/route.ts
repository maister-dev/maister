import { NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { getAgentRetryOptions } from "@/lib/agents/retry";
import { agentRetryErrorResponse } from "@/lib/agents/retry-http";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const { runId } = await params;

    return NextResponse.json(
      await getAgentRetryOptions(getDb(), runId, user.id),
    );
  } catch (error) {
    return agentRetryErrorResponse(error);
  }
}
