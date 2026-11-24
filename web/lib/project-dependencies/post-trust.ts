import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { TrustedSetupTarget } from "./types";
import type { DependencyClaim } from "./claims";

import { and, eq } from "drizzle-orm";

import { requireCurrentDependency } from "./claims";
import { reconcileDependencyCatalog } from "./catalog";
import { requireParentPackageTrust } from "./member-trust";
import { withSetupAuthority } from "./setup";

import {
  capabilityImports,
  flows,
  flowRevisions,
  packageInstalls,
  projectPackageAttachments,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { runRevisionSetup } from "@/lib/flows";
import { runCapabilityRevisionSetup } from "@/lib/capabilities/import";
import { settleTrustedPackageSetup } from "@/lib/packages/attach";

function changed(): never {
  throw new MaisterError(
    "CONFLICT",
    "The trusted dependency revision changed.",
    { details: { reason: "stale_generation" } },
  );
}

export async function executeTrustedSetup(
  db: Db,
  claim: DependencyClaim,
  target: TrustedSetupTarget,
  signal: AbortSignal,
): Promise<void> {
  const authorize = async (tx: Db) => {
    const { declaration } = await requireCurrentDependency(tx, claim);

    if (
      declaration.effectiveGeneration !== claim.generation ||
      !claim.resolvedRevision ||
      declaration.effectiveRevision !== claim.resolvedRevision
    )
      changed();
    const [attachment] = declaration.effectiveAttachmentId
      ? await tx
          .select()
          .from(projectPackageAttachments)
          .where(
            and(
              eq(
                projectPackageAttachments.id,
                declaration.effectiveAttachmentId,
              ),
              eq(projectPackageAttachments.projectId, claim.projectId),
            ),
          )
      : [];

    if (attachment)
      await requireParentPackageTrust(tx, attachment.packageInstallId);
    if (target.kind === "package") {
      if (!attachment || attachment.packageInstallId !== target.id) changed();

      return;
    }
    if (target.kind === "capability") {
      const [cap] = await tx
        .select()
        .from(capabilityImports)
        .where(
          and(
            eq(capabilityImports.id, target.id),
            eq(capabilityImports.projectId, claim.projectId),
            eq(capabilityImports.resolvedRevision, claim.resolvedRevision),
          ),
        );

      if (
        !cap ||
        cap.trustStatus === "untrusted" ||
        (attachment
          ? cap.packageInstallId !== attachment.packageInstallId
          : declaration.kind !== "capability_import" ||
            cap.capabilityRefId !== declaration.logicalId ||
            cap.packageInstallId)
      )
        changed();

      return;
    }
    const [member] = await tx
      .select({ flow: flows, revision: flowRevisions })
      .from(flows)
      .innerJoin(flowRevisions, eq(flowRevisions.id, flows.enabledRevisionId))
      .where(
        and(
          eq(flows.projectId, claim.projectId),
          eq(flowRevisions.id, target.id),
          eq(flowRevisions.resolvedRevision, claim.resolvedRevision),
        ),
      );

    if (
      !member ||
      member.revision.execTrust !== "trusted" ||
      (attachment
        ? member.flow.packageInstallId !== attachment.packageInstallId
        : declaration.kind !== "flow" ||
          member.flow.flowRefId !== declaration.logicalId ||
          member.flow.packageInstallId)
    )
      changed();
  };

  await db.transaction(authorize);
  await withSetupAuthority(db, authorize, async () => {
    if (target.kind === "package") {
      const [install] = await db
        .select()
        .from(packageInstalls)
        .where(eq(packageInstalls.id, target.id));

      if (
        !install ||
        install.trustStatus === "untrusted" ||
        install.resolvedRevision !== claim.resolvedRevision
      )
        changed();
      await settleTrustedPackageSetup(db, install, signal, claim.projectId);

      return;
    }
    let status: Awaited<ReturnType<typeof runRevisionSetup>>;

    if (target.kind === "flow") {
      const [flow] = await db
        .select()
        .from(flowRevisions)
        .where(eq(flowRevisions.id, target.id));

      if (!flow) changed();
      status = await runRevisionSetup({
        db,
        revisionId: flow.id,
        installedPath: flow.installedPath,
        signal,
      });
    } else {
      const capability = await runCapabilityRevisionSetup({
        db,
        importRowId: target.id,
        signal,
      });

      if (capability.setupStatus === "pending") changed();
      status = capability.setupStatus;
    }

    if (status === "failed")
      throw new MaisterError(
        "FLOW_INSTALL",
        "Trusted dependency setup failed.",
        { details: { reason: "setup_failed" } },
      );
    await db.transaction(async (tx) => {
      await authorize(tx);
      await reconcileDependencyCatalog(tx, claim.projectId);
    });
  });
}
