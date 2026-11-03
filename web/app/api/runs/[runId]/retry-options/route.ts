import { NextResponse } from "next/server";

import { MaisterError } from "@/lib/errors";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { getAgentRetryOptions } from "@/lib/agents/retry";
import { agentRetryErrorResponse } from "@/lib/agents/retry-http";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const { runId } = await params;

    const search = new URL(request.url).searchParams;

    if (
      [...search.keys()].some(
        (key) => key !== "runnerId" || search.getAll(key).length !== 1,
      ) ||
      (search.has("runnerId") &&
        (!search.get("runnerId") || search.get("runnerId")!.length > 256))
    )
      throw new MaisterError("CONFIG", "Invalid retry preview runner", {
        details: { reason: "retry_request_invalid" },
      });

    return NextResponse.json(
      await getAgentRetryOptions(
        getDb(),
        runId,
        user.id,
        search.get("runnerId") ?? undefined,
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return agentRetryErrorResponse(error);
  }
}
