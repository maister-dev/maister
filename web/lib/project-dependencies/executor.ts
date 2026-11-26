import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { DependencyClaim } from "./claims";
import type { InstallResult } from "@/lib/flows";
import type { DependencyCheckpoint } from "./types";

import { and, eq, lt, sql } from "drizzle-orm";

import { prepareDependencyFlow } from "./prepare-flow";
import {
  assertStandaloneImportOwnership,
  assertCapabilityMemberOwnership,
  reconcileDependencyCatalog,
} from "./catalog";
import { liveDependencyClaim, requireCurrentDependency } from "./claims";
import {
  finishFlowLinkPublication,
  queueProjectFlowLinks,
  validateProjectFlowLink,
} from "./flow-links";
import {
  stageFlowSetup,
  stageCapabilitySetup,
  settlePreparedPackageSetups,
} from "./stage-setup";
import { withSettledSetups, withSetupAuthority } from "./setup";
import { requireParentPackageTrust } from "./member-trust";
import {
  assertPackageMemberOwnership,
  assertStandaloneFlowOwnership,
} from "./package-writes";

import {
  projectDependencyDeclarations as declarations,
  projectPackageAttachments,
  projectDependencyAttempts as attempts,
  projects,
  flows,
  flowRevisions,
  packageInstalls,
  capabilityImports,
} from "@/lib/db/schema";
import { installRevision, installFlowPlugin } from "@/lib/flows";
import { resolveTrust } from "@/lib/flows/trust";
import {
  prepareCapabilityRevision,
  bindPreparedCapability,
  resolveCapabilityTrust,
  runCapabilityRevisionSetup,
} from "@/lib/capabilities/import";
import {
  type PackageInstallManifest,
  installPackageRevision,
  verifyCachedPackage,
  preparePackageMembers,
  workerAttachPackage,
  workerUpgradeAttachment,
} from "@/lib/packages/attach";
import { MaisterError } from "@/lib/errors";

type Execution = {
  db: Db;
  claim: DependencyClaim;
  project: typeof projects.$inferSelect;
  declaration: typeof declarations.$inferSelect;
  signal: AbortSignal;
  authorizePublication: (tx: Db) => Promise<void>;
  progress: (
    stage: "resolve" | "install" | "attach" | "setup" | "projection",
    update?: {
      resolvedRevision?: string;
      checkpoint?: DependencyCheckpoint;
      memberRef?: string;
    },
  ) => Promise<void>;
};
function assertRevision(expected: string | null, actual: string): void {
  if (expected !== null && expected !== actual)
    throw new MaisterError(
      "CONFLICT",
      "The source no longer resolves to the recorded revision",
      { details: { reason: "revision_mismatch" } },
    );
}
async function recordEffective(
  tx: Db,
  job: Execution,
  revision: string,
  attachmentId?: string,
) {
  await tx
    .update(declarations)
    .set({
      effectiveGeneration: job.claim.generation,
      effectiveRevision: revision,
      effectiveAttachmentId: attachmentId ?? null,
    })
    .where(
      and(
        eq(declarations.id, job.declaration.id),
        eq(declarations.generation, job.claim.generation),
      ),
    );
}
async function recordCommittedApplication(tx: Db, claim: DependencyClaim) {
  const [marked] = await tx
    .update(attempts)
    .set({
      stage: "projection",
      checkpoint: sql`coalesce(${attempts.checkpoint},'{}'::jsonb)||'{"applicationCommitted":true}'::jsonb`,
    })
    .where(liveDependencyClaim(claim))
    .returning({ id: attempts.id });
  if (!marked)
    throw new MaisterError(
      "CONFLICT",
      "The installation claim expired before committing its effective state.",
      { details: { reason: "superseded" } },
    );
}

function memberKeys(install: typeof packageInstalls.$inferSelect): Set<string> {
  const { spec, inventory } = install.manifest as PackageInstallManifest;

  return new Set([
    "package:" + install.name,
    ...spec.flows.map((f) => "flow:" + f.id),
    ...spec.capabilities.map((c) => "capability:" + c.id),
    ...spec.mcps.map((m) => "mcp:" + m.id),
    ...spec.restrictions.map((r) => "restriction:" + r.id),
    ...inventory.skills.map((id) => "skill:" + id),
  ]);
}

/** Only a sibling whose material is known can reserve a discovered member.
 * Fetching or permanently failed siblings never exclude unrelated ready work. */
