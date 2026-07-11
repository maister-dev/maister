import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { notFoundResponse } from "@/lib/api/project-route-helpers";
import { requireGlobalRole } from "@/lib/authz";
import { getLocalPackage } from "@/lib/local-packages/service";
import { syncFromUpstream } from "@/lib/local-packages/sync";
import { packageErrorResponse } from "@/lib/packages/http";

// ADR-129 §d: start (or window-1 Resume — the same-target re-POST) an
// upstream sync. `id` is a url-param (→ server row → working_dir);
// `targetInstallId` is a body id resolved to a server row and validated
// against the lineage (same package name + source URL) INSIDE the lib —
// never used as a raw path. Preconditions, crash windows, and the two-phase
// order live in `lib/local-packages/sync.ts`.
type RouteParams = { params: Promise<{ id: string }> };

const bodySchema = z
  .object({
    sessionId: z.string().min(1),
    targetInstallId: z.string().min(1),
  })
  .strict();

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireGlobalRole("member");
    const { id } = await params;
    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));

    if (!parsed.success) {
      return NextResponse.json(
        {
          code: "CONFIG",
          message: parsed.error.issues[0]?.message ?? "bad body",
        },
        { status: 422 },
      );
    }

    const pkg = await getLocalPackage(id);

    if (!pkg || pkg.status !== "active") {
      return notFoundResponse("local package not found");
    }

    const result = await syncFromUpstream({
      localPackageId: id,
      targetInstallId: parsed.data.targetInstallId,
      sessionId: parsed.data.sessionId,
    });

    return NextResponse.json(result);
  } catch (err) {
    return packageErrorResponse(err, "studio/local-packages/[id]/sync POST");
  }
}
