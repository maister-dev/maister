import "server-only";

import type { FlowDeliverySnapshot } from "@/lib/capabilities/package-delivery";
import type { Db } from "@/lib/execution-host/db";
import { transportForSelectedHostId } from "@/lib/execution-host/default-transport";
import type { CapabilityBundleSource } from "@/lib/capabilities/materialize-bundle";
import type { PackageDeliveryCapture } from "@/lib/capabilities/capture-package-delivery";
import type { TaskAdmissionSnapshot } from "./qualification-types";
import type {
  TaskLaunchClaim,
  TaskLaunchFlowPreparationClaim,
} from "./launch-dispatch-claim";
import type { TaskLaunchSettingsV2Snapshot } from "./launch-types";

import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { taskLaunchAllowsTaskStatus } from "./launch-task-status";
import { prepareTaskLaunchFlowAssets } from "./launch-flow-assets";
import {
  assertTaskLaunchRelaunchSource,
  captureTaskLaunchRelaunchSource,
} from "./launch-continuation";
import {
  assertTaskLaunchFlowPreparationClaim,
  lockedTaskLaunchClaim,
  advanceTaskLaunchPreparation,
} from "./launch-dispatch-claim";
import { assertTaskLaunchDispatchAuthority } from "./launch-dispatch-authority";
import { loadTaskSemanticInput } from "./launch-input";
import {
  launchRefusal,
  taskLaunchSelectedConfiguration,
} from "./launch-resolution";
import {
  resolveTaskLaunchCapabilities,
  captureTaskLaunchCapabilityBundles,
  taskLaunchBoundCapabilityAuthority,
} from "./launch-capabilities";
import {
  armedAutomaticTaskLaunchBasis,
  automaticTaskLaunchBasis,
} from "./launch-automatic";
import { emitTaskLaunchChanged } from "./launch-events";
import {
  lockTaskLaunchReservation,
  lockTaskLaunchBoundRun,
} from "./launch-locks";
import { isManualTriageHold } from "./manual-launch-hold";
import { withTaskLaunchCapabilityBundles } from "./launch-capability-materialization";

import { requireReadyDeclaredFlowRunner } from "@/lib/acp-runners/declared-flow-runner";
import { assertProjectFlowCapabilities } from "@/lib/flows/project-capability-refs";
import { parseExecutableStoredFlowManifest } from "@/lib/flows/manifest-parser";
import { recordTaskAgentTriggerRunBound } from "@/lib/agents/task-trigger-reservation";
import {
  projects,
  tasks,
  taskLaunchIntents,
  flows,
  flowRevisions,
  workspaces,
  runs,
} from "@/lib/db/schema";
import { retryDigest } from "@/lib/agents/retry-guards";
import { preparePackageDeliveryCapture } from "@/lib/capabilities/capture-package-delivery";
import { assertFlowLaunchable } from "@/lib/flows/launchability-gate";
import { loadRunnerCatalog } from "@/lib/acp-runners/catalog";
import { snapshotRunner } from "@/lib/acp-runners/resolve";
import { countOpenBlockingClarifications } from "@/lib/tasks/clarification-gate";
import { getOpenRelationBlockers } from "@/lib/social/relations";
import {
  resolveBaseCommit,
  assertBaseCommitReachable,
  listWorktrees,
  localBranchHead,
  statusPorcelain,
} from "@/lib/worktree";
import { takeSchedulerLock } from "@/lib/scheduler";
import { readWorktreeProvenanceMetadata } from "@/lib/worktree-provenance";
import { localDirectoryContentDigest } from "@/lib/flows";
import { atomicWriteJson } from "@/lib/atomic";
import { runtimeRoot } from "@/lib/runtime-root";
import { runDirPath } from "@/lib/flows/graph/mutation-check";
import { MaisterError } from "@/lib/errors";
import { runtimeFileUrl } from "@/lib/runtime-file-url";
import {
  observeSelectedWorkspaceRevision,
  readAddressedWorkspaceStatus,
  resolveAddressedWorkspaceRevision,
} from "@/lib/execution-host/workspace-preparation";

const executionAuthority = Symbol("accepted task launch execution");

type FlowSettings = Extract<TaskLaunchSettingsV2Snapshot, { kind: "flow" }>;

