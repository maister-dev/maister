import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { getDb } from "@/lib/db/client";
import type { ProjectDependencyPin } from "./types";

import { and, eq, inArray, ne, or, sql } from "drizzle-orm";

import { assertDependencySource } from "./source";

import {
  flows,
  projects,
  projectDependencyAttempts as attempts,
  projectDependencyDeclarations as declarations,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

export type DependencyTransaction = Parameters<
  Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];
export type PackageCoordinates = Pick<
  ProjectDependencyPin,
  "source" | "version" | "path"
>;
type InstalledPackage = {
  name: string;
  sourceUrl: string;
  versionLabel: string;
  resolvedRevision: string;
  manifest: { sourceSubpath?: string };
};

export async function lockDependencyProject(
  tx: Db,
  projectId: string,
): Promise<string> {
  const [project] = await tx
    .select({ archivedAt: projects.archivedAt, repoPath: projects.repoPath })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for("update");

  if (!project || project.archivedAt)
    throw new MaisterError(
      "PRECONDITION",
      "The project is missing or archived.",
    );

  return project.repoPath;
}

export async function assertPackageMemberOwnership(
  tx: Db,
  projectId: string,
  flowIds: string[],
  priorInstallId?: string,
): Promise<void> {
  if (!flowIds.length) return;
  const [reserved] = await tx
    .select({ ref: declarations.logicalId })
    .from(declarations)
    .where(
      and(
        eq(declarations.projectId, projectId),
        eq(declarations.kind, "flow"),
        inArray(declarations.logicalId, flowIds),
      ),
    )
    .limit(1);
  const [effective] = await tx
    .select({ ref: flows.flowRefId })
    .from(flows)
    .where(
      and(
        eq(flows.projectId, projectId),
        inArray(flows.flowRefId, flowIds),
        priorInstallId
          ? sql`${flows.packageInstallId} IS DISTINCT FROM ${priorInstallId}`
          : undefined,
      ),
    )
    .limit(1);
  const ref = reserved?.ref ?? effective?.ref;

  if (ref)
    throw new MaisterError(
      "CONFLICT",
      `Flow "${ref}" is reserved or already installed in this project.`,
      {
        details: { reason: "flow_member_conflict", flowRef: ref },
      },
    );
}

export async function removePackageDeclaration(
  tx: DependencyTransaction,
  attachmentId: string,
): Promise<void> {
  await tx
    .delete(declarations)
    .where(eq(declarations.effectiveAttachmentId, attachmentId));
}

export function installedPackageCoordinates(
  install: InstalledPackage,
): PackageCoordinates {
  return {
    source: install.sourceUrl,
    version: install.versionLabel,
    ...(install.manifest.sourceSubpath === undefined
      ? {}
      : { path: install.manifest.sourceSubpath }),
  };
}

export async function manualPackageHead(
  tx: Db,
  projectId: string,
  attachmentId: string | null,
  installName: string,
  coordinates: PackageCoordinates,
) {
  assertDependencySource(coordinates.source);
  const [linked] = attachmentId
    ? await tx
        .select()
        .from(declarations)
        .where(eq(declarations.effectiveAttachmentId, attachmentId))
        .for("update")
    : [];
  const packages = linked
    ? [linked]
    : await tx
        .select()
        .from(declarations)
        .where(
          and(
            eq(declarations.projectId, projectId),
            eq(declarations.kind, "package"),
            or(
              eq(declarations.logicalId, installName),
              sql`
      ${declarations.desired}->>'source' = ${coordinates.source} AND ${declarations.desired}->>'version' = ${coordinates.version}
      AND ${declarations.desired}->>'path' IS NOT DISTINCT FROM ${coordinates.path ?? null}::text`,
            ),
          ),
        )
        .for("update");

  if (
    packages.length > 1 ||
    packages.some(
      (head) =>
        head.effectiveAttachmentId &&
        head.effectiveAttachmentId !== attachmentId,
    )
  )
    throw new MaisterError(
      "CONFLICT",
      "Multiple package declarations identify this installation.",
      { details: { reason: "ambiguous_package_declaration" } },
    );

  if (!packages.length) {
    const [conflict] = await tx
      .select({ kind: declarations.kind })
      .from(declarations)
      .where(
        and(
          eq(declarations.projectId, projectId),
          eq(declarations.logicalId, installName),
          ne(declarations.kind, "package"),
        ),
      )
      .limit(1);

    if (conflict)
      throw new MaisterError(
        "CONFLICT",
        `Package "${installName}" conflicts with an existing ${conflict.kind} declaration.`,
      );
  }
  return packages[0];
}

