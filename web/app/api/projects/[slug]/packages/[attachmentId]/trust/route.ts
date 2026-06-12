import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { authorizeManagePackages } from "../../../flow-packages/_lib";

import * as schemaModule from "@/lib/db/schema";
import { trustPackageRevision } from "@/lib/packages/attach";
import { notFound, packageErrorResponse } from "@/lib/packages/http";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projectPackageAttachments } = schemaModule as unknown as Record<
  string,
  any
>;

// (ADR-087) One operator decision per package revision: trust fans to every
// member row in one tx, then pending setups run (post-commit side-effect).
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string; attachmentId: string }> },
): Promise<NextResponse> {
  const { slug, attachmentId } = await ctx.params;

  try {
    const { project, db } = await authorizeManagePackages(slug);
    const [att] = await db
      .select()
      .from(projectPackageAttachments)
      .where(
        and(
          eq(projectPackageAttachments.id, attachmentId),
          eq(projectPackageAttachments.projectId, project.id),
        ),
      );

    if (!att) return notFound(`attachment not found: ${attachmentId}`);

    const result = await trustPackageRevision({
      packageInstallId: att.packageInstallId,
      db,
    });

    if (result === null) {
      return notFound(
        `package install not found for attachment ${attachmentId}`,
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return packageErrorResponse(err, `projects/${slug}/packages trust`);
  }
}