/** A committed Run binding is the boundary between mutable preparation and frozen, receipt-backed delivery. */
function boundTaskDelivery(
  intent: typeof taskLaunchIntents.$inferSelect,
  settings: FlowSettings,
): { delivery: FlowDeliverySnapshot; authorityDigest: string } | undefined {
  const delivery = settings.resolvedCapabilitySet?.delivery;

  if (
    intent.runId &&
    intent.preparationPhase === "run_bound" &&
    delivery?.version === 1 &&
    settings.boundCapabilityAuthorityDigest
  )
    return {
      delivery,
      authorityDigest: settings.boundCapabilityAuthorityDigest,
    };
}

/** This context is constructed from a current DB claim, never decoded from a request. */
export type AcceptedTaskLaunchExecution = Readonly<{
  [executionAuthority]: true;
  claim: TaskLaunchFlowPreparationClaim;
  flowAssetsPath: string;
  intent: typeof taskLaunchIntents.$inferSelect;
  settings: FlowSettings;
  admission: Readonly<{
    snapshot: TaskAdmissionSnapshot;
    baseCommit: string;
    apply: (tx: Db) => Promise<TaskAdmissionSnapshot>;
  }>;
  assertCurrent: (db: Db) => Promise<void>;
  beginBinding: (tx: Db) => Promise<void>;
  bindRun: (tx: Db) => Promise<void>;
  prepareWorkspace: (effect: () => Promise<void>) => Promise<void>;
  materialize: (
    effect: (bundles: ReadonlyArray<CapabilityBundleSource>) => Promise<void>,
  ) => Promise<void>;
}>;

