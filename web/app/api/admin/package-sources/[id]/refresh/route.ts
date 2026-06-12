import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { requireGlobalRole } from "@/lib/authz";
import { refreshPackageSource } from "@/lib/packages/catalog";
import { notFound, packageErrorResponse } from "@/lib/packages/http";

// (ADR-088) Discovery refresh: ls-remote tags + shallow manifest scan. A git
// failure is a RESULT (degraded: true, stale snapshot kept), not an error.
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;

  try {
    await requireGlobalRole("admin");
    const result = await refreshPackageSource({ id });

    if (result === null) return notFound(`package source not found: ${id}`);

    return NextResponse.json({
      ok: true,
      degraded: result.degraded,
      packages: result.packages,
    });
  } catch (err) {
    return packageErrorResponse(err, "admin/package-sources refresh");
  }
}
