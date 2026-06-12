import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { authorizeManagePackages } from "../../flow-packages/_lib";

import * as schemaModule from "@/lib/db/schema";
import { detachPackage } from "@/lib/packages/attach";
import { notFound, packageErrorResponse } from "@/lib/packages/http";
import { writeBackPackagesPin } from "@/lib/packages/yaml-writeback";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projectPackageAttachments } = schemaModule as unknown as Record<
  string,
  any
>;

// (ADR-087) Detach: refused while member revisions are run-pinned
// (PRECONDITION → 409). Write-back removes the packages[] pin post-commit.
export async function DELETE(
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

    const result = await detachPackage({
      projectId: project.id,
      attachmentId,
      db,
    });

    if (result === null)
      return notFound(`attachment not found: ${attachmentId}`);

    const writeBack = await writeBackPackagesPin({
      maisterYamlPath: project.maisterYamlPath,
      change: { op: "remove", id: att.packageName },
    });

    return NextResponse.json({ ok: true, writeBack });
  } catch (err) {
    return packageErrorResponse(err, `projects/${slug}/packages DELETE`);
  }
}