const materializationReceiptSchema = z
  .object({
    version: z.literal(1),
    intentId: z.string(),
    incarnationId: z.string(),
    settingsDigest: z.string().regex(/^[a-f0-9]{64}$/),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export function assertAcceptedTaskLaunchExecution(
  execution: AcceptedTaskLaunchExecution,
): void {
  if (execution?.[executionAuthority] !== true)
    throw launchRefusal("launch_worker_fenced");
}

/** DB-only freshness: mutable project defaults cannot replace the accepted resolution. */
export async function assertFrozenTaskLaunchCurrent(
  db: Db,
  intent: typeof taskLaunchIntents.$inferSelect,
  captureDelivery: PackageDeliveryCapture,
): Promise<void> {
  const settings = intent.settingsSnapshot;

  if (settings.version === 2 && settings.relaunchSource) {
    if (intent.sourceRunId !== settings.relaunchSource.runId)
      throw launchRefusal("launch_source_snapshot_incomplete", "PRECONDITION");
    if (intent.reservationLane === "ordinary")
      await captureTaskLaunchRelaunchSource(db, {
        sourceRunId: settings.relaunchSource.runId,
        projectId: intent.projectId,
        taskId: intent.taskId,
      });
    await assertTaskLaunchRelaunchSource(db, settings.relaunchSource);
  } else if (intent.sourceRunId)
    throw launchRefusal("launch_source_snapshot_incomplete", "PRECONDITION");

  if (
    intent.inputSnapshot.version !== 2 ||
    settings.version !== 2 ||
    settings.kind !== "flow" ||
    !Object.hasOwn(settings, "brainContext") ||
    !Object.hasOwn(settings, "packageVersions") ||
    !settings.capabilityBundles ||
    !settings.flowAssets
  )
    throw launchRefusal("launch_input_snapshot_incomplete", "PRECONDITION");
  await assertTaskLaunchDispatchAuthority(db, intent);
  const { task, snapshot } = await loadTaskSemanticInput(
    db,
    intent.projectId,
    intent.taskId,
  );
  const effectiveInput = {
    ...snapshot,
    target: intent.inputSnapshot.target,
    deliveryTarget: intent.inputSnapshot.deliveryTarget,
  };

  if (retryDigest(effectiveInput) !== intent.inputDigest)
    throw launchRefusal("launch_input_changed");
  if (
    retryDigest(taskLaunchSelectedConfiguration(task)) !==
    settings.taskSettingsDigest
  )
    throw launchRefusal("launch_settings_changed");
  if (task.queuePaused) throw launchRefusal("queue_paused", "PRECONDITION");
  if (isManualTriageHold(task))
    throw launchRefusal("launch_task_held", "PRECONDITION");
  if (intent.basis.kind === "automatic") {
    const readBasis = settings.serverExecution
      ? automaticTaskLaunchBasis
      : armedAutomaticTaskLaunchBasis;
    const currentBasis = await readBasis(
      db,
      task,
      settings,
      intent.basis.evidenceSha,
    );
    const { origin: _origin, ...acceptedBasis } = intent.basis;

    if (retryDigest(currentBasis) !== retryDigest(acceptedBasis))
      throw launchRefusal("qualification_stale", "PRECONDITION");
  }
  if (!taskLaunchAllowsTaskStatus(intent, task.status))
    throw launchRefusal("launch_task_terminal", "PRECONDITION");
  if (await countOpenBlockingClarifications(task.id, db))
    throw launchRefusal("clarification_pending", "PRECONDITION");
  if ((await getOpenRelationBlockers([task.id], db)).get(task.id)?.length)
    throw launchRefusal("blocked", "PRECONDITION");
  const [flow] = await db
    .select()
    .from(flows)
    .where(
      and(eq(flows.id, settings.flowId), eq(flows.projectId, intent.projectId)),
    );
  const [revision] = await db
    .select()
    .from(flowRevisions)
    .where(eq(flowRevisions.id, settings.flowRevisionId));

  if (!flow || !revision || revision.flowRefId !== settings.flowRefId)
    throw launchRefusal("flow_unavailable", "PRECONDITION");
  assertFlowLaunchable(
    settings.flowRefId,
    flow,
    revision,
    intent.effectiveExecutionHostId ? "selectedHost" : "manager",
  );
  const manifest = parseExecutableStoredFlowManifest(revision.manifest, {
    code: "CONFIG",
    surface: "launch-service",
    manifestLabel: `flow revision ${revision.id}`,
    flowRefId: flow.flowRefId,
    revision: revision.resolvedRevision,
  });

  await assertProjectFlowCapabilities(db, intent.projectId, manifest);
  await requireReadyDeclaredFlowRunner(db, flow.id);

  const catalog = await loadRunnerCatalog(db);

  for (const slot of settings.sessions) {
    const runner = catalog.find((candidate) => candidate.id === slot.runnerId);

    if (!runner?.enabled)
      throw launchRefusal("launch_runner_disabled", "PRECONDITION");
    if (!runner.ready)
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "Accepted launch waits for its selected runner",
        { details: { reason: "launch_runner_unavailable" } },
      );
    if (retryDigest(snapshotRunner(runner)) !== slot.runnerConfigDigest)
      throw launchRefusal("launch_runner_changed");
  }
  const bound = boundTaskDelivery(intent, settings);

  if (bound && intent.runId) {
    const [run] = await db
      .select({ capabilities: runs.resolvedCapabilitySet })
      .from(runs)
      .where(
        and(
          eq(runs.id, intent.runId),
          eq(runs.taskLaunchIntentId, intent.id),
          eq(runs.projectId, intent.projectId),
        ),
      );

    if (
      !run ||
      retryDigest(run.capabilities) !==
        retryDigest(settings.resolvedCapabilitySet)
    )
      throw launchRefusal("launch_input_snapshot_incomplete", "PRECONDITION");
    if (
      (await taskLaunchBoundCapabilityAuthority(
        db,
        intent.projectId,
        bound.delivery,
      )) !== bound.authorityDigest
    )
      throw launchRefusal("launch_capabilities_changed");

    return;
  }
  const capabilities = await resolveTaskLaunchCapabilities(
    db,
    {
      projectId: intent.projectId,
      flowRevisionId: settings.flowRevisionId,
      flowSource: revision.source,
      flowPackageInstallId: settings.packageInstallId ?? flow.packageInstallId,
      flowManifest: revision.manifest,
      historical: settings.resolvedCapabilitySet?.delivery ? undefined : true,
    },
    captureDelivery,
  );

  if (
    capabilities.capabilityResolutionDigest !==
    settings.capabilityResolutionDigest
  )
    throw launchRefusal("launch_capabilities_changed");
}

/** Repository evidence is checked outside SQL transactions before owned filesystem effects. */
export async function assertFrozenTaskLaunchRepository(
  db: Db,
  intent: typeof taskLaunchIntents.$inferSelect,
): Promise<void> {
  const settings = intent.settingsSnapshot;

  if (
    settings.version !== 2 ||
    settings.kind !== "flow" ||
    !settings.capabilityBundles
  )
    throw launchRefusal("launch_input_snapshot_incomplete", "PRECONDITION");
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, intent.projectId));

  if (!project) throw launchRefusal("launch_task_missing", "PRECONDITION");
  const [bound] = intent.runId
    ? await db
        .select({ ownershipKind: workspaces.ownershipKind, executionHostId: workspaces.executionHostId })
        .from(workspaces)
        .where(eq(workspaces.runId, intent.runId))
    : [];
  const selectedHostId = intent.effectiveExecutionHostId ??
    (bound?.ownershipKind === "host_owned" ? bound.executionHostId : null);
  const transport = selectedHostId ? await transportForSelectedHostId(db, selectedHostId) : undefined;
  const pinned = intent.effectiveExecutionHostId
    ? await resolveAddressedWorkspaceRevision(
        intent.projectId,
        settings.baseBranch,
        settings.baseCommit,
        transport,
      )
    : null;
  if (pinned && pinned.pinnedCommit !== settings.baseCommit)
    throw launchRefusal("launch_workspace_changed", "PRECONDITION");
  const addressed = pinned !== null || bound?.ownershipKind === "host_owned";
  if (!addressed) {
    if (
      intent.preparationIdentity &&
      (await realpath(project.repoPath)) !==
        intent.preparationIdentity.parentRepoPath
    )
      throw launchRefusal("launch_workspace_changed", "PRECONDITION");
    await assertBaseCommitReachable({
      projectRepoPath: project.repoPath,
      baseRef: settings.baseBranch,
      baseCommit: settings.baseCommit,
      preferRemote: "origin",
    });
  }
  const standaloneIds = boundTaskDelivery(intent, settings)
    ?.delivery.packages.filter((p) => p.installId.startsWith("import:"))
    .flatMap((p) => p.bundleIds);
  const expectedBundles = standaloneIds
    ? settings.capabilityBundles.filter((b) => standaloneIds.includes(b.id))
    : settings.capabilityBundles;

  if (
    retryDigest(
      await captureTaskLaunchCapabilityBundles(
        db,
        intent.projectId,
        standaloneIds,
      ),
    ) !== retryDigest(expectedBundles)
  )
    throw launchRefusal("launch_capabilities_changed");
  if (intent.basis.kind === "automatic") {
    const currentHead =
      pinned?.commit ??
      (addressed
        ? await observeSelectedWorkspaceRevision(
            intent.projectId,
            settings.baseBranch,
            transport,
          )
        : await resolveBaseCommit({
            projectRepoPath: project.repoPath,
            baseRef: settings.baseBranch,
            preferRemote: "origin",
          }));
    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, intent.taskId));
    const readBasis = settings.serverExecution
      ? automaticTaskLaunchBasis
      : armedAutomaticTaskLaunchBasis;
    const currentBasis = await readBasis(db, task, settings, currentHead);
    const { origin: _origin, ...acceptedBasis } = intent.basis;

    if (retryDigest(currentBasis) !== retryDigest(acceptedBasis))
      throw launchRefusal("qualification_stale", "PRECONDITION");
  }
}

