import "server-only";

import type { ExportProjection } from "./types";
import type { PersistenceDb } from "./store";

import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  projects,
  packageInstalls,
  projectPackageAttachments,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { localDirectoryContentDigest } from "@/lib/flows";
import { validateUrl } from "@/lib/repo-source";

const metadataSchema = z
  .object({ sourceSubpath: z.string().optional() })
  .passthrough();

export type ExportSnapshot = {
  project: typeof projects.$inferSelect;
  projection: ExportProjection;
  exportRevision: string;
};

/** One SQL snapshot keeps the project revision and all attached coordinates coherent. */
export async function readExportSnapshot(
  db: PersistenceDb,
  projectId: string,
): Promise<ExportSnapshot> {
  const rows = await db
    .select({
      project: projects,
      attachment: projectPackageAttachments,
      install: packageInstalls,
    })
    .from(projects)
    .leftJoin(
      projectPackageAttachments,
      eq(projectPackageAttachments.projectId, projects.id),
    )
    .leftJoin(
      packageInstalls,
      eq(packageInstalls.id, projectPackageAttachments.packageInstallId),
    )
    .where(eq(projects.id, projectId));
  const project = rows[0]?.project;

  if (!project || project.archivedAt)
    throw new MaisterError("PRECONDITION", "Project is missing or archived.", {
      details: { reason: "authority_changed" },
    });
  const packages: ExportProjection["packages"] = [];

  for (const { attachment, install } of rows) {
    if (!attachment) continue;
    if (
      !install ||
      install.packageStatus !== "Installed" ||
      install.name !== attachment.packageName
    ) {
      throw new MaisterError(
        "CONFIG",
        "An attached package has no matching installed revision. Repair the attachment before saving.",
        { details: { reason: "missing_package_install" } },
      );
    }
    const metadata = metadataSchema.safeParse(install.manifest);

    if (!metadata.success)
      throw new MaisterError(
        "CONFIG",
        "Attached package coordinates are invalid.",
        { details: { reason: "package_source_unexportable" } },
      );
    const path = metadata.data.sourceSubpath;

    packages.push({
      id: install.name,
      source: install.sourceUrl,
      version: install.versionLabel,
      ...(path === undefined ? {} : { path }),
      resolvedRevision: install.resolvedRevision,
    });
  }

  return {
    project,
    exportRevision: project.configExportRevision.toString(),
    projection: {
      name: project.name,
      mainBranch: project.mainBranch,
      branchPrefix: project.branchPrefix,
      publicBranchTemplate: project.publicBranchTemplate,
      defaultRunnerId: project.defaultRunnerId,
      promotionMode: project.promotionMode,
      packages: packages.sort((a, b) => a.id.localeCompare(b.id)),
    },
  };
}

/** Local labels do not enforce content pins on reload; verify the actual source. */
export async function assertExportablePackages(
  projection: ExportProjection,
): Promise<void> {
  for (const pin of projection.packages) {
    const local = pin.source.startsWith("file://")
      ? fileURLToPath(pin.source)
      : isAbsolute(pin.source)
        ? pin.source
        : null;

    if (local === null) {
      try {
        validateUrl(pin.source);
        if (pin.source.includes("://") && new URL(pin.source).password)
          throw new MaisterError(
            "CONFIG",
            "Credential-bearing package URLs cannot be exported.",
          );
      } catch (cause) {
        throw new MaisterError(
          "CONFIG",
          "Package source cannot be exported. Use a supported reproducible source.",
          {
            cause: cause instanceof Error ? cause : undefined,
            details: { reason: "package_source_unexportable" },
          },
        );
      }
      continue;
    }
    const directory = pin.path ? join(local, pin.path) : local;

    try {
      if (!(await stat(directory)).isDirectory())
        throw new MaisterError("CONFIG", "Package source is not a directory.");
    } catch (cause) {
      throw new MaisterError(
        "CONFIG",
        "Local package source is unavailable. Restore its reviewed immutable contents or attach a reproducible source.",
        {
          cause: cause instanceof Error ? cause : undefined,
          details: { reason: "package_source_unexportable" },
        },
      );
    }
    if (
      (await localDirectoryContentDigest(directory)).slice(0, 40) !==
      pin.resolvedRevision
    ) {
      throw new MaisterError(
        "CONFIG",
        "Local package source changed after attachment. Restore it or attach the new revision before saving.",
        { details: { reason: "package_revision_mismatch" } },
      );
    }
  }
}
