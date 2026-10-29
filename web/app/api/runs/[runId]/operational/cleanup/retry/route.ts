import { type NextRequest, type NextResponse } from "next/server";

import { retryOperationalRoute } from "@/lib/runs/operational-route";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  return retryOperationalRoute(req, (await params).runId);
}