export async function assertTaskLaunchCheckoutIdentity(
  intent: typeof taskLaunchIntents.$inferSelect,
): Promise<void> {
  const identity = intent.preparationIdentity;

  if (!identity || identity.version !== 1)
    throw launchRefusal("launch_input_snapshot_incomplete", "PRECONDITION");
  const registered = (await listWorktrees(identity.parentRepoPath)).find(
    (worktree) => worktree.path === identity.worktreePath,
  );

  if (
    !registered ||
    registered.locked ||
    registered.prunable ||
    registered.branch !== `refs/heads/${identity.branch}`
  )
    throw launchRefusal("launch_workspace_changed", "PRECONDITION");
  const provenance = await readWorktreeProvenanceMetadata(
    identity.worktreePath,
  );

  if (
    provenance.runId !== identity.runId ||
    provenance.projectId !== intent.projectId ||
    (await localBranchHead({
      projectRepoPath: identity.parentRepoPath,
      branch: identity.branch,
    })) !== identity.baseCommit
  )
    throw launchRefusal("launch_workspace_changed", "PRECONDITION");
}

async function taskLaunchPreparationReceiptPath(
  db: Db,
  intent: typeof taskLaunchIntents.$inferSelect,
): Promise<{ directory: string; receiptPath: string }> {
  if (!intent.preparationIdentity)
    throw launchRefusal("launch_input_snapshot_incomplete", "PRECONDITION");
  const [project] = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, intent.projectId));

  if (!project) throw launchRefusal("launch_task_missing", "PRECONDITION");
  const directory = runDirPath(
    runtimeRoot(),
    project.slug,
    intent.preparationIdentity.runId,
  );

  return {
    directory,
    receiptPath: path.join(directory, "launch-preparation.json"),
  };
}