async function awaitEarlierCandidate(
  tx: Db,
  job: Execution,
  candidate: typeof packageInstalls.$inferSelect,
): Promise<void> {
  const earlier = await tx
    .select({ install: packageInstalls, logicalId: declarations.logicalId })
    .from(declarations)
    .innerJoin(
      attempts,
      and(
        eq(attempts.declarationId, declarations.id),
        eq(attempts.generation, declarations.generation),
      ),
    )
    .innerJoin(
      packageInstalls,
      sql`${packageInstalls.id}=${attempts.checkpoint}->>'installId'`,
    )
    .where(
      and(
        eq(declarations.projectId, job.project.id),
        eq(declarations.kind, "package"),
        lt(declarations.ordinal, job.declaration.ordinal),
        sql`(${attempts.status}='running' OR (${attempts.status}='pending' AND ${attempts.dueAt}<=clock_timestamp()))`,
      ),
    );
  const current = memberKeys(candidate);

  for (const row of earlier) {
    if ([...memberKeys(row.install)].some((member) => current.has(member)))
      throw new MaisterError(
        "CONFLICT",
        "An earlier ready declaration is applying a shared member",
        {
          details: {
            reason: "earlier_member_pending",
            memberRef: "package:" + row.logicalId,
          },
        },
      );
  }
}
async function stagePackageMembers(
  job: Execution,
  candidate: typeof packageInstalls.$inferSelect,
  roleRefs: readonly string[] | undefined,
) {
  const { db, project, claim, signal } = job;

  if (job.declaration.effectiveAttachmentId) {
    const [current] = await db
      .select({ installId: projectPackageAttachments.packageInstallId })
      .from(projectPackageAttachments)
      .where(
        eq(projectPackageAttachments.id, job.declaration.effectiveAttachmentId),
      );

    if (current?.installId === candidate.id) return;
  }
  const members = await preparePackageMembers(
    db,
    project.id,
    candidate,
    roleRefs,
    signal,
    job.authorizePublication,
  );
  const authorizeSetup = async (tx: Db) => {
    const { declaration: head } = await requireCurrentDependency(tx, claim);

    await requireParentPackageTrust(tx, candidate.id);
    await awaitEarlierCandidate(tx, job, candidate);
    const [attachment] = await tx
      .select()
      .from(projectPackageAttachments)
      .where(
        and(
          eq(projectPackageAttachments.projectId, project.id),
          eq(projectPackageAttachments.packageName, candidate.name),
        ),
      );

    if (attachment && attachment.id !== head.effectiveAttachmentId)
      throw new MaisterError(
        "CONFLICT",
        "Another declaration owns this package name",
        { details: { reason: "package_name_taken" } },
      );
    if (head.effectiveAttachmentId && !attachment)
      throw new MaisterError(
        "PRECONDITION",
        "The replacement must have the attached package name",
      );
    await assertPackageMemberOwnership(
      tx,
      project.id,
      [...members.flows.keys()],
      attachment?.packageInstallId,
    );
    await assertCapabilityMemberOwnership(
      tx,
      project.id,
      [...members.capabilities.keys()],
      candidate.resolvedRevision,
      attachment?.packageInstallId,
    );
  };

  if (candidate.trustStatus !== "untrusted") {
    await settlePreparedPackageSetups(db, project.id, members, authorizeSetup, signal);
  }

  return members;
}
function assertLayout(previous: string | undefined, current: string): void {
  if (previous && previous !== current)
    throw new MaisterError(
      "CONFLICT",
      "Dependency file layout changed after resolution.",
      { details: { reason: "revision_mismatch" } },
    );
}
async function executePackage(job: Execution): Promise<void> {
  const { db, claim, project, signal, progress } = job;
  let install = claim.checkpoint.installId
    ? (
        await db
          .select()
          .from(packageInstalls)
          .where(eq(packageInstalls.id, claim.checkpoint.installId))
      )[0]
    : undefined;

  if (install && !(await verifyCachedPackage(install))) install = undefined;
  if (!install) {
    const published = await installPackageRevision({
      authorizePublication: job.authorizePublication,
      ...claim.desired,
      trustStatus: resolveTrust(claim.desired.source),
      db,
      signal,
      onResolve: async (revision, layoutDigest) => {
        assertLayout(claim.checkpoint.layoutDigest, layoutDigest);
        assertRevision(claim.resolvedRevision, revision);
        await progress("install", {
          resolvedRevision: revision,
          checkpoint: { ...claim.checkpoint, layoutDigest },
        });
      },
    });

    [install] = await db
      .select()
      .from(packageInstalls)
      .where(eq(packageInstalls.id, published.id));
  }
  if (!install)
    throw new MaisterError(
      "PRECONDITION",
      "The resolved installation is absent",
    );
  const candidate = install;

  assertRevision(claim.resolvedRevision, candidate.resolvedRevision);
  await progress("attach", {
    resolvedRevision: candidate.resolvedRevision,
    checkpoint: {
      ...claim.checkpoint,
      installId: candidate.id,
      layoutDigest:
        (candidate.manifest as PackageInstallManifest).layoutDigest ??
        claim.checkpoint.layoutDigest,
    },
  });
  const roleRefs = claim.desired.roleRefs?.length
    ? claim.desired.roleRefs
    : undefined;
  const members = await stagePackageMembers(job, candidate, roleRefs);

  await withSettledSetups(() =>
    db.transaction(async (tx) => {
      const { declaration: head } = await requireCurrentDependency(tx, claim);

      signal.throwIfAborted();
      await awaitEarlierCandidate(tx, job, candidate);
      const args = {
        db: tx,
        projectId: project.id,
        projectSlug: project.slug,
        workspaceRoot: project.repoPath,
        roleRefs,
        preparedMembers: members,
        linkOperationId: claim.id,
        packageInstallId: candidate.id,
        signal,
      };
      const record = (db: Db, id: string) =>
        recordEffective(db, job, candidate.resolvedRevision, id);

      if (head.effectiveAttachmentId) {
        const [attached] = await tx
          .select()
          .from(projectPackageAttachments)
          .where(eq(projectPackageAttachments.id, head.effectiveAttachmentId));

        if (attached?.packageInstallId !== candidate.id)
          await workerUpgradeAttachment(
            { ...args, attachmentId: head.effectiveAttachmentId },
            record,
          );
        else {
          await record(tx, head.effectiveAttachmentId);
          const installed = await tx
            .select()
            .from(flows)
            .where(
              and(
                eq(flows.projectId, project.id),
                eq(flows.packageInstallId, candidate.id),
              ),
            );

          for (const flow of installed) {
            if (!flow.enabledRevisionId) continue;
            const [rev] = await tx
              .select()
              .from(flowRevisions)
              .where(eq(flowRevisions.id, flow.enabledRevisionId));

            await prepareDependencyFlow(tx, project.id, {
              flowRowId: flow.id,
              revisionId: rev.id,
              manifest: rev.manifest as InstallResult["manifest"],
            });
          }
        }
      } else {
        if (!(await workerAttachPackage(args, record)))
          throw new MaisterError(
            "PRECONDITION",
            "Resolved install disappeared",
          );
      }
      await reconcileDependencyCatalog(tx, project.id);
      await recordCommittedApplication(tx, claim);
    }),
  );
}

