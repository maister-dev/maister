import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { errorResponse } from "@/lib/api/project-route-helpers";
import { requireActiveSession, requireGlobalRole } from "@/lib/authz";
import {
  createLocalPackage,
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

const createBodySchema = z
  .object({
    name: z.string().min(1).max(120),
    sourceInstallId: z.string().min(1).max(120).optional(),
  })
  .strict();

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
    const parsed = createBodySchema.safeParse(await req.json());

    if (!parsed.success) {
      return NextResponse.json(
        {
          code: "CONFIG",
          message: parsed.error.issues[0]?.message ?? "bad body",
        },
        { status: 422 },
      );
    }

    const row = await createLocalPackage({
      name: parsed.data.name,
      createdBy: user.id,
      sourceInstallId: parsed.data.sourceInstallId ?? null,
    });

    return NextResponse.json(toLocalPackageDto(row), { status: 201 });
  } catch (err) {
    return errorResponse(err, log, "studio/local-packages POST");
  }
}
