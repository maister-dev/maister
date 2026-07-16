import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import {
  errorResponse,
  notFoundResponse,
} from "@/lib/api/project-route-helpers";
import { requireGlobalRole } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import { assertUserHoldsLock } from "@/lib/local-packages/lock";
import {
  getLocalPackage,
  recoverLocalPackageCreation,
} from "@/lib/local-packages/service";

const log = pino({
  name: "api/studio/local-packages/[id]/creation-recovery",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ id: string }> };

async function requestHasBody(req: NextRequest): Promise<boolean> {
  return (await req.text()).trim().length > 0;
}

// Recovery deliberately accepts no payload: it can only reconcile the
// server-owned package id with the private, durable operation journal. For an
// interrupted add-flow it requires that the caller still owns a live edit lock;
// an interrupted first-flow is limited to its creator (or a global admin).
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const user = await requireGlobalRole("member");
    const { id } = await params;

    if (await requestHasBody(req)) {
      return NextResponse.json(
        { code: "CONFIG", message: "this recovery endpoint does not accept a request body" },
        { status: 422 },
      );
    }

    const pkg = await getLocalPackage(id);

    if (!pkg || pkg.status !== "active") {
      return notFoundResponse("local package not found");
    }

    if (pkg.creationState?.kind === "add_flow") {
      await assertUserHoldsLock(id, user.id);
    }
    if (
      pkg.creationState?.kind === "create_package_with_flow" &&
      pkg.createdBy !== user.id &&
      user.role !== "admin"
    ) {
      throw new MaisterError(
        "UNAUTHORIZED",
        "only the package creator or an administrator can recover its initial Flow creation",
      );
    }

    const recovered = await recoverLocalPackageCreation(id);

    return NextResponse.json({ recoveryStatus: recovered.recoveryStatus });
  } catch (err) {
    return errorResponse(
      err,
      log,
      "studio/local-packages/[id]/creation-recovery POST",
    );
  }
}
