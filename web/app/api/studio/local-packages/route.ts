import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { errorResponse } from "@/lib/api/project-route-helpers";
import { requireActiveSession, requireGlobalRole } from "@/lib/authz";
import { createLocalPackageWithFlowSchema } from "@/lib/local-packages/create-flow-contract";
import {
  createLocalPackageWithFlow,
  listLocalPackages,
  toLocalPackageDto,
} from "@/lib/local-packages/service";

// (ADR-096) Local-package CRUD list/create. Create is member-level authoring
// (requireGlobalRole); listing requires an active session. `working_dir` is
// never projected.
const log = pino({
  name: "api/studio/local-packages",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function GET(): Promise<NextResponse> {
  try {
    await requireActiveSession();
    const rows = await listLocalPackages();

    return NextResponse.json({ localPackages: rows.map(toLocalPackageDto) });
  } catch (err) {
    return errorResponse(err, log, "studio/local-packages GET");
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireGlobalRole("member");
    const parsed = createLocalPackageWithFlowSchema.safeParse(await req.json());

    if (!parsed.success) {
      return NextResponse.json(
        {
          code: "CONFIG",
          message: parsed.error.issues[0]?.message ?? "bad body",
        },
        { status: 422 },
      );
    }

    const created = await createLocalPackageWithFlow({
      name: parsed.data.name,
      createdBy: user.id,
      flow: parsed.data.flow,
    });

    return NextResponse.json(
      {
        localPackage: toLocalPackageDto(created.package),
        createdFlow: { id: parsed.data.flow.id, path: created.flowPath },
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err, log, "studio/local-packages POST");
  }
}
