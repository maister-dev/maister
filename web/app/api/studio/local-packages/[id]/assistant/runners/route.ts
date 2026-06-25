import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";

import {
  errorResponse,
  notFoundResponse,
} from "@/lib/api/project-route-helpers";
import { requireGlobalRole } from "@/lib/authz";
import { getLocalPackage } from "@/lib/local-packages/service";
import { listLocalPackageAssistantRunners } from "@/lib/scratch-runs/service";

const log = pino({
  name: "api/studio/local-packages/[id]/assistant/runners",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(
  _req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireGlobalRole("member");
    const { id } = await params;
    const pkg = await getLocalPackage(id);

    if (!pkg || pkg.status !== "active") {
      return notFoundResponse("local package not found");
    }

    const result = await listLocalPackageAssistantRunners();

    log.debug(
      {
        localPackageId: id,
        runnerCount: result.runners.length,
        defaultRunnerId: result.defaultRunnerId,
      },
      "[localPkg.assistant] runners listed",
    );

    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(
      err,
      log,
      "studio/local-packages/[id]/assistant/runners GET",
    );
  }
}
