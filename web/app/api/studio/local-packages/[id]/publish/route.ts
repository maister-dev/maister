import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { errorResponse } from "@/lib/api/project-route-helpers";
import { requireGlobalRole } from "@/lib/authz";
import {
  getPublishOptions,
  publishLocalPackage,
} from "@/lib/local-packages/publish";

const log = pino({
  name: "api/studio/local-packages/[id]/publish",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ id: string }> };

const bodySchema = z
  .object({
    targetSourceId: z.string().min(1),
    branchName: z.string().min(1).max(255),
  })
  .strict();

// The publish dialog feed: the registered package sources (allow-list), the
// preselected source mapped from the package's fork origin, and the prefilled
// stable `maister/<slug>` branch. Member-gated (Studio authoring surface).
export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireGlobalRole("member");
    const { id } = await params;

    return NextResponse.json(await getPublishOptions(id));
  } catch (err) {
    return errorResponse(err, log, "studio/local-packages/[id]/publish GET");
  }
}

// PR-to-source publish (ADR-113). `id` is a url-param (→ server row → working
// dir). `targetSourceId` is validated against the registered `package_sources`
// allow-list server-side (never a body URL); `branchName` is charset-validated at
// the git sink. Two-phase: the push side-effect precedes the marker persistence.
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireGlobalRole("member");
    const { id } = await params;
    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));

    if (!parsed.success) {
      return NextResponse.json(
        {
          code: "CONFIG",
          message: parsed.error.issues[0]?.message ?? "bad body",
        },
        { status: 422 },
      );
    }

    const result = await publishLocalPackage(id, {
      targetSourceId: parsed.data.targetSourceId,
      branchName: parsed.data.branchName,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return errorResponse(err, log, "studio/local-packages/[id]/publish POST");
  }
}
