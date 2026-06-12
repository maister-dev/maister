import "server-only";

import type { DiscoveredPackageEntry } from "@/lib/db/schema";

import { eq, inArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authorizeManagePackages } from "../flow-packages/_lib";

import * as schemaModule from "@/lib/db/schema";
import {
  attachPackage,
  type PackageInstallManifest,
} from "@/lib/packages/attach";
import { deriveUpdateAvailable } from "@/lib/packages/catalog";
import { notFound, packageErrorResponse } from "@/lib/packages/http";
import { writeBackPackagesPin } from "@/lib/packages/yaml-writeback";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { packageInstalls, packageSources, projectPackageAttachments } =
  schemaModule as unknown as Record<string, any>;

// (ADR-087) Project package attachments. Identifiers: `slug` = url-param →
// project row (authorizeManagePackages); `packageInstallId` = body id
// resolved to a server row (404 on miss). No body field ever names a
// filesystem path.
const attachBodySchema = z
  .object({ packageInstallId: z.string().min(1) })
  .strict();

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await ctx.params;

  try {
    const { project, db } = await authorizeManagePackages(slug);
    const attachments = await db
      .select()
      .from(projectPackageAttachments)
      .where(eq(projectPackageAttachments.projectId, project.id));

    if (attachments.length === 0) {
      return NextResponse.json({ attachments: [] });
    }

    const installs = await db
      .select()
      .from(packageInstalls)
      .where(
        inArray(
          packageInstalls.id,
          attachments.map((a: any) => a.packageInstallId),
        ),
      );
    const installById = new Map(installs.map((i: any) => [i.id, i]));
    const sources = await db.select().from(packageSources);
    const discoveredByUrl = new Map<string, DiscoveredPackageEntry[]>(
      sources.map((s: any) => [s.url, s.discovered ?? []]),
    );

    const dto = attachments.map((att: any) => {
      const install = installById.get(att.packageInstallId) as any;
      const manifest = install?.manifest as PackageInstallManifest | undefined;

      return {
        id: att.id,
        packageInstallId: att.packageInstallId,
        packageName: att.packageName,
        versionLabel: install?.versionLabel ?? "",
        attachedAt: att.attachedAt,
        updateAvailable: install
          ? deriveUpdateAvailable({
              packageName: att.packageName,
              versionLabel: install.versionLabel,
              discovered: discoveredByUrl.get(install.sourceUrl) ?? [],
            })
          : false,
        flows: manifest?.spec.flows.map((f) => f.id) ?? [],
      };
    });

    return NextResponse.json({ attachments: dto });
  } catch (err) {
    return packageErrorResponse(err, `projects/${slug}/packages GET`);
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await ctx.params;

  try {
    const { project, db } = await authorizeManagePackages(slug);
    const parsed = attachBodySchema.safeParse(await req.json());

    if (!parsed.success) {
      return NextResponse.json(
        {
          code: "CONFIG",
          message: parsed.error.issues[0]?.message ?? "bad body",
        },
        { status: 422 },
      );
    }

    const result = await attachPackage({
      projectId: project.id,
      projectSlug: project.slug,
      packageInstallId: parsed.data.packageInstallId,
      workspaceRoot: project.repoPath,
      db,
    });

    if (result === null) {
      return notFound(
        `package install not found: ${parsed.data.packageInstallId}`,
      );
    }

    // Post-commit write-back of the packages[] pin (failure NEVER rolls back).
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

    return NextResponse.json(
      { ok: true, attachmentId: result.attachmentId, writeBack },
      { status: 201 },
    );
  } catch (err) {
    return packageErrorResponse(err, `projects/${slug}/packages POST`);
  }
}