export async function executeDependency(job: Execution): Promise<void> {
  const { db, claim, project, declaration, signal, progress } = job;

  if (
    declaration.effectiveGeneration === claim.generation &&
    claim.resolvedRevision !== null &&
    declaration.effectiveRevision === claim.resolvedRevision
  ) {
    // Pre-outbox attempts could lose their acknowledgement after the native transaction.
    if (!claim.checkpoint.applicationCommitted)
      await db.transaction(async (tx) => {
        await requireCurrentDependency(tx, claim);
        let refs: string[] = [];
        if (declaration.kind === "flow") refs = [declaration.logicalId];
        if (
          declaration.kind === "package" &&
          declaration.effectiveAttachmentId
        ) {
          const rows = await tx
            .select({ ref: flows.flowRefId })
            .from(projectPackageAttachments)
            .innerJoin(
              flows,
              and(
                eq(
                  flows.packageInstallId,
                  projectPackageAttachments.packageInstallId,
                ),
                eq(flows.projectId, project.id),
              ),
            )
            .where(
              and(
                eq(
                  projectPackageAttachments.id,
                  declaration.effectiveAttachmentId,
                ),
                eq(projectPackageAttachments.projectId, project.id),
              ),
            );
          refs = rows.map((row) => row.ref);
        }
        await queueProjectFlowLinks(
          tx,
          claim.id,
          project.id,
          project.repoPath,
          refs,
        );
        await recordCommittedApplication(tx, claim);
      });
    return finishFlowLinkPublication(db, claim.id);
  }
  if (declaration.kind === "package") {
    await executePackage(job);

    return finishFlowLinkPublication(db, claim.id);
  }
  const pin = claim.desired;

  if (declaration.kind === "flow") {
    const args = {
      ...pin,
      roleRefs: pin.roleRefs?.length ? pin.roleRefs : undefined,
      projectId: project.id,
      projectSlug: project.slug,
      workspaceRoot: project.repoPath,
      flowId: declaration.logicalId,
      signal,
    };
    const revision = await installRevision({
      ...args,
      db,
      onResolve: async (resolvedRevision, layoutDigest) => {
        assertLayout(claim.checkpoint.layoutDigest, layoutDigest);
        assertRevision(claim.resolvedRevision, resolvedRevision);
        await progress("install", {
          resolvedRevision,
          checkpoint: { ...claim.checkpoint, layoutDigest },
        });
      },
      authorizePublication: job.authorizePublication,
    });

    await progress("attach");
    const authorize = async (tx: Db) => {
      await requireCurrentDependency(tx, claim);
      await assertStandaloneFlowOwnership(
        tx,
        project.id,
        declaration.logicalId,
      );
    };

    if (resolveTrust(pin.source) !== "untrusted")
      await withSetupAuthority(db, authorize, () =>
        stageFlowSetup(db, claim.projectId, revision, declaration.logicalId, signal),
      );
    await withSettledSetups(() =>
      db.transaction(async (tx) => {
        await authorize(tx);
        const installed = await installFlowPlugin({
          ...args,
          db: tx,
          preparedRevision: revision,
          projectLink: validateProjectFlowLink,
        });

        await prepareDependencyFlow(tx, project.id, installed, pin.runner);
        await recordEffective(tx, job, installed.revision);
        await queueProjectFlowLinks(
          tx,
          claim.id,
          project.id,
          project.repoPath,
          [declaration.logicalId],
        );
        await recordCommittedApplication(tx, claim);
      }),
    );

    return finishFlowLinkPublication(db, claim.id);
  }
  await progress("install");
  const authorize = async (tx: Db) => {
    await requireCurrentDependency(tx, claim);
    await assertStandaloneImportOwnership(
      tx,
      project.id,
      declaration.logicalId,
    );
  };
  const args = {
    ...pin,
    capabilityRefId: declaration.logicalId,
    projectId: project.id,
    db,
    signal,
    trustStatusOverride:
      pin.trust === "explicit" ? ("untrusted" as const) : undefined,
  };
  const material = await prepareCapabilityRevision({
    authorizePublication: job.authorizePublication,
    ...args,
    onResolve: async (revision, witness, layoutDigest) => {
      assertLayout(claim.checkpoint.layoutDigest, layoutDigest);
      assertRevision(claim.resolvedRevision, revision);
      if (
        claim.checkpoint.contentWitness &&
        claim.checkpoint.contentWitness !== witness
      )
        throw new MaisterError(
          "CONFLICT",
          "Local capability contents changed",
          { details: { reason: "revision_mismatch" } },
        );
      await progress("install", {
        resolvedRevision: revision,
        checkpoint: {
          ...claim.checkpoint,
          contentWitness: witness,
          layoutDigest,
        },
      });
    },
  });
  // Exact pre-existing imports retain their explicit trust and setup state.
  const readExisting = async (tx: Db) =>
    (
      await tx
        .select()
        .from(capabilityImports)
        .where(
          and(
            eq(capabilityImports.projectId, project.id),
            eq(capabilityImports.capabilityRefId, declaration.logicalId),
            eq(capabilityImports.resolvedRevision, material.resolvedRevision),
            eq(capabilityImports.packageStatus, "Installed"),
          ),
        )
    )[0];
  const canSetUp = async (tx: Db) => {
    const existing = await readExisting(tx);

    return (
      pin.trust !== "explicit" &&
      (existing?.trustStatus ?? resolveCapabilityTrust(pin.source)) !==
        "untrusted" &&
      !["done", "not_required"].includes(existing?.setupStatus ?? "pending")
    );
  };

  if (material.hasSetup && (await canSetUp(db))) {
    await withSetupAuthority(
      db,
      async (tx) => {
        await authorize(tx);
        if (!(await canSetUp(tx)))
          throw new MaisterError(
            "PRECONDITION",
            "Capability setup trust changed",
            { details: { reason: "capability_trust_changed" } },
          );
      },
      () => stageCapabilitySetup(db, material, declaration.logicalId, signal),
    );
  }
  await withSettledSetups(() =>
    db.transaction(async (tx) => {
      await authorize(tx);
      const installed = await bindPreparedCapability(
        { ...args, db: tx },
        material,
      );

      if (pin.trust !== "explicit") {
        const outcome = await runCapabilityRevisionSetup({
          db: tx,
          importRowId: installed.importRowId,
          signal,
        });

        if (outcome.setupStatus === "failed")
          throw new MaisterError("FLOW_INSTALL", "Capability setup failed", {
            details: { reason: "setup_failed" },
          });
      }
      await recordEffective(tx, job, installed.resolvedRevision);
      await reconcileDependencyCatalog(tx, project.id);
      await recordCommittedApplication(tx, claim);
    }),
  );
}
