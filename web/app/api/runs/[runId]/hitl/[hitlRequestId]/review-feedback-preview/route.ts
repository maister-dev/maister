import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  assertReviewFeedbackPresent,
  buildReviewFeedbackPreview,
} from "@/lib/review-comments/feedback-packet";
import { assertNoActiveGateChatTurn } from "@/lib/services/gate-chat";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { hitlRequests, runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): route tests use a minimal drizzle-like fake DB.
type Db = any;

const log = pino({
  name: "api-review-feedback-preview",
  level: process.env.LOG_LEVEL ?? "info",
});

const bodySchema = z.object({ response: z.unknown() }).strict();

type RouteParams = {
  params: Promise<{ runId: string; hitlRequestId: string }>;
};

function statusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "NEEDS_INPUT":
      return 422;
    case "CONFIG":
      return 400;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    default:
      return 500;
  }
}

function errorResponse(
  err: unknown,
  ids: { runId: string; hitlRequestId: string },
): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: statusForCode(err.code) },
    );
  }

  log.error(
    {
      ...ids,
      err: err instanceof Error ? err.message : String(err),
    },
    "review feedback preview failed",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId, hitlRequestId } = await params;

  try {
    await requireActiveSession();
    const parsed = bodySchema.safeParse(await req.json());

    if (!parsed.success || !Object.hasOwn(parsed.data, "response")) {
      throw new MaisterError(
        "CONFIG",
        "preview body must contain only response",
      );
    }

    const db = getDb() as Db;
    const runRows = await db.select().from(runs).where(eq(runs.id, runId));
    const run = runRows[0];

    if (!run) {
      throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
    }
    await requireProjectAction(run.projectId, "answerHitl");

    const hitlRows = await db
      .select()
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.id, hitlRequestId),
          eq(hitlRequests.runId, runId),
          eq(hitlRequests.kind, "human"),
          isNull(hitlRequests.response),
          isNull(hitlRequests.respondedAt),
        ),
      );
    const hitl = hitlRows[0];

    if (!hitl) {
      throw new MaisterError(
        "PRECONDITION",
        "review gate is closed or does not belong to this run",
      );
    }
    if (run.status !== "NeedsInput" && run.status !== "NeedsInputIdle") {
      throw new MaisterError(
        "PRECONDITION",
        `run is not awaiting review feedback (status=${run.status})`,
      );
    }

    await assertNoActiveGateChatTurn(db, hitlRequestId);

    const preview = await buildReviewFeedbackPreview({
      db,
      runId,
      hitlRequestId,
      response: parsed.data.response,
    });

    assertReviewFeedbackPresent({
      packet: preview.feedback,
      schema: hitl.schema,
      response: parsed.data.response,
    });

    log.debug(
      {
        runId,
        hitlRequestId,
        nodeId: preview.feedback.target.nodeId,
        threadCount: preview.feedback.openThreadIds.length,
        resolvedThreadCount: preview.feedback.resolvedThreadCount,
        gateChatMessageCount: preview.feedback.gateChatMessageCount,
        sourceFingerprint: preview.reviewSource.fingerprint,
        feedbackFingerprint: preview.feedback.fingerprint,
      },
      "review feedback preview created",
    );

    return NextResponse.json(preview, { status: 200 });
  } catch (err) {
    return errorResponse(err, { runId, hitlRequestId });
  }
}
