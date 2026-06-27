import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { loadActiveRunSession } from "@/lib/runs/active-run-session";
import {
  gateChatAvailability,
  listGateChatMessages,
  sendGateChatTurn,
} from "@/lib/services/gate-chat";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { hitlRequests, runs } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-hitl-chat",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = {
  params: Promise<{ runId: string; hitlRequestId: string }>;
};

// X-IDENT: both resource locators are url-params; the body carries ONLY the
// reviewer's message (never templated, never a locator).
const bodySchema = z.object({
  message: z.string().min(1).max(100_000),
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
    case "CHECKPOINT":
    case "ACP_PROTOCOL":
      return 502;
    default:
      return 500;
  }
}

async function loadRunAndHitl(
  db: { select: any },
  runId: string,
  hitlRequestId: string,
) {
  const [runRows, hitlRows] = await Promise.all([
    db.select().from(runs).where(eq(runs.id, runId)),
    db.select().from(hitlRequests).where(eq(hitlRequests.id, hitlRequestId)),
  ]);

  return { run: runRows[0] ?? null, hitl: hitlRows[0] ?? null };
}

function errorResponse(
  err: unknown,
  ctx: { runId: string; hitlRequestId: string },
): NextResponse {
  if (isMaisterError(err)) {
    log.warn(
      { ...ctx, code: err.code, message: err.message },
      "[gate-chat] refused",
    );

    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ ...ctx, err: message }, "[gate-chat] unhandled");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId, hitlRequestId } = await params;

  try {
    await requireActiveSession();

    const db = getDb() as unknown as { select: any };
    const { run, hitl } = await loadRunAndHitl(db, runId, hitlRequestId);

    if (!run || !hitl || hitl.runId !== runId) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    // ADR-078: chat transcripts are HITL content — member+ (answerHitl), the
    // same bar as POST; a viewer's panel degrades to its empty initial state.
    await requireProjectAction(run.projectId, "answerHitl");

    const activeSession = await loadActiveRunSession(db, runId);
    const availability = gateChatAvailability({
      runStatus: run.status,
      hitlKind: hitl.kind,
      hitlRespondedAt: hitl.respondedAt,
      acpSessionId: activeSession?.acpSessionId ?? null,
    });
    const messages = await listGateChatMessages({ runId, hitlRequestId });

    return NextResponse.json({
      runId,
      hitlRequestId,
      availability,
      // DD3: the idle case pays the ~$0.28 respawn — surfaced before the
      // first idle question.
      idleResumeCost: run.status === "NeedsInputIdle",
      messages,
    });
  } catch (err) {
    return errorResponse(err, { runId, hitlRequestId });
  }
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId, hitlRequestId } = await params;

  try {
    const user = await requireActiveSession();

    const db = getDb() as unknown as { select: any };
    const { run, hitl } = await loadRunAndHitl(db, runId, hitlRequestId);

    if (!run || !hitl || hitl.runId !== runId) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    await requireProjectAction(run.projectId, "answerHitl");

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));

    if (!parsed.success) {
      return NextResponse.json(
        { code: "CONFIG", message: "invalid body — expected {message}" },
        { status: 400 },
      );
    }

    const result = await sendGateChatTurn({
      runId,
      hitlRequestId,
      message: parsed.data.message,
      actorUserId: user.id,
      actorLabel: user.name ?? user.email ?? "user",
    });

    return NextResponse.json({
      runId,
      hitlRequestId,
      userMessage: result.userMessage,
      agentMessage: result.agentMessage,
      resumed: result.resumed,
    });
  } catch (err) {
    return errorResponse(err, { runId, hitlRequestId });
  }
}
