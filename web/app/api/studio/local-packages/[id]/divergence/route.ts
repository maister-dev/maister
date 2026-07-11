import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { notFoundResponse } from "@/lib/api/project-route-helpers";
import { requireActiveSession } from "@/lib/authz";
import { computeUpstreamDivergence } from "@/lib/local-packages/divergence";
import { getLocalPackage } from "@/lib/local-packages/service";
import { packageErrorResponse } from "@/lib/packages/http";

// ADR-129 (T17): fork-vs-source divergence, read-only like `/diff`
// (requireActiveSession, no edit lock — a second viewer may inspect it).
// `id` is a url-param (→ server row → working_dir, never client-exposed).
// `cutInstallId` is lineage-validated INSIDE computeUpstreamDivergence
// (must be a cut of this package) — a body/query id is never used as a raw
// path. `element` is a package-relative subtree filter (shape-validated
// here; unknown prefixes simply yield an empty divergence).
type RouteParams = { params: Promise<{ id: string }> };

const querySchema = z.object({
  cutInstallId: z.string().min(1).optional(),
  element: z
    .string()
    .min(1)
    .refine(
      (p) => !p.startsWith("/") && !p.split("/").includes(".."),
      "element must be a relative path without '..'",
    )
    .optional(),
});

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireActiveSession();
    const { id } = await params;
    const url = new URL(req.url);
    const parsed = querySchema.safeParse({
      cutInstallId: url.searchParams.get("cutInstallId") ?? undefined,
      element: url.searchParams.get("element") ?? undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        {
          code: "CONFIG",
          message: parsed.error.issues[0]?.message ?? "bad query",
        },
        { status: 422 },
      );
    }

    const pkg = await getLocalPackage(id);

    if (!pkg || pkg.status !== "active") {
      return notFoundResponse("local package not found");
    }

    const divergence = await computeUpstreamDivergence({
      localPackageId: id,
      cutInstallId: parsed.data.cutInstallId,
      element: parsed.data.element,
    });

    return NextResponse.json(divergence);
  } catch (err) {
    return packageErrorResponse(
      err,
      "studio/local-packages/[id]/divergence GET",
    );
  }
}
