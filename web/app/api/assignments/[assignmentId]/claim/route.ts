import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import pino from "pino";

import { handleAssignmentAction, type RouteParams } from "../_shared";

import { claimAssignment } from "@/lib/assignments/service";

const log = pino({
  name: "api-assignment-claim",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function POST(
  req: NextRequest,
  routeParams: RouteParams,
): Promise<NextResponse> {
  return handleAssignmentAction({
    req,
    routeParams,
    actionName: "assignment claimed",
    log,
    run: ({ db, assignmentId, actor }) =>
      claimAssignment({
        db,
        assignmentId,
        actorId: actor.id,
      }),
  });
}
