import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { notFoundResponse } from "@/lib/api/project-route-helpers";
import { requireGlobalRole } from "@/lib/authz";
import { getLocalPackage } from "@/lib/local-packages/service";
import { resolveSync } from "@/lib/local-packages/sync";
import { packageErrorResponse } from "@/lib/packages/http";

// ADR-129 §d: complete a conflicted (or window-2 crashed) sync. The lib
// scans the UNION of the stamped conflicted files and every dirty file for
// remaining markers, commits with `commitMessage` when the tree is still
// uncommitted, then advances lineage + clears `sync_state` in ONE tx.
// Idempotent retry after completion → 200 no-op.
type RouteParams = { params: Promise<{ id: string }> };

const bodySchema = z
  .object({
    sessionId: z.string().min(1),
    commitMessage: z.string().min(1).max(500).optional(),
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

    const result = await resolveSync({
      localPackageId: id,
      sessionId: parsed.data.sessionId,
      commitMessage: parsed.data.commitMessage,
    });

    return NextResponse.json(result);
  } catch (err) {
    return packageErrorResponse(
      err,
      "studio/local-packages/[id]/sync/resolve POST",
    );
  }
}