export async function assertTaskLaunchMaterializationReceipt(
  db: Db,
  intent: typeof taskLaunchIntents.$inferSelect,
): Promise<void> {
  const identity = intent.preparationIdentity;

  if (!identity || identity.version !== 1)
    throw launchRefusal("launch_input_snapshot_incomplete", "PRECONDITION");
  const { receiptPath } = await taskLaunchPreparationReceiptPath(db, intent);
  const receipt = materializationReceiptSchema.parse(
    JSON.parse(await readFile(runtimeFileUrl(receiptPath), "utf8")) as unknown,
  );

  if (
    receipt.intentId !== intent.id ||
    receipt.incarnationId !== identity.incarnationId ||
    receipt.settingsDigest !== intent.settingsDigest ||
    receipt.contentDigest !==
      (await localDirectoryContentDigest(identity.worktreePath))
  )
    throw launchRefusal("launch_preparation_incomplete", "PRECONDITION");
}

export async function assertTaskLaunchBoundWorkspace(
  db: Db,
  intent: typeof taskLaunchIntents.$inferSelect,
): Promise<void> {
  const identity = intent.preparationIdentity;

  if (
    !identity ||
    intent.preparationPhase !== "run_bound" ||
    intent.runId !== identity.runId
  )
    throw launchRefusal("launch_input_snapshot_incomplete", "PRECONDITION");
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.runId, identity.runId));

  if (workspace?.ownershipKind === "host_owned") {
    if (
      workspace.projectId !== intent.projectId ||
      workspace.removedAt ||
      (identity.version === 3 &&
        workspace.executionHostId !== identity.executionHostId) ||
      workspace.branch !== identity.branch ||
      workspace.baseCommit !== identity.baseCommit
    )
      throw launchRefusal("launch_workspace_changed", "PRECONDITION");
    if (!workspace.workspaceMaterializationGeneration)
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "The selected supervisor is still preparing the workspace",
        {
          details: { reason: "workspace_preparation_pending" },
        },
      );
    const observed = await readAddressedWorkspaceStatus(db, workspace);
    if (
      observed.workspace.mode !== "ownWorktree" ||
      observed.workspace.observedCommit !== identity.baseCommit ||
      observed.workingTree !== "clean"
    )
      throw launchRefusal("launch_workspace_changed", "PRECONDITION");

    return;
  }
  if (
    !workspace ||
    identity.version === 3 ||
    workspace.removedAt ||
    workspace.worktreePath !== identity.worktreePath ||
    workspace.parentRepoPath !== identity.parentRepoPath ||
    workspace.branch !== identity.branch ||
    workspace.baseCommit !== identity.baseCommit
  )
    throw launchRefusal("launch_workspace_changed", "PRECONDITION");
  await assertTaskLaunchCheckoutIdentity(intent);
  await assertTaskLaunchMaterializationReceipt(db, intent);
}

