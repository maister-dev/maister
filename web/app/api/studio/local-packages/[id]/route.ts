import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import {
  errorResponse,
  notFoundResponse,
} from "@/lib/api/project-route-helpers";
import { requireActiveSession, requireGlobalRole } from "@/lib/authz";
import { readLockState } from "@/lib/local-packages/lock";
import {
  deleteLocalPackage,
  getLocalPackage,
  listFiles,
  renameLocalPackage,
  setLocalPackageStatus,
  toLocalPackageDto,
} from "@/lib/local-packages/service";

const log = pino({
  name: "api/studio/local-packages/[id]",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ id: string }> };

const patchBodySchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    status: z.enum(["active", "archived"]).optional(),
  })
  .strict();

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireActiveSession();
    const { id } = await params;
    const pkg = await getLocalPackage(id);

    if (!pkg || pkg.status !== "active") {
      return notFoundResponse("local package not found");
    }

    const session = req.nextUrl.searchParams.get("session") ?? "";
    const [files, lock] = await Promise.all([
      listFiles(pkg),
      readLockState(id, session),
    ]);

    return NextResponse.json({
      localPackage: toLocalPackageDto(pkg),
      files,
      lock,
    });
  } catch (err) {
    return errorResponse(err, log, "studio/local-packages/[id] GET");
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireGlobalRole("member");
    const { id } = await params;
    const parsed = patchBodySchema.safeParse(await req.json());

    if (!parsed.success) {
      return NextResponse.json(
        {
          code: "CONFIG",
          message: parsed.error.issues[0]?.message ?? "bad body",
        },
        { status: 422 },
      );
    }

    let row = await getLocalPackage(id);

    if (!row || row.status !== "active") {
      return notFoundResponse("local package not found");
    }

    if (parsed.data.name !== undefined) {
      row = await renameLocalPackage(id, parsed.data.name);
    }
    if (parsed.data.status !== undefined) {
      row = await setLocalPackageStatus(id, parsed.data.status);
    }
    if (!row) return notFoundResponse("local package not found");

    return NextResponse.json(toLocalPackageDto(row));
  } catch (err) {
    return errorResponse(err, log, "studio/local-packages/[id] PATCH");
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireGlobalRole("member");
    const { id } = await params;

    await deleteLocalPackage(id);

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err, log, "studio/local-packages/[id] DELETE");
  }
}
