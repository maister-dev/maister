import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { TaskLaunchRequest } from "./launch-schema";

import { and, eq, inArray } from "drizzle-orm";

import {
  flows,
  flowRevisions,
  localPackages,
  packageInstalls,
  projectPackageAttachments,
} from "@/lib/db/schema";
import { resolvePinnedFlowRevisionForRefId } from "@/lib/packages/pin";
import { MaisterError } from "@/lib/errors";

/** Resolve an existing cut without changing a package attachment or invoking Git. */
export async function selectedTaskLaunchRevision(
  db: Db,
  projectId: string,
  flow: typeof flows.$inferSelect,
  selection: Partial<TaskLaunchRequest>,
): Promise<{
  revision: typeof flowRevisions.$inferSelect | null;
  packageInstallId: string | null;
}> {
  const choices = Object.entries(selection.packageVersions ?? {});

  if (choices.length) {
    const attached = await db
      .select({ id: projectPackageAttachments.packageInstallId })
      .from(projectPackageAttachments)
      .where(
        and(
          eq(projectPackageAttachments.projectId, projectId),
          inArray(
            projectPackageAttachments.packageInstallId,
            choices.map(([id]) => id),
          ),
        ),
      );
    const ids = new Set(attached.map((attachment) => attachment.id));

    if (choices.some(([id]) => !ids.has(id)))
      throw new MaisterError(
        "CONFLICT",
        "A selected package is no longer attached to this project",
        { details: { reason: "launch_package_changed" } },
      );
  }
  const tryOnce = choices.filter(([, choice]) => choice === "try_once");

  if (tryOnce.length > 1)
    throw new MaisterError(
      "CONFIG",
      "Select one existing package cut for this Flow",
      {
        details: { reason: "launch_package_ambiguous" },
      },
    );
  if (tryOnce.length === 0) {
    const [revision] = flow.enabledRevisionId
      ? await db
          .select()
          .from(flowRevisions)
          .where(eq(flowRevisions.id, flow.enabledRevisionId))
      : [];

    return {
      revision: revision ?? null,
      packageInstallId: flow.packageInstallId,
    };
  }
  const [installId] = tryOnce[0];
  const [target] = await db
    .select({ id: localPackages.lastCutInstallId })
    .from(projectPackageAttachments)
    .innerJoin(
      packageInstalls,
      eq(packageInstalls.id, projectPackageAttachments.packageInstallId),
    )
    .innerJoin(
      localPackages,
      eq(localPackages.id, packageInstalls.sourceLocalPackageId),
    )
    .where(
      and(
        eq(projectPackageAttachments.projectId, projectId),
        eq(projectPackageAttachments.packageInstallId, installId),
        eq(localPackages.status, "active"),
      ),
    );

  if (!target?.id || target.id === installId)
    throw new MaisterError(
      "CONFLICT",
      "The selected existing package cut is no longer available",
      {
        details: { reason: "launch_package_changed" },
      },
    );
  const pinned = await resolvePinnedFlowRevisionForRefId(db, {
    flowRefId: flow.flowRefId,
    packageInstallId: target.id,
  });
  const [revision] = await db
    .select()
    .from(flowRevisions)
    .where(eq(flowRevisions.id, pinned.id));

  if (!revision)
    throw new MaisterError(
      "PRECONDITION",
      "The selected immutable Flow revision is missing",
      {
        details: { reason: "flow_unavailable" },
      },
    );

  return { revision, packageInstallId: target.id };
}
