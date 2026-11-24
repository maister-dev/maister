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
import {
  reconcileProjectFlowLinks,
  validateProjectFlowLink,
} from "./flow-links";
import { prepareDependencyFlow } from "./prepare-flow";
import { assertDependencySource } from "./source";
import { stageFlowSetup } from "./stage-setup";
import { withSetupAuthority, withSettledSetups } from "./setup";

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
  prepareManualPackageMutation,
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
  const [prior] = await db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.projectId, projectId),
        eq(attachments.packageName, installed.name),
      ),
    );
  const opts = {
    ...target,
    packageInstallId: installed.id,
    attachmentId: prior?.id,
  };
  const staged = await prepareManualPackageMutation(db, opts, coordinates);

  if (!staged)
    throw new MaisterError(
      "CONFLICT",
      "The package attachment changed during preparation.",
      { details: { reason: "stale_generation" } },
    );
  const result = await withSettledSetups(() =>
    db.transaction(async (tx) => {
      const head = await staged.assertCurrent(tx);
      const opts = {
        ...target,
        db: tx,
        packageInstallId: installed.id,
        preparedMembers: staged.members,
      };
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

  await reconcileProjectFlowLinks(db, target);

  return result;
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
  const authorize = async (tx: Db) => {
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

    return current;
  };
  const revision = await installRevision({
    ...opts,
    authorizePublication: async (tx) => {
      await authorize(tx);
    },
  });

  if (resolveTrust(pin.source) !== "untrusted")
    await withSetupAuthority(
      db,
      async (tx) => {
        await authorize(tx);
      },
      () => stageFlowSetup(db, revision, pin.flowId),
    );
  const result = await withSettledSetups(() =>
    db.transaction(async (tx) => {
      const current = await authorize(tx);
      const installed = await installFlowPlugin({
        ...opts,
        db: tx,
        preparedRevision: revision,
        projectLink: validateProjectFlowLink,
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

  await reconcileProjectFlowLinks(db, target);

  return result;
}
