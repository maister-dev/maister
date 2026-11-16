import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { decodeRouteParam } from "@/lib/route-params";
import { createOrActivateAssignmentQuestion } from "@/lib/services/assignment-question";
import {
  assignmentQuestionJson,
  assignmentQuestionExternalError,
} from "@/lib/specialist-assignments/question-http";
import { handleOwnedExt } from "@/lib/tokens/owned-ext-handler";

type RouteParams = { params: Promise<{ assignmentId: string }> };
const endpoint =
  "POST /api/v1/ext/specialist-assignments/[assignmentId]/questions";

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  return handleOwnedExt(
    request,
    { endpoint, scopeLabel: "assignments:update", method: "POST" },
    async ({ actor }) =>
      assignmentQuestionJson(
        await createOrActivateAssignmentQuestion(
          getDb(),
          { kind: "token", tokenId: actor.tokenId },
          decodeRouteParam((await params).assignmentId, "assignmentId"),
          await readBoundedJson(request, 32768),
        ),
      ),
    (error) => assignmentQuestionExternalError(error, endpoint),
  );
}
