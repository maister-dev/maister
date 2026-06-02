import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import pino from "pino";

import { releaseAssignment } from "@/lib/assignments/service";

import {
  handleAssignmentAction,
  readOptionalReason,
  type RouteParams,
} from "../_shared";

const log = pino({
  name: "api-assignment-release",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function POST(
  req: NextRequest,
  routeParams: RouteParams,
): Promise<NextResponse> {
  return handleAssignmentAction({
    req,
    routeParams,
    actionName: "assignment released",
    log,
    run: async ({ db, assignmentId, actor, req: actionReq }) =>
      releaseAssignment({
        db,
        assignmentId,
        actorId: actor.id,
        reason: await readOptionalReason(actionReq),
      }),
  });
}
