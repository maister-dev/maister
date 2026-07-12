import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { requireGlobalRole } from "@/lib/authz";
import {
  deletePackageSource,
  packageSourceUpdateBodySchema,
  updatePackageSource,
} from "@/lib/packages/catalog";
import { notFound, packageErrorResponse } from "@/lib/packages/http";

// (ADR-088; `baseBranch` ADR-129) `id` is a url-param resolved to the server
// row (404 on miss); mutable fields: enabled, note, baseBranch. The url and
// kind are immutable (delete + re-add).
const patchBodySchema = packageSourceUpdateBodySchema;

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;

  try {
    await requireGlobalRole("admin");
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

    const { updated } = await updatePackageSource({ id, ...parsed.data });

    if (!updated) return notFound(`package source not found: ${id}`);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return packageErrorResponse(err, "admin/package-sources PATCH");
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;

  try {
    await requireGlobalRole("admin");
    const { deleted } = await deletePackageSource({ id });

    if (!deleted) return notFound(`package source not found: ${id}`);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return packageErrorResponse(err, "admin/package-sources DELETE");
  }
}
