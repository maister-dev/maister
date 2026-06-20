import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import {
  errorResponse,
  notFoundResponse,
} from "@/lib/api/project-route-helpers";
import { requireSession } from "@/lib/authz";
import { forkPackageToLocal } from "@/lib/local-packages/fork";
import { resolveStudioPackageByRef } from "@/lib/studio/load";

const log = pino({
  name: "api/studio/packages/[ref]/fork",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ ref: string }> };

// `ref` is the package name (url-param). It is resolved server-side to its
// newest install (resolveStudioPackageByRef); the body controls NOTHING here.
// Studio authoring is member-accessible — fork needs only requireSession.
export async function POST(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const user = await requireSession();
    const { ref } = await params;
    const resolution = await resolveStudioPackageByRef(user.id, user.role, ref);

    if (resolution.status === "not-found") {
      return notFoundResponse("package not found");
    }
    if (resolution.status === "ambiguous" || !resolution.installId) {
      return notFoundResponse("package ref is ambiguous");
    }

    const result = await forkPackageToLocal({
      sourceInstallId: resolution.installId,
      sourceRef: ref,
      createdBy: user.id,
    });

    log.info(
      { ref, localPackageId: result.localPackageId },
      "package forked to local",
    );

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err, log, "studio/packages/[ref]/fork POST");
  }
}
