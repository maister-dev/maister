import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  DIRTY_CHOICES,
  resolveDirtyWorktree,
} from "@/lib/runs/dirty-resolution";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-hitl-dirty-resolution",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = {
  params: Promise<{ runId: string; hitlRequestId: string }>;
};

// X-IDENT: both resource locators are url-params; the body carries ONLY the
// reviewer's choice, validated against the allow-list.
const bodySchema = z.object({
  choice: z.enum(DIRTY_CHOICES),
});

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 400;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    default:
      return 500;
  }
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId, hitlRequestId } = await params;

  try {
    await requireActiveSession();

    const db = getDb() as unknown as { select: any };
    const runRows = await db.select().from(runs).where(eq(runs.id, runId));
    const run = runRows[0];

    if (!run) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    await requireProjectAction(run.projectId, "answerHitl");

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));

    if (!parsed.success) {
      return NextResponse.json(
        {
          code: "CONFIG",
          message: `invalid body — expected {choice: ${DIRTY_CHOICES.join("|")}}`,
        },
        { status: 400 },
      );
    }

    const result = await resolveDirtyWorktree({
      runId,
      hitlRequestId,
      choice: parsed.data.choice,
    });

    return NextResponse.json({
      runId,
      hitlRequestId,
      choice: result.choice,
      committed: result.committed,
    });
  } catch (err) {
    if (isMaisterError(err)) {
      log.warn(
        { runId, hitlRequestId, code: err.code, message: err.message },
        "[dirty] resolution refused",
      );

      return NextResponse.json(
        { code: err.code, message: err.message },
        { status: httpStatusForCode(err.code) },
      );
    }
    const message = err instanceof Error ? err.message : String(err);

    log.error({ runId, hitlRequestId, err: message }, "[dirty] unhandled");

    return NextResponse.json(
      { code: "CRASH", message: "internal error" },
      { status: 500 },
    );
  }
}
