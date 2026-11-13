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
  listStandTargets,
  saveStandTarget,
} from "@/lib/stand-operations/target-registry";
import { assertInteractiveLaunchOrigin } from "@/lib/tasks/launch-http";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const query = Object.fromEntries(request.nextUrl.searchParams);

    return knowledgeJson(await listStandTargets(getDb(), user.id, query));
  } catch (error) {
    return knowledgeErrorResponse(error, "GET /api/stands");
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();

    assertInteractiveLaunchOrigin(request);
    const receipt = await saveStandTarget(
      getDb(),
      user.id,
      request.headers.get("Idempotency-Key"),
      await readKnowledgeJson(request),
    );

    return knowledgeJson(receipt.target, receipt.duplicate ? 200 : 201);
  } catch (error) {
    return knowledgeErrorResponse(error, "POST /api/stands");
  }
}
