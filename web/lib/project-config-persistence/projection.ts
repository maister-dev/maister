import "server-only";

import type { ExportProjection, LocalPackageWitness } from "./types";
import type { PersistenceDb } from "./store";

import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { and, eq } from "drizzle-orm";

import { normalizedManifest } from "./manifest";

import { projects, projectDependencyDeclarations } from "@/lib/db/schema";
import { packageEntrySchema } from "@/lib/config.schema";
import { MaisterError } from "@/lib/errors";
import { localDirectoryContentDigest } from "@/lib/flows";
import { assertDependencySource } from "@/lib/project-dependencies/source";

export type ExportSnapshot = {
  project: typeof projects.$inferSelect;
  projection: ExportProjection;
  exportRevision: string;
};

/** One SQL snapshot keeps the project revision and all desired coordinates coherent. */
export async function readExportSnapshot(
  db: PersistenceDb,
  projectId: string,
): Promise<ExportSnapshot> {
  const rows = await db
    .select({
      project: projects,
      declaration: projectDependencyDeclarations,
    })
    .from(projects)
    .leftJoin(
      projectDependencyDeclarations,
      and(
        eq(projectDependencyDeclarations.projectId, projects.id),
        eq(projectDependencyDeclarations.kind, "package"),
      ),
    )
    .where(eq(projects.id, projectId));
  const project = rows[0]?.project;

  if (!project || project.archivedAt)
    throw new MaisterError("PRECONDITION", "Project is missing or archived.", {
      details: { reason: "authority_changed" },
    });
  const packages: ExportProjection["packages"] = [];

  for (const { declaration } of rows) {
    if (!declaration) continue;
    const { desired, logicalId, effectiveGeneration, effectiveRevision } =
      declaration;
    const pin = packageEntrySchema.safeParse({
      id: logicalId,
      source: desired.source,
      version: desired.version,
      path: desired.path,
    });

    if (!pin.success)
      throw new MaisterError(
        "CONFIG",
        "The declared package coordinates are invalid.",
        {
          details: { reason: "package_source_unexportable" },
        },
      );
    packages.push({
      ...pin.data,
      resolvedRevision:
        effectiveGeneration === declaration.generation
          ? effectiveRevision
          : null,
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
      taskQualificationOverride: project.taskQualificationOverride,
      defaultRunnerId: project.defaultRunnerId,
      promotionMode: project.promotionMode,
      packages: packages.sort((a, b) => a.id.localeCompare(b.id)),
    },
  };
}

/** Bind local bytes unless the exact reviewed blob already contains the unresolved pin. */
export async function reviewPackageSources(
  projection: ExportProjection,
  source: string | null = null,
): Promise<LocalPackageWitness[]> {
  const original = new Map(
    (source === null ? [] : normalizedManifest(source).packages).map((pin) => [
      pin.id,
      pin,
    ]),
  );
  const witnesses: LocalPackageWitness[] = [];

  for (const pin of projection.packages) {
    let local: string | null;

    try {
      assertDependencySource(pin.source);
      local = pin.source.startsWith("file://")
        ? fileURLToPath(pin.source)
        : isAbsolute(pin.source)
          ? pin.source
          : null;
    } catch (cause) {
      throw new MaisterError(
        "CONFIG",
        "Package source cannot be exported. Use a supported reproducible source without embedded credentials or URL query/fragment data.",
        {
          cause: cause instanceof Error ? cause : undefined,
          details: { reason: "package_source_unexportable" },
        },
      );
    }
    if (local === null) continue;
    const entry = original.get(pin.id);

    if (
      pin.resolvedRevision === null &&
      entry?.source === pin.source &&
      entry.version === pin.version &&
      entry.path === pin.path
    )
      continue;
    const directory = pin.path ? join(local, pin.path) : local;

    let digest: string;

    try {
      if (!(await stat(directory)).isDirectory())
        throw new MaisterError("CONFIG", "Package source is not a directory.");
      digest = await localDirectoryContentDigest(directory);
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
      pin.resolvedRevision !== null &&
      digest.slice(0, 40) !== pin.resolvedRevision
    ) {
      throw new MaisterError(
        "CONFIG",
        "Local package source changed after attachment. Restore it or attach the new revision before saving.",
        { details: { reason: "package_revision_mismatch" } },
      );
    }
    witnesses.push({ id: pin.id, digest });
  }

  return witnesses;
}
