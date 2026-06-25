import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import {
  errorResponse,
  notFoundResponse,
} from "@/lib/api/project-route-helpers";
import { requireGlobalRole } from "@/lib/authz";
import { assertHoldsLock } from "@/lib/local-packages/lock";
import { getLocalPackage } from "@/lib/local-packages/service";
import { sendLocalPackageAssistantMessage } from "@/lib/scratch-runs/service";

const log = pino({
  name: "api/studio/local-packages/[id]/assistant/[runId]/messages",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ id: string; runId: string }> };

const bodySchema = z
  .object({
    sessionId: z.string().trim().min(1),
    content: z.string().trim().min(1).max(60_000),
    attachments: z.array(z.unknown()).max(0).optional(),
    intent: z.enum(["auto", "ask", "edit"]).default("auto"),
    focus: z
      .object({
        path: z.string().trim().min(1).max(512).optional(),
        selectedNodeId: z.string().trim().min(1).max(256).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

function badBody(message: string): NextResponse {
  return NextResponse.json({ code: "CONFIG", message }, { status: 422 });
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireGlobalRole("member");
    const { id, runId } = await params;
    const parsed = bodySchema.safeParse(await req.json());

    if (!parsed.success) {
      return badBody(parsed.error.issues[0]?.message ?? "bad body");
    }

    const pkg = await getLocalPackage(id);

    if (!pkg || pkg.status !== "active") {
      return notFoundResponse("local package not found");
    }

    await assertHoldsLock(id, parsed.data.sessionId);

    const result = await sendLocalPackageAssistantMessage({
      runId,
      body: {
        localPackageId: id,
        sessionId: parsed.data.sessionId,
        content: parsed.data.content,
        intent: parsed.data.intent,
        focus: parsed.data.focus,
      },
    });

    log.info(
      {
        localPackageId: id,
        runId,
        dialogStatus: result.dialogStatus,
        actionStatus: result.actionResult?.status ?? null,
      },
      "[localPkg.assistant] message sent",
    );

    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(
      err,
      log,
      "studio/local-packages/[id]/assistant/[runId]/messages POST",
    );
  }
}
