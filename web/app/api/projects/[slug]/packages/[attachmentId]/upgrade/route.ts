import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authorizeManagePackages } from "../../../flow-packages/_lib";

import { upgradeAttachment } from "@/lib/packages/attach";
import { notFound, packageErrorResponse } from "@/lib/packages/http";

const upgradeBodySchema = z
  .object({ packageInstallId: z.string().min(1) })
  .strict();

// (ADR-088) Upgrade: the target install MUST be the same package name
// (PRECONDITION → 409); in-flight runs keep their pinned revisions.
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string; attachmentId: string }> },
): Promise<NextResponse> {
  const { slug, attachmentId } = await ctx.params;

  try {
    const { project, db } = await authorizeManagePackages(slug);
    const parsed = upgradeBodySchema.safeParse(await req.json());

    if (!parsed.success) {
      return NextResponse.json(
        {
          code: "CONFIG",
          message: parsed.error.issues[0]?.message ?? "bad body",
        },
        { status: 422 },
      );
    }

    const result = await upgradeAttachment({
      projectId: project.id,
      projectSlug: project.slug,
      attachmentId,
      packageInstallId: parsed.data.packageInstallId,
      workspaceRoot: project.repoPath,
      db,
    });

    if (result === null) {
      return notFound(
        `attachment or package install not found: ${attachmentId}`,
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return packageErrorResponse(err, `projects/${slug}/packages upgrade`);
  }
}
