import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import {
  attachPackage,
  type PackageInstallManifest,
} from "@/lib/packages/attach";
import { notFound, packageErrorResponse } from "@/lib/packages/http";
import { writeBackPackagesPin } from "@/lib/packages/yaml-writeback";
import {
  getAvailablePackageInstalls,
  getProjectPackageAttachments,
} from "@/lib/queries/packages";
import { handleExt } from "@/lib/tokens/ext-handler";

const { packageInstalls, projects } = schemaModule as unknown as Record<
  string,
  any
>;

const ENDPOINT = "GET /api/v1/ext/projects/[slug]/packages";
const ATTACH_ENDPOINT = "POST /api/v1/ext/projects/[slug]/packages";
const attachBodySchema = z
  .object({ packageInstallId: z.string().min(1) })
  .strict();

type RouteParams = { params: Promise<{ slug: string }> };

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;
  const db = getDb() as any;

  return handleExt(
    req,
    {
      slug,
      scopeLabel: "packages:manage",
      endpoint: ENDPOINT,
      method: "GET",
      db,
    },
    async ({ projectId }) => {
      try {
        const [attachments, availableInstalls] = await Promise.all([
          getProjectPackageAttachments(projectId),
          getAvailablePackageInstalls(),
        ]);

        return NextResponse.json({ attachments, availableInstalls });
      } catch (error) {
        return packageErrorResponse(error, ENDPOINT);
      }
    },
  );
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;
  const db = getDb() as any;

  return handleExt(
    req,
    {
      slug,
      scopeLabel: "packages:manage",
      endpoint: ATTACH_ENDPOINT,
      method: "POST",
      db,
    },
    async ({ projectId }) => {
      let parsed: ReturnType<typeof attachBodySchema.safeParse>;

      try {
        parsed = attachBodySchema.safeParse(await req.json());
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
        const result = await attachPackage({
          projectId,
          projectSlug: slug,
          packageInstallId: parsed.data.packageInstallId,
          workspaceRoot: project.repoPath,
          db,
        });

        if (result === null) {
          return notFound(
            `package install not found: ${parsed.data.packageInstallId}`,
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

        return NextResponse.json(
          { ok: true, attachmentId: result.attachmentId, writeBack },
          { status: 201 },
        );
      } catch (error) {
        return packageErrorResponse(error, ATTACH_ENDPOINT);
      }
    },
  );
}
