import { NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import {
  acceptAgentRetry,
  runAgentRetryAdmissionSweep,
} from "@/lib/agents/retry";
import {
  agentRetryErrorResponse,
  readAgentRetryJson,
} from "@/lib/agents/retry-http";

const log = pino({
  name: "agent-retry-dispatch",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const { runId } = await params;
    const db = getDb();
    const body: unknown = await readAgentRetryJson(request);
    const receipt = await acceptAgentRetry(db, runId, user.id, body);

    if (receipt.intentState === "accepted")
      queueMicrotask(() => {
        void runAgentRetryAdmissionSweep(db).catch((error: unknown) =>
          log.warn(
            {
              retryIntentId: receipt.retryIntentId,
              errorType: error instanceof Error ? error.name : "unknown",
            },
            "retry dispatch deferred to existing sweep",
          ),
        );
      });

    return NextResponse.json(receipt, {
      status: receipt.intentState === "refused" ? 200 : 202,
    });
  } catch (error) {
    return agentRetryErrorResponse(error);
  }
}
