import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import pino from "pino";

import { takeOverAssignment } from "@/lib/assignments/service";

import {
  handleAssignmentAction,
  readOptionalReason,
  type RouteParams,
} from "../_shared";

const log = pino({
  name: "api-assignment-take-over",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function POST(
  req: NextRequest,
  routeParams: RouteParams,
): Promise<NextResponse> {
  return handleAssignmentAction({
    req,
    routeParams,
    actionName: "assignment taken over",
    log,
    run: async ({ db, assignmentId, actor, req: actionReq }) =>
      takeOverAssignment({
        db,
        assignmentId,
        actorId: actor.id,
        reason: await readOptionalReason(actionReq),
      }),
  });
}
