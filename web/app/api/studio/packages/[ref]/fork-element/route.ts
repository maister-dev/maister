import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import {
  errorResponse,
  notFoundResponse,
} from "@/lib/api/project-route-helpers";
import { requireSession } from "@/lib/authz";
import { forkElementToNewLocal } from "@/lib/local-packages/fork";
import { resolveStudioPackageByRef } from "@/lib/studio/load";

const log = pino({
  name: "api/studio/packages/[ref]/fork-element",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ ref: string }> };

const bodySchema = z
  .object({
    elementPath: z.string().min(1).max(1024),
    elementName: z.string().min(1).max(200),
  })
  .strict();

// (M39 A3) `ref` (url-param) resolves server-side to its newest install.
// `elementPath`/`elementName` are body-controlled: `elementPath` is confined
// inside the source bundle by the service before any fs copy; `elementName` is a
// display name only. Forks EXACTLY ONE element into a NEW centralized local
// package (no project target — the centralized model). Studio authoring is
// member-accessible → requireSession.
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const user = await requireSession();
    const { ref } = await params;
    const parsed = bodySchema.safeParse(await req.json());

    if (!parsed.success) {
      return NextResponse.json(
        {
          code: "CONFIG",
          message: parsed.error.issues[0]?.message ?? "bad body",
        },
        { status: 422 },
      );
    }

    const resolution = await resolveStudioPackageByRef(user.id, user.role, ref);

    if (resolution.status === "not-found") {
      return notFoundResponse("package not found");
    }
    if (resolution.status === "ambiguous" || !resolution.installId) {
      return notFoundResponse("package ref is ambiguous");
    }

    const result = await forkElementToNewLocal({
      sourceInstallId: resolution.installId,
      elementPath: parsed.data.elementPath,
      elementName: parsed.data.elementName,
      createdBy: user.id,
    });

    log.info(
      {
        ref,
        elementPath: parsed.data.elementPath,
        localPackageId: result.localPackageId,
      },
      "element forked to new local package",
    );

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err, log, "studio/packages/[ref]/fork-element POST");
  }
}
