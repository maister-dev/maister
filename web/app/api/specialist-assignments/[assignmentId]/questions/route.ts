import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { decodeRouteParam } from "@/lib/route-params";
import { createOrActivateAssignmentQuestion } from "@/lib/services/assignment-question";
import {
  assignmentQuestionJson,
  assignmentQuestionError,
} from "@/lib/specialist-assignments/question-http";

type RouteParams = { params: Promise<{ assignmentId: string }> };
const endpoint = "POST /api/specialist-assignments/[assignmentId]/questions";

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();

    return assignmentQuestionJson(
      await createOrActivateAssignmentQuestion(
        getDb(),
        { kind: "user", userId: user.id },
        decodeRouteParam((await params).assignmentId, "assignmentId"),
        await readBoundedJson(request, 32768),
      ),
    );
  } catch (error) {
    return assignmentQuestionError(error, endpoint);
  }
}
