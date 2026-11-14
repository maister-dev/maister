import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { privateErrorResponse, privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { getStandOperation } from "@/lib/stand-operations/operation-intake";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ operationId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const { operationId } = await params;

    return privateJson(await getStandOperation(getDb(), user.id, operationId));
  } catch (error) {
    return privateErrorResponse(
      error,
      "GET /api/stand-operations/[operationId]",
    );
  }
}
