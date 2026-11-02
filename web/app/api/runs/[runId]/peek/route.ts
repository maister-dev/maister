import type { NextRequest } from "next/server";

import { parsePeekRunId, peekQuery, peekResponse } from "@/lib/runs/peek-http";
import { readRunPeekSnapshot } from "@/lib/runs/peek-read-model";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  return peekResponse("snapshot", async (userId) =>
    readRunPeekSnapshot(
      userId,
      parsePeekRunId((await params).runId),
      peekQuery(request, ["selected", "node"]),
    ),
  );
}
