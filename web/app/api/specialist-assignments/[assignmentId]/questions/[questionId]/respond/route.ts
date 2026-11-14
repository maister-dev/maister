import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { privateJson } from "@/lib/api/private-json";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { decodeRouteParam } from "@/lib/route-params";
import { answerAssignmentQuestion } from "@/lib/services/assignment-question-response";
import { assignmentQuestionError } from "@/lib/specialist-assignments/question-http";

type RouteParams = {
  params: Promise<{ assignmentId: string; questionId: string }>;
};
const endpoint =
  "POST /api/specialist-assignments/[assignmentId]/questions/[questionId]/respond";

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const selectors = await params;
    const receipt = await answerAssignmentQuestion(
      getDb(),
      user.id,
      decodeRouteParam(selectors.assignmentId, "assignmentId"),
      decodeRouteParam(selectors.questionId, "questionId"),
      await readBoundedJson(request, 32768),
    );

    return privateJson(receipt, receipt.idempotent ? 200 : 202);
  } catch (error) {
    return assignmentQuestionError(error, endpoint);
  }
}
