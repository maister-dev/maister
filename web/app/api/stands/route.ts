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
  listStandTargets,
  saveStandTarget,
} from "@/lib/stand-operations/target-registry";
import { assertInteractiveLaunchOrigin } from "@/lib/tasks/launch-http";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const query = Object.fromEntries(request.nextUrl.searchParams);

    return privateJson(await listStandTargets(getDb(), user.id, query));
  } catch (error) {
    return privateErrorResponse(error, "GET /api/stands");
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
      await readPrivateJson(request),
    );

    return privateJson(receipt.target, receipt.duplicate ? 200 : 201);
  } catch (error) {
    return privateErrorResponse(error, "POST /api/stands");
  }
}
