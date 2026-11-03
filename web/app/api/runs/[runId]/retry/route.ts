import { NextResponse } from "next/server";
import pino from "pino";

import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import { wakeTaskLaunchQueue } from "@/lib/tasks/launch-wake";
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
    const principal = await interactiveTaskLaunchPrincipal();
    const { runId } = await params;
    const db = getDb();
    const body: unknown = await readAgentRetryJson(request);
    const receipt = await acceptAgentRetry(
      db,
      runId,
      principal.userId,
      body,
      principal,
    );

    if (receipt.intentState === "accepted") {
      wakeTaskLaunchQueue(db);
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
    }

    return NextResponse.json(receipt, {
      status: receipt.intentState === "refused" ? 200 : 202,
    });
  } catch (error) {
    return agentRetryErrorResponse(error);
  }
}
