import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import {
  knowledgeErrorResponse,
  knowledgeJson,
  readKnowledgeJson,
} from "@/lib/brain/knowledge-http";
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

    return knowledgeJson(await getStandTarget(getDb(), user.id, targetId));
  } catch (error) {
    return knowledgeErrorResponse(error, "GET /api/stands/[targetId]");
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
      await readKnowledgeJson(request),
      targetId,
    );

    return knowledgeJson(receipt.target);
  } catch (error) {
    return knowledgeErrorResponse(error, "PATCH /api/stands/[targetId]");
  }
}