export async function recordManualPackage(
  tx: DependencyTransaction,
  projectId: string,
  attachmentId: string,
  install: InstalledPackage,
  coordinates = installedPackageCoordinates(install),
): Promise<void> {
  const head = await manualPackageHead(
    tx,
    projectId,
    attachmentId,
    install.name,
    coordinates,
  );
  const effective = {
    effectiveAttachmentId: attachmentId,
    effectiveRevision: install.resolvedRevision,
  };

  if (!head) {
    const [position] = await tx
      .select({
        ordinal: sql<number>`coalesce(max(${declarations.ordinal}), -1) + 1`,
      })
      .from(declarations)
      .where(
        and(
          eq(declarations.projectId, projectId),
          eq(declarations.kind, "package"),
        ),
      );

    await tx.insert(declarations).values({
      projectId,
      kind: "package",
      logicalId: install.name,
      ordinal: position.ordinal,
      desired: coordinates,
      effectiveGeneration: 1,
      ...effective,
    });

    return;
  }
  await settleManualDependency(
    tx,
    head,
    {
      ...head.desired,
      ...coordinates,
      path: coordinates.path,
    },
    effective,
  );
}

export async function settleManualDependency(
  tx: DependencyTransaction,
  head: typeof declarations.$inferSelect,
  desired: ProjectDependencyPin,
  effective: { effectiveRevision: string; effectiveAttachmentId?: string },
): Promise<void> {
  const changed =
    head.desired.source !== desired.source ||
    head.desired.version !== desired.version ||
    head.desired.path !== desired.path;
  const [priorAttempt] = await tx
    .select({ id: attempts.id })
    .from(attempts)
    .where(
      and(
        eq(attempts.declarationId, head.id),
        eq(attempts.generation, head.generation),
      ),
    )
    .limit(1);
  const generation = head.generation + (changed || priorAttempt ? 1 : 0);

  await tx
    .update(declarations)
    .set({
      desired,
      generation,
      effectiveGeneration: generation,
      ...effective,
    })
    .where(eq(declarations.id, head.id));
  if (priorAttempt)
    await tx
      .update(attempts)
      .set({
        status: "failed",
        stage: "attach",
        reason: "superseded",
        claimToken: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(attempts.declarationId, head.id),
          eq(attempts.generation, head.generation),
          inArray(attempts.status, ["pending", "running"]),
        ),
      );
}

export async function assertStandaloneFlowOwnership(
  tx: Db,
  projectId: string,
  flowId: string,
): Promise<void> {
  const [member] = await tx
    .select({ install: flows.packageInstallId })
    .from(flows)
    .where(and(eq(flows.projectId, projectId), eq(flows.flowRefId, flowId)));
  const [reserved] = await tx
    .select({ id: declarations.id })
    .from(declarations)
    .where(
      and(
        eq(declarations.projectId, projectId),
        eq(declarations.kind, "package"),
        eq(declarations.logicalId, flowId),
      ),
    );

  if (member?.install || reserved)
    throw new MaisterError(
      "CONFLICT",
      `Flow "${flowId}" conflicts with a project package.`,
      { details: { reason: "flow_member_conflict", flowRef: flowId } },
    );
}

export function assertOperatorPin(
  desired: ProjectDependencyPin | undefined,
  requested: PackageCoordinates,
): void {
  if (
    desired &&
    (desired.source !== requested.source ||
      desired.version !== requested.version ||
      desired.path !== requested.path)
  )
    throw new MaisterError(
      "CONFLICT",
      "The project already requests different coordinates. Review the current project dependency before changing its pin.",
      { details: { reason: "dependency_pin_changed" } },
    );
}
