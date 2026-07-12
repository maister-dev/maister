import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { notFoundResponse } from "@/lib/api/project-route-helpers";
import { requireGlobalRole } from "@/lib/authz";
import { abortSync } from "@/lib/local-packages/sync";
import { getLocalPackage } from "@/lib/local-packages/service";
import { packageErrorResponse } from "@/lib/packages/http";

// ADR-132 §d: abort a pending sync — `git reset --hard HEAD` semantics
// (checkout HEAD + clean untracked; structurally safe: the tree was clean
// pre-merge) + clear `sync_state`. Never rewrites fork commits. Idempotent:
// no pending sync → no-op 200. 409 only when another working-dir op holds the
// per-package mutex.
type RouteParams = { params: Promise<{ id: string }> };

const bodySchema = z.object({ sessionId: z.string().min(1) }).strict();

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

    await abortSync({ localPackageId: id, sessionId: parsed.data.sessionId });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return packageErrorResponse(
      err,
      "studio/local-packages/[id]/sync/abort POST",
    );
  }
}
