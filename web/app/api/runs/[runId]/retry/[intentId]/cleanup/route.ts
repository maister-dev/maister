import { NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { rearmAgentRetryCleanup } from "@/lib/agents/retry";
import {
  agentRetryErrorResponse,
  readAgentRetryJson,
} from "@/lib/agents/retry-http";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string; intentId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const { runId, intentId } = await params;
    const body: unknown = await readAgentRetryJson(request);

    return NextResponse.json(
      await rearmAgentRetryCleanup(getDb(), runId, intentId, user.id, body),
      { status: 202 },
    );
  } catch (error) {
    return agentRetryErrorResponse(error);
  }
}