export async function acceptedTaskLaunchExecution(
  db: Db,
  claim: TaskLaunchClaim,
): Promise<AcceptedTaskLaunchExecution> {
  assertTaskLaunchFlowPreparationClaim(claim);
  const intent = await lockedTaskLaunchClaim(db, claim);
  const { identity } = claim;

  const packageDelivery = preparePackageDeliveryCapture();

  await assertFrozenTaskLaunchCurrent(db, intent, packageDelivery.prepare);
  await assertFrozenTaskLaunchRepository(db, intent);
  const settings = intent.settingsSnapshot;

  if (
    settings.version !== 2 ||
    settings.kind !== "flow" ||
    !settings.capabilityBundles
  )
    throw launchRefusal("launch_target_unsupported", "PRECONDITION");
  const flowAssetsPath = await prepareTaskLaunchFlowAssets(
    db,
    intent,
    claim.identity,
  );
  const capabilityBundles = settings.capabilityBundles;
  const basis = intent.basis;
  const snapshot: TaskAdmissionSnapshot = {
    version: 2,
    policyVersion: 2,
    mode:
      basis.kind === "manual"
        ? "manual"
        : basis.kind === "automatic"
          ? "required"
          : "execution_child",
    intentId: intent.id,
    basis: basis.kind,
    inputRevision: intent.inputRevision,
    qualificationId: basis.kind === "automatic" ? basis.qualificationId : null,
    qualificationRevision:
      basis.kind === "automatic" ? basis.qualificationRevision : null,
    evidenceTarget: settings.baseBranch,
    evidenceSha: settings.baseCommit,
    parent: basis.kind === "execution_child" ? basis.parent : null,
  };
  const assertCurrent = async (connection: Db): Promise<void> => {
    const current = await lockedTaskLaunchClaim(connection, claim);

    await assertFrozenTaskLaunchCurrent(
      connection,
      current,
      packageDelivery.recheck,
    );
  };
  const verifyWorkspace = (): Promise<void> =>
    assertTaskLaunchCheckoutIdentity(intent);
  const { directory: receiptDirectory, receiptPath } =
    await taskLaunchPreparationReceiptPath(db, intent);
  const readCompletedMaterialization = (): Promise<void> =>
    assertTaskLaunchMaterializationReceipt(db, intent);

  return {
    [executionAuthority]: true,
    claim,
    flowAssetsPath,
    intent,
    settings,
    admission: {
      snapshot,
      baseCommit: settings.baseCommit,
      apply: async (tx) => {
        await assertCurrent(tx);

        return snapshot;
      },
    },
    assertCurrent,
    prepareWorkspace: async (effect) => {
      if (identity.version !== 1)
        throw launchRefusal("workspace_protocol_unsupported", "PRECONDITION");
      const current = await lockedTaskLaunchClaim(db, claim);

      if (current.preparationPhase === "reserved") {
        const existing = (await listWorktrees(identity.parentRepoPath)).find(
          (worktree) => worktree.path === identity.worktreePath,
        );

        if (!existing) {
          if (
            await localBranchHead({
              projectRepoPath: identity.parentRepoPath,
              branch: identity.branch,
            })
          )
            throw launchRefusal("launch_workspace_changed", "PRECONDITION");
          await assertCurrent(db);
          await effect();
        }
        await verifyWorkspace();
        if (
          (
            await statusPorcelain({ worktreePath: identity.worktreePath })
          ).trim()
        )
          throw launchRefusal("launch_workspace_changed", "PRECONDITION");
        await advanceTaskLaunchPreparation(db, claim, "checkout_ready");
      } else await verifyWorkspace();
      await assertCurrent(db);
    },
    materialize: async (effect) => {
      if (identity.version !== 1)
        throw launchRefusal("workspace_protocol_unsupported", "PRECONDITION");
      const current = await lockedTaskLaunchClaim(db, claim);

      if (current.preparationPhase === "materialized") {
        await readCompletedMaterialization();

        return;
      }
      if (current.preparationPhase === "materializing") {
        await readCompletedMaterialization();
        await advanceTaskLaunchPreparation(db, claim, "materialized");

        return;
      }
      if (current.preparationPhase !== "checkout_ready")
        throw launchRefusal("launch_preparation_incomplete", "PRECONDITION");
      await advanceTaskLaunchPreparation(db, claim, "materializing");
      await withTaskLaunchCapabilityBundles(
        db,
        {
          projectId: intent.projectId,
          intentId: intent.id,
          runId: claim.identity.runId,
          directory: receiptDirectory,
          bundles: capabilityBundles,
        },
        effect,
      );
      await assertFrozenTaskLaunchRepository(db, intent);
      await assertCurrent(db);
      await mkdir(receiptDirectory, { recursive: true });
      await atomicWriteJson(receiptPath, {
        version: 1,
        intentId: intent.id,
        incarnationId: claim.identity.incarnationId,
        settingsDigest: intent.settingsDigest,
        contentDigest: await localDirectoryContentDigest(identity.worktreePath),
      });
      await advanceTaskLaunchPreparation(db, claim, "materialized");
    },
    beginBinding: async (tx) => {
      await takeSchedulerLock(tx);
      await lockTaskLaunchReservation(tx, intent.taskId);
      await lockTaskLaunchBoundRun(tx, intent.id);
      await lockedTaskLaunchClaim(tx, claim);
      await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.id, intent.taskId))
        .for("update");
      await assertCurrent(tx);
    },
    bindRun: async (tx) => {
      const current = await lockedTaskLaunchClaim(tx, claim);
      const [bound] = await tx
        .update(taskLaunchIntents)
        .set({
          state: "run_bound",
          stateVersion: current.stateVersion + 1,
          runId: claim.identity.runId,
          originalRunId: claim.identity.runId,
          preparationPhase: "run_bound",
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(taskLaunchIntents.id, current.id))
        .returning();

      await recordTaskAgentTriggerRunBound(tx, bound, claim.identity.runId);
      await emitTaskLaunchChanged(tx, bound, { type: "system", id: null });
    },
  };
}
