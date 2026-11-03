import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import { wakeTaskLaunchQueue } from "@/lib/tasks/launch-wake";
import { resolveAgentActivityAccess } from "@/lib/agents/activity-access";
import { acceptAgentRetryBatch } from "@/lib/agents/retry-batch";
import {
  agentRetryErrorResponse,
  readAgentRetryJson,
} from "@/lib/agents/retry-http";
import { runAgentRetryAdmissionSweep } from "@/lib/agents/retry";

const log = pino({
  name: "agent-retry-batch-dispatch",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; agentId: string }> },
): Promise<NextResponse> {
  try {
    const { slug, agentId } = await params;
    const access = await resolveAgentActivityAccess(slug, agentId);
    const principal = await interactiveTaskLaunchPrincipal();
    const result = await acceptAgentRetryBatch(
      access.db,
      {
        projectId: access.projectId,
        agentId: access.agentId,
        userId: access.actor.id,
      },
      await readAgentRetryJson(request),
      principal,
    );
    const accepted = result.items.some((item) => item.state === "accepted");

    if (accepted) {
      wakeTaskLaunchQueue(access.db);
      queueMicrotask(() => {
        void runAgentRetryAdmissionSweep(access.db).catch((error: unknown) =>
          log.warn(
            {
              projectId: access.projectId,
              agentId: access.agentId,
              errorType: error instanceof Error ? error.name : "unknown",
            },
            "[FIX:agent-retry] batch dispatch deferred to sweep",
          ),
        );
      });
    }

    return NextResponse.json(result, { status: accepted ? 202 : 200 });
  } catch (error) {
    return agentRetryErrorResponse(error);
  }
}
