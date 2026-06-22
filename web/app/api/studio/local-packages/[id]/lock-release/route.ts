import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import {
  errorResponse,
  notFoundResponse,
} from "@/lib/api/project-route-helpers";
import { requireGlobalRole } from "@/lib/authz";
import { releaseLock } from "@/lib/local-packages/lock";
import { getLocalPackage } from "@/lib/local-packages/service";

const log = pino({
  name: "api/studio/local-packages/[id]/lock-release",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ id: string }> };

const bodySchema = z.object({ sessionId: z.string().min(1).max(200) }).strict();

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireGlobalRole("member");
    const { id } = await params;
    const parsed = bodySchema.safeParse(await req.json());

    if (!parsed.success) {
      return NextResponse.json(
        { code: "CONFIG", message: "sessionId required" },
        { status: 422 },
      );
    }

    const pkg = await getLocalPackage(id);

    if (!pkg || pkg.status !== "active") {
      return notFoundResponse("local package not found");
    }

    await releaseLock(id, parsed.data.sessionId);

    return NextResponse.json({ released: true });
  } catch (err) {
    return errorResponse(err, log, "studio/local-packages/[id]/lock-release");
  }
}
