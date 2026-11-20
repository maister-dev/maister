import type { NextRequest, NextResponse } from "next/server";

import { recheckOperationalContinuationRoute } from "@/lib/runs/operational-route";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  return recheckOperationalContinuationRoute(req, (await params).runId);
}
