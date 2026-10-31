import { type NextRequest, type NextResponse } from "next/server";

import { acknowledgeOperationalRoute } from "@/lib/runs/operational-route";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  return acknowledgeOperationalRoute(req, (await params).runId);
}
