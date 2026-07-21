import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { notFoundResponse } from "@/lib/api/project-route-helpers";
import {
  acquireLock,
  isLockableCapability,
  refreshLock,
} from "@/lib/catalog/authored-lock";
import { authorizeCatalogRouteProject } from "@/lib/catalog/route-auth";
import { catalogErrorResponse } from "@/lib/catalog/route-errors";

// (ADR-149) Editor keep-alive for the authored-capability editor. `acquire`
// takes the lock iff free/this-session/this-user/expired — a foreign live lock
// comes back as heldByMe=false, not a 409, because that is a state the editor
// renders read-only. A failed `refresh` IS a 409: that session was expired or
// taken over.
type RouteContext = {
  params: Promise<{ slug: string; capId: string }>;
};

// `sessionId` is an opaque bearer token compared against the server-held lock
// column — never a lookup key. The project and capability come from the URL.
const bodySchema = z
  .object({
    sessionId: z.string().min(1).max(200),
    mode: z.enum(["acquire", "refresh"]).default("acquire"),
  })
  .strict();

export async function POST(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { slug, capId } = await ctx.params;
    const { projectId, userId } = await authorizeCatalogRouteProject(slug);
    const parsed = bodySchema.parse(await req.json());

    if (!(await isLockableCapability(projectId, capId))) {
      return notFoundResponse("authored capability not found");
    }

    const lock =
      parsed.mode === "refresh"
        ? await refreshLock(capId, parsed.sessionId)
        : await acquireLock(capId, userId, parsed.sessionId);

    return NextResponse.json(lock, { status: 200 });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}
