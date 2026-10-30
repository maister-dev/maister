import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import {
  detachPackage,
  type PackageInstallManifest,
  upgradeAttachment,
} from "@/lib/packages/attach";
import { notFound, packageErrorResponse } from "@/lib/packages/http";
import { writeBackPackagesPin } from "@/lib/packages/yaml-writeback";
import { handleExt } from "@/lib/tokens/ext-handler";

const { packageInstalls, projects, projectPackageAttachments } =
  schemaModule as unknown as Record<string, any>;

const ENDPOINT = "/api/v1/ext/projects/[slug]/packages/[attachmentId]";
const updateBodySchema = z
  .object({
    packageInstallId: z.string().min(1),
    expectedPackageInstallId: z.string().min(1),
  })
  .strict();

type RouteParams = {
  params: Promise<{ slug: string; attachmentId: string }>;
};

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, attachmentId } = await params;
  const db = getDb() as any;

  return handleExt(
    req,
    {
      slug,
      scopeLabel: "packages:manage",
      endpoint: `PATCH ${ENDPOINT}`,
      method: "PATCH",
      db,
    },
    async ({ projectId }) => {
      let parsed: ReturnType<typeof updateBodySchema.safeParse>;

      try {
        parsed = updateBodySchema.safeParse(await req.json());
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;

        return NextResponse.json(
          { code: "CONFIG", message: "invalid JSON body" },
          { status: 422 },
        );
      }

      if (!parsed.success) {
        return NextResponse.json(
          {
            code: "CONFIG",
            message: parsed.error.issues[0]?.message ?? "bad body",
          },
          { status: 422 },
        );
      }

      try {
        const [project] = await db
          .select()
          .from(projects)
          .where(eq(projects.id, projectId));
        const result = await upgradeAttachment({
          projectId,
          projectSlug: slug,
          attachmentId,
          packageInstallId: parsed.data.packageInstallId,
          expectedPackageInstallId: parsed.data.expectedPackageInstallId,
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
        const manifest = install.manifest as PackageInstallManifest | undefined;
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
      } catch (error) {
        return packageErrorResponse(error, `PATCH ${ENDPOINT}`);
      }
    },
  );
}

export async function DELETE(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, attachmentId } = await params;
  const db = getDb() as any;

  return handleExt(
    req,
    {
      slug,
      scopeLabel: "packages:manage",
      endpoint: `DELETE ${ENDPOINT}`,
      method: "DELETE",
      db,
    },
    async ({ projectId }) => {
      try {
        const [project] = await db
          .select()
          .from(projects)
          .where(eq(projects.id, projectId));
        const [attachment] = await db
          .select()
          .from(projectPackageAttachments)
          .where(
            and(
              eq(projectPackageAttachments.id, attachmentId),
              eq(projectPackageAttachments.projectId, projectId),
            ),
          );

        if (!attachment) {
          return notFound(`attachment not found: ${attachmentId}`);
        }

        const result = await detachPackage({
          projectId,
          attachmentId,
          db,
        });

        if (result === null) {
          return notFound(`attachment not found: ${attachmentId}`);
        }

        const writeBack = await writeBackPackagesPin({
          maisterYamlPath: project.maisterYamlPath,
          change: { op: "remove", id: attachment.packageName },
        });

        return NextResponse.json({ ok: true, writeBack });
      } catch (error) {
        return packageErrorResponse(error, `DELETE ${ENDPOINT}`);
      }
    },
  );
}
