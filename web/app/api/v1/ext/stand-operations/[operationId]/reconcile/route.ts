import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { decodeRouteParam } from "@/lib/route-params";
import { handlePersonalAssignmentExt } from "@/lib/specialist-assignments/external";
import { STAND_OPERATION_BODY_MAX_BYTES } from "@/lib/stand-operations/operation-types";
import { reconcileStandRestart } from "@/lib/stand-operations/reconcile";

type RouteParams = { params: Promise<{ operationId: string }> };

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  return handlePersonalAssignmentExt(
    request,
    "targets:recover",
    "POST /api/v1/ext/stand-operations/[operationId]/reconcile",
    async (userId) => {
      const operation = await reconcileStandRestart(
        getDb(),
        userId,
        decodeRouteParam((await params).operationId, "operationId"),
        await readBoundedJson(request, STAND_OPERATION_BODY_MAX_BYTES),
      );

      return privateJson(
        operation,
        operation.effectState === "unknown" ? 202 : 200,
      );
    },
  );
}
