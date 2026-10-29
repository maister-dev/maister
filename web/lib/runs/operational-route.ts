import "server-only";

import type { NextRequest } from "next/server";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  acknowledgeOperationalAttention,
  retryOperationalCleanup,
} from "@/lib/runs/operational-attention";

const acknowledgement = z
  .object({
    reason: z.enum(["operation_failure", "cleanup_failure"]),
    revision: z.number().int().positive().max(2147483647),
  })
  .strict();
const retry = z
  .object({ expectedRevision: z.number().int().positive().max(2147483647) })
  .strict();

export async function acknowledgeOperationalRoute(
  req: NextRequest,
  runId: string,
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const body = acknowledgement.safeParse(await req.json().catch(() => null));

    if (!body.success)
      return NextResponse.json(
        { code: "CONFIG", message: "invalid operational acknowledgement" },
        { status: 400 },
      );
    const db = getDb();
    const [run] = await db
      .select({ projectId: runs.projectId })
      .from(runs)
      .where(eq(runs.id, runId));

    if (!run?.projectId)
      return NextResponse.json(
        { code: "PRECONDITION", message: "run not found" },
        { status: 404 },
      );
    await requireProjectAction(run.projectId, "answerHitl");

    return NextResponse.json(
      await acknowledgeOperationalAttention(db, {
        runId,
        userId: user.id,
        ...body.data,
      }),
    );
  } catch (error) {
    return operationalRouteError(error);
  }
}

export async function retryOperationalRoute(
  req: NextRequest,
  runId: string,
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const body = retry.safeParse(await req.json().catch(() => null));

    if (!body.success)
      return NextResponse.json(
        { code: "CONFIG", message: "invalid operational cleanup revision" },
        { status: 400 },
      );
    const db = getDb();
    const [run] = await db
      .select({ projectId: runs.projectId })
      .from(runs)
      .where(eq(runs.id, runId));

    if (!run?.projectId)
      return NextResponse.json(
        { code: "PRECONDITION", message: "run not found" },
        { status: 404 },
      );
    await requireProjectAction(run.projectId, "recoverRun");
    const cleanup = await retryOperationalCleanup(db, {
      runId,
      userId: user.id,
      ...body.data,
    });

    return NextResponse.json(
      {
        state: cleanup.state,
        revision: cleanup.revision,
        attempts: cleanup.attempts,
        dueAt: cleanup.dueAt,
        errorCode: cleanup.errorCode,
        evidenceIds: cleanup.evidenceIds,
      },
      { status: 202 },
    );
  } catch (error) {
    return operationalRouteError(error);
  }
}

function operationalRouteError(error: unknown): NextResponse {
  if (isMaisterError(error))
    return NextResponse.json(
      { code: error.code, message: error.message },
      {
        status:
          error.code === "UNAUTHENTICATED"
            ? 401
            : [
                  "UNAUTHORIZED",
                  "ACCOUNT_INACTIVE",
                  "PASSWORD_CHANGE_REQUIRED",
                ].includes(error.code)
              ? 403
              : error.code === "CONFLICT" || error.code === "PRECONDITION"
                ? 409
                : 500,
      },
    );
  throw error;
}
