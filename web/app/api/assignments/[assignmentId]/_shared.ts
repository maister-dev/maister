import "server-only";

import type { Logger } from "pino";
import type { NextRequest, NextResponse } from "next/server";
import type { ActorIdentity, Assignment } from "@/lib/db/schema";

import { eq, inArray } from "drizzle-orm";
import { NextResponse as Response } from "next/server";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { ensureUserActor } from "@/lib/assignments/service";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants — pg|sqlite union.
const { actorIdentities, assignments } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): shared route helper accepts both pg and sqlite drizzle clients.
type Db = any;

export type RouteParams = { params: Promise<{ assignmentId: string }> };

export type AssignmentActionDto = {
  id: string;
  projectId: string;
  runId: string;
  taskId: string | null;
  nodeId: string | null;
  stepId: string | null;
  hitlRequestId: string | null;
  actionKind: Assignment["actionKind"];
  status: Assignment["status"];
  roleRefs: string[];
  title: string;
  branch: string | null;
  ref: string | null;
  staleEvidenceSummary: Record<string, unknown> | null;
  claimedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  assigneeActor: {
    id: string;
    kind: ActorIdentity["kind"];
    label: string;
  } | null;
};

export type AssignmentActionContext = {
  req: NextRequest;
  db: Db;
  assignmentId: string;
  assignment: Assignment;
  actor: ActorIdentity;
};

const optionalReasonSchema = z.object({
  reason: z.string().min(1).max(1000).optional(),
});

export async function readOptionalReason(
  req: NextRequest,
): Promise<string | undefined> {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return undefined;
  }

  const body = await req.json();
  const parsed = optionalReasonSchema.safeParse(body);

  if (!parsed.success) {
    throw new MaisterError(
      "CONFIG",
      `invalid assignment action body: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }

  return parsed.data.reason;
}

export function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFLICT":
    case "PRECONDITION":
      return 409;
    case "CONFIG":
      return 422;
    default:
      return 500;
  }
}

function errorResponse(
  err: unknown,
  ctx: { assignmentId: string; actionName: string; log: Logger },
): NextResponse {
  if (isMaisterError(err)) {
    const status = httpStatusForCode(err.code);

    ctx.log.warn(
      {
        assignmentId: ctx.assignmentId,
        code: err.code,
        message: err.message,
        status,
      },
      `${ctx.actionName} error`,
    );

    return Response.json(
      { code: err.code, message: err.message },
      { status },
    );
  }

  const message = err instanceof Error ? err.message : String(err);

  ctx.log.error(
    { assignmentId: ctx.assignmentId, err: message },
    `${ctx.actionName} unhandled error`,
  );

  return Response.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

async function loadAssignment(
  db: Db,
  assignmentId: string,
): Promise<Assignment | null> {
  const [assignment] = await db
    .select()
    .from(assignments)
    .where(eq(assignments.id, assignmentId));

  return (assignment as Assignment | undefined) ?? null;
}

export async function dtosForAssignments(
  db: Db,
  assignmentRows: readonly Assignment[],
): Promise<AssignmentActionDto[]> {
  const actorIds = [
    ...new Set(
      assignmentRows
        .map((assignment) => assignment.assigneeActorId)
        .filter((actorId): actorId is string => actorId !== null),
    ),
  ];
  const actorRows =
    actorIds.length === 0
      ? []
      : ((await db
          .select({
            id: actorIdentities.id,
            kind: actorIdentities.kind,
            label: actorIdentities.label,
          })
          .from(actorIdentities)
          .where(inArray(actorIdentities.id, actorIds))) as Array<
          NonNullable<AssignmentActionDto["assigneeActor"]>
        >);
  const actorsById = new Map(actorRows.map((actor) => [actor.id, actor]));

  return assignmentRows.map((assignment) => ({
    id: assignment.id,
    projectId: assignment.projectId,
    runId: assignment.runId,
    taskId: assignment.taskId,
    nodeId: assignment.nodeId,
    stepId: assignment.stepId,
    hitlRequestId: assignment.hitlRequestId,
    actionKind: assignment.actionKind,
    status: assignment.status,
    roleRefs: assignment.roleRefs,
    title: assignment.title,
    branch: assignment.branch,
    ref: assignment.ref,
    staleEvidenceSummary: assignment.staleEvidenceSummary ?? null,
    claimedAt: assignment.claimedAt?.toISOString() ?? null,
    completedAt: assignment.completedAt?.toISOString() ?? null,
    createdAt: assignment.createdAt.toISOString(),
    updatedAt: assignment.updatedAt.toISOString(),
    assigneeActor:
      assignment.assigneeActorId === null
        ? null
        : (actorsById.get(assignment.assigneeActorId) ?? null),
  }));
}

export async function dtoForAssignment(
  db: Db,
  assignment: Assignment,
): Promise<AssignmentActionDto> {
  const [dto] = await dtosForAssignments(db, [assignment]);

  return dto;
}

export async function handleAssignmentAction(args: {
  req: NextRequest;
  routeParams: RouteParams;
  actionName: string;
  log: Logger;
  run: (ctx: AssignmentActionContext) => Promise<Assignment>;
}): Promise<NextResponse> {
  const { assignmentId } = await args.routeParams.params;

  try {
    const sessionUser = await requireActiveSession();
    const db = getDb() as Db;
    const assignment = await loadAssignment(db, assignmentId);

    if (assignment === null) {
      return Response.json(
        {
          code: "PRECONDITION",
          message: `assignment not found: ${assignmentId}`,
        },
        { status: 404 },
      );
    }

    await requireProjectAction(assignment.projectId, "answerHitl");

    const actor = await ensureUserActor({
      db,
      projectId: assignment.projectId,
      userId: sessionUser.id,
      label: sessionUser.name ?? sessionUser.email ?? sessionUser.id,
    });
    const changed = await args.run({
      req: args.req,
      db,
      assignmentId,
      assignment,
      actor,
    });

    args.log.info(
      {
        assignmentId,
        projectId: changed.projectId,
        runId: changed.runId,
        actorId: actor.id,
        status: changed.status,
      },
      args.actionName,
    );

    return Response.json(await dtoForAssignment(db, changed), { status: 200 });
  } catch (err) {
    return errorResponse(err, {
      assignmentId,
      actionName: args.actionName,
      log: args.log,
    });
  }
}
