import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authorizeCatalogRouteProject } from "@/lib/catalog/route-auth";
import { catalogErrorResponse } from "@/lib/catalog/route-errors";
import { seedAuthoredDraftFromRevision } from "@/lib/catalog/seed-from-revision";
import { isMaisterError } from "@/lib/errors";

type RouteContext = {
  params: Promise<{ slug: string; flowRefId: string; revisionId: string }>;
};

// Names the NEW authored capability ONLY — no filesystem path, no cross-resource
// locator. `installedPath` is resolved server-side from the DB row, never here.
const forkBodySchema = z
  .object({
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9._-]*$/)
      .optional(),
    title: z.string().min(1).optional(),
  })
  .strict();

async function readForkBody(
  req: NextRequest,
): Promise<z.infer<typeof forkBodySchema>> {
  const text = await req.text();

  if (text.trim().length === 0) return {};

  return forkBodySchema.parse(JSON.parse(text));
}

/**
 * T2.2 — POST: fork an INSTALLED (immutable) flow revision into an editable
 * authored `flow` draft carrying `source_flow_ref_id` lineage.
 *
 * Identifiers: `slug` + `flowRefId` + `revisionId` are url-params resolved to
 * server state (the revision is asserted ∈ flow ∈ project by the service).
 * RBAC: `manageCatalog` (project admin) via `authorizeCatalogRouteProject`.
 * The response is an explicit DTO — `{ capId, projectSlug, slug }` — never a DB
 * row, `installedPath`, or manifest blob.
 */
export async function POST(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { slug, flowRefId, revisionId } = await ctx.params;

    await authorizeCatalogRouteProject(slug);
    const body = await readForkBody(req);

    let result;

    try {
      result = await seedAuthoredDraftFromRevision({
        projectSlug: slug,
        flowRefId,
        revisionId,
        slug: body.slug,
        title: body.title,
      });
    } catch (err) {
      // The project was already authorized above, so a not-found PRECONDITION
      // from the service (unknown/foreign flowRefId or revisionId) is a missing
      // resource → 404. CONFLICT (explicit slug collision → 409) and CONFIG
      // (missing bundle → 422) fall through to `catalogErrorResponse`.
      if (isMaisterError(err) && err.code === "PRECONDITION") {
        return NextResponse.json(
          { code: err.code, message: err.message },
          { status: 404 },
        );
      }
      throw err;
    }

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}
