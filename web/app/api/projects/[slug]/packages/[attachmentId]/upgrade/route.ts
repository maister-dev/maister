import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authorizeManagePackages } from "../../../flow-packages/_lib";

import * as schemaModule from "@/lib/db/schema";
import {
  upgradeAttachment,
  type PackageInstallManifest,
} from "@/lib/packages/attach";
import { notFound, packageErrorResponse } from "@/lib/packages/http";
import { writeBackPackagesPin } from "@/lib/packages/yaml-writeback";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { packageInstalls } = schemaModule as unknown as Record<string, any>;

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

    const [install] = await db
      .select()
      .from(packageInstalls)
      .where(eq(packageInstalls.id, parsed.data.packageInstallId));
    const manifest = install?.manifest as PackageInstallManifest | undefined;
    const writeBack = await writeBackPackagesPin({
      maisterYamlPath: project.maisterYamlPath,
      change: {
        op: "upsert",
        entry: {
          id: install.name,
          source: install.sourceUrl,
          version: install.versionLabel,
          ...(manifest?.sourceSubpath !== undefined
            ? { path: manifest.sourceSubpath }
            : {}),
        },
      },
    });

    return NextResponse.json({ ok: true, writeBack });
  } catch (err) {
    return packageErrorResponse(err, `projects/${slug}/packages upgrade`);
  }
}
