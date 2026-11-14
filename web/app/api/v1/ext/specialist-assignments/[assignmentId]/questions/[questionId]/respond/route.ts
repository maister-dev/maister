import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { privateJson } from "@/lib/api/private-json";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { decodeRouteParam } from "@/lib/route-params";
import { answerAssignmentQuestionToken } from "@/lib/services/assignment-question-response";
import { requirePersonalAssignmentUser } from "@/lib/specialist-assignments/external";
import { assignmentQuestionExternalError } from "@/lib/specialist-assignments/question-http";
import { handleOwnedExt } from "@/lib/tokens/owned-ext-handler";

type RouteParams = {
  params: Promise<{ assignmentId: string; questionId: string }>;
};
const endpoint =
  "POST /api/v1/ext/specialist-assignments/[assignmentId]/questions/[questionId]/respond";

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  return handleOwnedExt(
    request,
    { endpoint, scopeLabel: "assignments:answer", method: "POST" },
    async ({ actor }) => {
      requirePersonalAssignmentUser(actor);
      const selectors = await params;
      const receipt = await answerAssignmentQuestionToken(
        getDb(),
        actor.tokenId,
        decodeRouteParam(selectors.assignmentId, "assignmentId"),
        decodeRouteParam(selectors.questionId, "questionId"),
        await readBoundedJson(request, 32768),
      );

      return privateJson(receipt, receipt.idempotent ? 200 : 202);
    },
    (error) => assignmentQuestionExternalError(error, endpoint),
  );
}
