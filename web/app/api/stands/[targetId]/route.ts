import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import {
  privateErrorResponse,
  privateJson,
  readPrivateJson,
} from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import {
  getStandTarget,
  saveStandTarget,
} from "@/lib/stand-operations/target-registry";
import { assertInteractiveLaunchOrigin } from "@/lib/tasks/launch-http";

type Context = { params: Promise<{ targetId: string }> };

export async function GET(
  _request: NextRequest,
  { params }: Context,
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const { targetId } = await params;

    return privateJson(await getStandTarget(getDb(), user.id, targetId));
  } catch (error) {
    return privateErrorResponse(error, "GET /api/stands/[targetId]");
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: Context,
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();

    assertInteractiveLaunchOrigin(request);
    const { targetId } = await params;
    const receipt = await saveStandTarget(
      getDb(),
      user.id,
      request.headers.get("Idempotency-Key"),
      await readPrivateJson(request),
      targetId,
    );

    return privateJson(receipt.target);
  } catch (error) {
    return privateErrorResponse(error, "PATCH /api/stands/[targetId]");
  }
}
