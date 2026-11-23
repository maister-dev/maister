import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { PackageCoordinates } from "./package-writes";

import { and, eq } from "drizzle-orm";

import {
  assertOperatorPin,
  assertStandaloneFlowOwnership,
  lockDependencyProject,
  recordManualPackage,
  settleManualDependency,
} from "./package-writes";
import { reconcileDependencyCatalog } from "./catalog";
import { prepareDependencyFlow } from "./prepare-flow";
import { assertDependencySource } from "./source";
import { withSetupDatabase } from "./setup";
import {
  flows,
  projectDependencyDeclarations as declarations,
  projectPackageAttachments as attachments,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { installFlowPlugin, installRevision } from "@/lib/flows";
import { resolveTrust } from "@/lib/flows/trust";
import {
  installPackageRevision,
  workerAttachPackage,
  workerUpgradeAttachment,
} from "@/lib/packages/attach";

type ProjectTarget = {
  projectId: string;
  projectSlug: string;
  workspaceRoot: string;
  db: Db;
};

/** The host operator supplies the pin. Repository YAML may lag a reviewed platform correction. */
export async function installOperatorPackage(
  target: ProjectTarget,
  coordinates: PackageCoordinates,
) {
  assertDependencySource(coordinates.source);
  const { db, projectId } = target;
  const installed = await installPackageRevision({
    ...coordinates,
    db,
    trustStatus: resolveTrust(coordinates.source),
  });
  return withSetupDatabase(db, () =>
    db.transaction(async (tx) => {
      await lockDependencyProject(tx, projectId);
      const [prior] = await tx
        .select()
        .from(attachments)
        .where(
          and(
            eq(attachments.projectId, projectId),
            eq(attachments.packageName, installed.name),
          ),
        );
      const [head] = await tx
        .select()
        .from(declarations)
        .where(
          and(
            eq(declarations.projectId, projectId),
            eq(declarations.kind, "package"),
            prior
              ? eq(declarations.effectiveAttachmentId, prior.id)
              : eq(declarations.logicalId, installed.name),
          ),
        );
      assertOperatorPin(head?.desired, coordinates);
      const opts = { ...target, db: tx, packageInstallId: installed.id };
      const record: Parameters<typeof workerAttachPackage>[1] = (
        connection,
        attachmentId,
        install,
      ) =>
        recordManualPackage(
          connection,
          projectId,
          attachmentId,
          install,
          coordinates,
        );
      if (prior) {
        if (
          prior.packageInstallId !== installed.id ||
          head?.effectiveGeneration !== head?.generation
        )
          await workerUpgradeAttachment(
            { ...opts, attachmentId: prior.id },
            record,
          );
      } else {
        const linked = await workerAttachPackage(opts, record);
        if (!linked)
          throw new MaisterError(
            "PRECONDITION",
            "The prepared package is no longer installed.",
          );
      }
      await reconcileDependencyCatalog(tx, projectId);
      const members = await tx
        .select({ flowRowId: flows.id, revisionId: flows.enabledRevisionId })
        .from(flows)
        .where(
          and(
            eq(flows.projectId, projectId),
            eq(flows.packageInstallId, installed.id),
          ),
        );
      return {
        package: installed.name,
        versionLabel: installed.versionLabel,
        revision: installed.resolvedRevision,
        flows: members,
        capabilities: installed.manifest.spec.capabilities.map(
          (member) => member.id,
        ),
      };
    }),
  );
}

/** A standalone operator install may never replace a package-owned enablement or a newer requested Flow. */
export async function installOperatorFlow(
  target: ProjectTarget,
  pin: PackageCoordinates & { flowId: string },
) {
  const { db, projectId } = target;
  assertDependencySource(pin.source);
  const scope = and(
    eq(declarations.projectId, projectId),
    eq(declarations.kind, "flow"),
    eq(declarations.logicalId, pin.flowId),
  );
  const [requested] = await db.select().from(declarations).where(scope);
  assertOperatorPin(requested?.desired, pin);
  const opts = {
    ...target,
    ...pin,
    roleRefs: requested?.desired.roleRefs,
    capabilityRefIds: requested?.desired.capabilityRefIds,
  };
  const revision = await installRevision(opts);
  return withSetupDatabase(db, () =>
    db.transaction(async (tx) => {
      await lockDependencyProject(tx, projectId);
      await assertStandaloneFlowOwnership(tx, projectId, pin.flowId);
      const [current] = await tx.select().from(declarations).where(scope);
      if (
        requested?.id !== current?.id ||
        requested?.generation !== current?.generation
      )
        throw new MaisterError(
          "CONFLICT",
          "The Flow declaration changed during source resolution.",
          { details: { reason: "stale_generation" } },
        );
      const installed = await installFlowPlugin({
        ...opts,
        db: tx,
        preparedRevision: revision,
      });
      await prepareDependencyFlow(
        tx,
        projectId,
        installed,
        current?.desired.runner,
      );
      if (current)
        await settleManualDependency(tx, current, current.desired, {
          effectiveRevision: installed.revision,
        });
      return installed;
    }),
  );
}
