import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Run } from "@/lib/db/schema";
import type { TaskLaunchRequest } from "./launch-schema";
import type { TaskLaunchSettingsV2Snapshot } from "./launch-types";
import type { TaskLaunchServerSourceSnapshot } from "./launch-server-source";
import type { LaunchAgentRunInput } from "@/lib/agents/launch";

import { and, eq, isNotNull } from "drizzle-orm";

import {
  launchRefusal,
  taskLaunchSelectedConfiguration,
} from "./launch-resolution";
import { loadTaskQualificationInput } from "./qualification";
import { captureConcurrentTaskLaunchRelaunchSource } from "./launch-continuation";

import {
  projects,
  tasks,
  capabilityImports,
  capabilityRecords,
  agentProjectLinks,
  agents,
  packageInstalls,
  projectPackageAttachments,
  platformRuntimeSettings,
  runs,
  workspaces,
} from "@/lib/db/schema";
import { retryDigest } from "@/lib/agents/retry-guards";
import {
  resolveAgentConfig,
  validateInstanceConfig,
} from "@/lib/agents/config";
import { loadProjectMcpBindings } from "@/lib/mcp/binding-service";
import {
  resolveDeliveryPolicy,
  legacyPromotionModeFromStrategy,
} from "@/lib/runs/delivery-policy";
import { assertNoBlindShip } from "@/lib/runs/execution-policy";
import { MaisterError } from "@/lib/errors";
import { localDirectoryContentDigest } from "@/lib/flows";
import {
  resolveBaseCommit,
  assertBaseCommitReachable,
  listBranches,
} from "@/lib/worktree";
import { loadRunnerCatalog } from "@/lib/acp-runners/catalog";
import { splitQualifiedAgentId } from "@/lib/agents/effective";
import { buildAgentActivitySnapshot } from "@/lib/agents/activity-snapshot";
import { findSharedTreeWorkspace } from "@/lib/runs/shared-tree";

export function taskAgentPackageChanged(cause: unknown): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "The selected agent package cannot be reproduced; inspect its installation and launch again",
    {
      details: { reason: "launch_agent_package_changed" },
      cause,
    },
  );
}

export async function taskAgentPackageContentDigest(
  directory: string,
): Promise<string> {
  try {
    return await localDirectoryContentDigest(directory);
  } catch (cause) {
    throw taskAgentPackageChanged(cause);
  }
}

export type TaskAgentLaunchSnapshot = Readonly<{
  version: 1;
  packageInstallId: string;
  definitionSha256: string;
  configurationDigest: string;
  attachmentDigest: string;
  metadataDigest: string;
  selection: Readonly<{
    runnerId: string | null;
    workspace: "none" | "repo_read" | "worktree" | null;
  }>;
  packageContentDigest: string;
  manifestDigest: string;
  branchBase: string;
  workspaceRef: string | null;
  sharedRoot?: Readonly<{
    rootRunId: string;
    workspaceId: string | null;
    baseCommit: string;
    branch: string;
    targetBranch: string;
  }>;
  project: Readonly<{ mainBranch: string; branchPrefix: string | null }>;
}>;

export type ResolvedAgentLaunchSettings = Omit<
  Extract<TaskLaunchSettingsV2Snapshot, { kind: "agent" }>,
  "baseCommit"
> &
  Readonly<{ agentSnapshot: TaskAgentLaunchSnapshot }>;

/** Only reference identities and digests are retained; MCP credentials never enter an intent. */
export async function agentTaskLaunchCapabilityDigest(
  db: Db,
  projectId: string,
): Promise<string> {
  const [bindings, imports, records] = await Promise.all([
    loadProjectMcpBindings(projectId, db),
    db
      .select({
        id: capabilityImports.id,
        revision: capabilityImports.resolvedRevision,
        manifestDigest: capabilityImports.manifestDigest,
        installedPath: capabilityImports.installedPath,
        packageStatus: capabilityImports.packageStatus,
        setupStatus: capabilityImports.setupStatus,
        trustStatus: capabilityImports.trustStatus,
      })
      .from(capabilityImports)
      .where(eq(capabilityImports.projectId, projectId)),
    db
      .select({
        id: capabilityRecords.id,
        refId: capabilityRecords.capabilityRefId,
        kind: capabilityRecords.kind,
        source: capabilityRecords.source,
        revision: capabilityRecords.revision,
        material: capabilityRecords.material,
        enforceability: capabilityRecords.enforceability,
        disabled: isNotNull(capabilityRecords.disabledAt),
      })
      .from(capabilityRecords)
      .where(eq(capabilityRecords.projectId, projectId)),
  ]);

  return retryDigest({
    bindings: [...bindings].sort((a, b) => a.refId.localeCompare(b.refId)),
    imports: imports.sort((a, b) => a.id.localeCompare(b.id)),
    records: records.sort((a, b) => a.id.localeCompare(b.id)),
  });
}

/** Freeze execution-relevant attachment fields without timestamps or credentials. */
export function taskAgentAttachmentDigest(
  link: typeof agentProjectLinks.$inferSelect,
): string {
  return retryDigest({
    id: link.id,
    enabled: link.enabled,
    runnerOverrideId: link.runnerOverrideId,
    branchBase: link.branchBase,
    executionPolicyOverride: link.executionPolicyOverride,
    config: link.config,
    canReadBrain: link.canReadBrain,
    canWriteBrain: link.canWriteBrain,
    memoryEnabled: link.memoryEnabled,
    crossProjectReach: link.crossProjectReach,
    contextRepos: link.contextRepos,
  });
}

/** SQL/catalog-only fence, safe inside admission and first-dispatch transactions. */
export async function agentTargetMetadataToken(
  db: Db,
  project: typeof projects.$inferSelect,
  selection: Partial<TaskLaunchRequest>,
): Promise<string> {
  if (!selection.agentId)
    throw launchRefusal("launch_agent_target_invalid", "CONFIG");
  const { packageName } = splitQualifiedAgentId(selection.agentId);
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, selection.agentId));
  const [link] = await db
    .select()
    .from(agentProjectLinks)
    .where(
      and(
        eq(agentProjectLinks.agentId, selection.agentId),
        eq(agentProjectLinks.projectId, project.id),
      ),
    );
  const [installed] = await db
    .select({ install: packageInstalls })
    .from(projectPackageAttachments)
    .innerJoin(
      packageInstalls,
      eq(packageInstalls.id, projectPackageAttachments.packageInstallId),
    )
    .where(
      and(
        eq(projectPackageAttachments.projectId, project.id),
        eq(projectPackageAttachments.packageName, packageName),
      ),
    );
  const [runtime] = await db
    .select()
    .from(platformRuntimeSettings)
    .where(eq(platformRuntimeSettings.id, "singleton"));

  if (
    !agent?.enabled ||
    agent.quarantinedAt ||
    !link?.enabled ||
    !installed ||
    project.archivedAt ||
    installed.install.packageStatus !== "Installed" ||
    !["trusted", "trusted_by_policy"].includes(installed.install.trustStatus)
  )
    throw launchRefusal("launch_agent_unavailable", "PRECONDITION");
  const catalog = await loadRunnerCatalog(db);
  const chosenRunner = selection.runnerId
    ? catalog.find((runner) => runner.id === selection.runnerId)
    : null;

  if (selection.runnerId && (!chosenRunner?.enabled || !chosenRunner.ready))
    throw launchRefusal("launch_runner_unavailable", "PRECONDITION");

  return retryDigest({
    project: {
      id: project.id,
      repository:
        (selection.workspace ?? agent.workspace) === "none"
          ? null
          : project.repoPath,
      mainBranch: project.mainBranch,
      defaultRunnerId: project.defaultRunnerId,
      promotionMode: project.promotionMode,
      deliveryPolicy: project.deliveryPolicyDefault,
      executionPolicy: project.executionPolicyDefault,
    },
    selection: {
      agentId: selection.agentId,
      runnerId: selection.runnerId ?? null,
      workspace: selection.workspace ?? null,
    },
    agent: {
      id: agent.id,
      enabled: agent.enabled,
      kind: agent.kind,
      workspace: agent.workspace,
      mode: agent.mode,
      triggers: agent.triggers,
      sourcePath: agent.sourcePath,
      flowRef: agent.flowRef,
      runnerId: agent.runnerId,
      recommended: agent.recommended,
    },
    attachmentDigest: taskAgentAttachmentDigest(link),
    install: {
      id: installed.install.id,
      revision: installed.install.resolvedRevision,
      manifestDigest: installed.install.manifestDigest,
      manifest: installed.install.manifest,
      path: installed.install.installedPath,
      trust: installed.install.trustStatus,
    },
    platformRunner: runtime?.defaultRunnerId ?? null,
    runners: catalog
      .map((runner) => ({ id: runner.id, digest: retryDigest(runner) }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    capabilities: await agentTaskLaunchCapabilityDigest(db, project.id),
  });
}

/** Add the saved task settings and source binding without performing filesystem work. */
export async function agentTaskLaunchMetadataToken(
  db: Db,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  selection: Partial<TaskLaunchRequest>,
): Promise<string> {
  return retryDigest({
    target: await agentTargetMetadataToken(db, project, selection),
    task: taskLaunchSelectedConfiguration(task),
    relaunchSource: selection.relaunchOfRunId
      ? await captureConcurrentTaskLaunchRelaunchSource(db, {
          sourceRunId: selection.relaunchOfRunId,
          projectId: project.id,
          taskId: task.id,
        })
      : null,
  });
}

function agentResolutionToken(
  metadataDigest: string,
  snapshot: TaskAgentLaunchSnapshot,
): string {
  return retryDigest({
    metadataDigest,
    definitionSha256: snapshot.definitionSha256,
    configurationDigest: snapshot.configurationDigest,
    packageContentDigest: snapshot.packageContentDigest,
    manifestDigest: snapshot.manifestDigest,
    ...(snapshot.sharedRoot ? { sharedRoot: snapshot.sharedRoot } : {}),
  });
}

/** A borrower may observe a later-created root row only when it matches the accepted seed and branch. */
export async function assertTaskAgentSharedRootCurrent(
  db: Db,
  settings:
    | ResolvedAgentLaunchSettings
    | Extract<TaskLaunchSettingsV2Snapshot, { kind: "agent" }>,
  boundRunId: string | null,
): Promise<void> {
  const witness = settings.agentSnapshot?.sharedRoot;

  if (!witness) {
    if (
      settings.workspace === "worktree" &&
      settings.serverExecution?.execution.workspaceMode === "shared"
    )
      throw launchRefusal("launch_agent_snapshot_incomplete", "PRECONDITION");

    return;
  }
  const shared = await findSharedTreeWorkspace(db, witness.rootRunId);
  const [row] = shared
    ? await db.select().from(workspaces).where(eq(workspaces.id, shared.id))
    : [];

  if (!row) {
    if (witness.workspaceId || boundRunId)
      throw launchRefusal("launch_workspace_changed", "PRECONDITION");

    return;
  }
  if (
    (witness.workspaceId && row.id !== witness.workspaceId) ||
    row.baseCommit !== witness.baseCommit ||
    row.branch !== witness.branch ||
    row.targetBranch !== witness.targetBranch
  )
    throw launchRefusal("launch_workspace_changed", "PRECONDITION");
}

/** Reuses verified preflight bytes while rechecking every mutable SQL setting under the task lock. */
export async function resolvePreparedAgentTaskLaunchSettings(
  db: Db,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  selection: Partial<TaskLaunchRequest>,
  prepared: ResolvedAgentLaunchSettings,
): Promise<ResolvedAgentLaunchSettings> {
  const metadataDigest = await agentTaskLaunchMetadataToken(
    db,
    task,
    project,
    selection,
  );

  if (metadataDigest !== prepared.agentSnapshot.metadataDigest)
    throw launchRefusal("launch_settings_changed");
  await assertTaskAgentSharedRootCurrent(db, prepared, null);

  return {
    ...prepared,
    taskSettingsDigest: retryDigest(taskLaunchSelectedConfiguration(task)),
    resolutionToken: agentResolutionToken(
      metadataDigest,
      prepared.agentSnapshot,
    ),
  };
}

/** A stored source keeps its mechanical trigger separate from the intent admission basis. */
export function storedTaskAgentLaunchTrigger(
  source: TaskLaunchServerSourceSnapshot,
): LaunchAgentRunInput["trigger"] {
  const triggerSource = source.execution.triggerSource;

  if (
    !triggerSource ||
    !["manual", "cron", "domain_event", "webhook", "flow"].includes(
      triggerSource,
    )
  )
    throw launchRefusal("launch_source_snapshot_incomplete", "PRECONDITION");

  return {
    source: triggerSource as LaunchAgentRunInput["trigger"]["source"],
    eventId: source.execution.triggerEventId ?? null,
    payload: source.execution.triggerPayload ?? null,
  };
}

/** Same registered definition, attachment, trust, runner and read-only capability checks as direct agent launch. */
export async function resolveAgentTaskLaunchSettings(
  db: Db,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  selection: Partial<TaskLaunchRequest>,
): Promise<ResolvedAgentLaunchSettings> {
  return resolveAgentTaskLaunchSettingsForTrigger(
    db,
    task,
    project,
    selection,
    { source: "manual" },
  );
}

/** Only a verified server source supplies noninteractive trigger provenance. */
export async function resolveServerAgentTaskLaunchSettings(
  db: Db,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  selection: Partial<TaskLaunchRequest>,
  source: TaskLaunchServerSourceSnapshot,
): Promise<ResolvedAgentLaunchSettings> {
  if (
    source.projectId !== project.id ||
    source.taskId !== task.id ||
    source.execution.agentId !== selection.agentId ||
    (source.agentWorkspace !== undefined &&
      source.agentWorkspace !== selection.workspace)
  )
    throw launchRefusal("launch_source_changed", "PRECONDITION");
  const { assertStoredTaskLaunchServerSource } =
    await import("./launch-server-source");

  await assertStoredTaskLaunchServerSource(db, source);

  const settings = await resolveAgentTaskLaunchSettingsForTrigger(
    db,
    task,
    project,
    selection,
    storedTaskAgentLaunchTrigger(source),
  );

  if (
    settings.workspace !== "worktree" ||
    source.execution.workspaceMode !== "shared"
  )
    return { ...settings, serverExecution: source };
  const rootRunId = source.execution.rootRunId;

  if (!rootRunId || !source.execution.parentRunId)
    throw launchRefusal("launch_source_snapshot_incomplete", "PRECONDITION");
  const shared = await findSharedTreeWorkspace(db, rootRunId);
  const [row] = shared
    ? await db.select().from(workspaces).where(eq(workspaces.id, shared.id))
    : [];

  if (row && !row.baseCommit)
    throw launchRefusal("launch_agent_snapshot_incomplete", "PRECONDITION");
  const sharedRoot = {
    rootRunId,
    workspaceId: row?.id ?? null,
    baseCommit:
      row?.baseCommit ??
      (await resolveBaseCommit({
        projectRepoPath: project.repoPath,
        baseRef: settings.baseBranch,
        preferRemote: "origin",
      })),
    branch:
      row?.branch ?? `${project.branchPrefix ?? "maister/"}agents/${rootRunId}`,
    targetBranch: row?.targetBranch ?? settings.baseBranch,
  };
  const agentSnapshot = { ...settings.agentSnapshot, sharedRoot };

  return {
    ...settings,
    agentSnapshot,
    baseBranch: sharedRoot.targetBranch,
    serverExecution: source,
    resolutionToken: agentResolutionToken(
      agentSnapshot.metadataDigest,
      agentSnapshot,
    ),
  };
}

/** Read-only handoff preview retains the original mechanical trigger without minting launch authority. */
export async function resolveInteractiveTaskAgentHandoffSettings(
  db: Db,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  selection: Partial<TaskLaunchRequest>,
  originalRun: Run,
): Promise<ResolvedAgentLaunchSettings> {
  const [source] = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.id, originalRun.id),
        eq(runs.projectId, project.id),
        eq(runs.taskId, task.id),
      ),
    );

  if (
    !source ||
    source.runKind !== "agent" ||
    source.agentKind !== "code_delivery" ||
    source.agentId !== selection.agentId ||
    source.agentWorkspace !== selection.workspace ||
    selection.relaunchOfRunId !== source.id ||
    !source.triggerSource ||
    !["manual", "cron", "domain_event", "webhook", "flow"].includes(
      source.triggerSource,
    )
  )
    throw launchRefusal("launch_source_changed", "PRECONDITION");

  return resolveAgentTaskLaunchSettingsForTrigger(
    db,
    task,
    project,
    selection,
    {
      source: source.triggerSource as LaunchAgentRunInput["trigger"]["source"],
      eventId: source.triggerEventId,
      payload: source.triggerPayload,
    },
  );
}

async function resolveAgentTaskLaunchSettingsForTrigger(
  db: Db,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  selection: Partial<TaskLaunchRequest>,
  trigger: LaunchAgentRunInput["trigger"],
): Promise<ResolvedAgentLaunchSettings> {
  if (
    Object.values(selection.packageVersions ?? {}).some(
      (choice) => choice !== "keep",
    )
  )
    throw launchRefusal("launch_request_setup_required", "PRECONDITION");
  if (!selection.agentId || selection.flowId)
    throw launchRefusal("launch_agent_target_invalid", "CONFIG");
  const metadataDigest = await agentTaskLaunchMetadataToken(
    db,
    task,
    project,
    selection,
  );
  const { resolveAgentLaunchRuntime, resolveAgentContextExecutionPolicy } =
    await import("@/lib/agents/launch");
  const runtime = await resolveAgentLaunchRuntime({
    agentId: selection.agentId,
    projectId: project.id,
    taskId: task.id,
    workspace: selection.workspace,
    launchOverrideRunnerId: selection.runnerId,
    trigger,
    db,
  });

  if (
    runtime.effective.parsed.kind !== "code_delivery" ||
    runtime.effective.parsed.flow
  )
    throw launchRefusal("launch_agent_target_unsupported", "PRECONDITION");
  const configuration = resolveAgentConfig(
    runtime.effective.parsed.config,
    runtime.link.config ?? null,
  );
  const configError = validateInstanceConfig(
    runtime.effective.parsed.config,
    configuration,
  );

  if (configError)
    throw launchRefusal("launch_agent_configuration_invalid", "CONFIG");
  const workspace = selection.workspace ?? runtime.effective.parsed.workspace;
  const declaredRef =
    workspace === "repo_read" ? runtime.effective.parsed.workspaceRef : null;

  const resolvedWorkspaceRef =
    declaredRef === "trigger"
      ? await (
          await import("@/lib/agents/launch")
        ).resolveWorkspaceRefCommittish(db, {
          agentId: selection.agentId,
          workspaceRef: declaredRef,
          repoPath: project.repoPath,
          trigger,
        })
      : runtime.effective.parsed.workspaceRef;
  const baseBranch =
    selection.baseBranch ??
    (declaredRef === "trigger" ? null : declaredRef) ??
    runtime.link.branchBase ??
    runtime.effective.parsed.recommended?.branch_base ??
    task.baseBranch ??
    project.mainBranch;
  const targetBranch =
    selection.targetBranch ??
    selection.deliveryPolicy?.targetBranch ??
    task.targetBranch ??
    baseBranch;
  const deliveryPolicy = resolveDeliveryPolicy({
    projectDefault: project.deliveryPolicyDefault,
    projectPromotionMode: project.promotionMode,
    projectMainBranch: project.mainBranch,
    launchOverride: { ...selection.deliveryPolicy, targetBranch },
  });
  const executionPolicy =
    selection.executionPolicy ?? resolveAgentContextExecutionPolicy(runtime);

  assertNoBlindShip(executionPolicy);
  const {
    env: _environment,
    provider: _provider,
    ...identity
  } = runtime.resolution.runnerSnapshot;
  const agentSnapshot: TaskAgentLaunchSnapshot = {
    version: 1,
    packageInstallId: runtime.effective.packageInstallId,
    definitionSha256: buildAgentActivitySnapshot(
      selection.agentId,
      runtime.effective,
    ).definitionSha256,
    configurationDigest: retryDigest(configuration),
    attachmentDigest: taskAgentAttachmentDigest(
      runtime.link as typeof agentProjectLinks.$inferSelect,
    ),
    metadataDigest,
    selection: {
      runnerId: selection.runnerId ?? null,
      workspace: selection.workspace ?? null,
    },
    packageContentDigest: await taskAgentPackageContentDigest(
      runtime.effective.installedPath,
    ),
    manifestDigest: retryDigest(runtime.effective.manifest),
    branchBase: baseBranch,
    workspaceRef: resolvedWorkspaceRef,
    project: {
      mainBranch: project.mainBranch,
      branchPrefix: project.branchPrefix,
    },
  };
  const settings = {
    version: 2 as const,
    kind: "agent" as const,
    workspace,
    agentId: selection.agentId,
    definitionSha256: agentSnapshot.definitionSha256,
    agentSnapshot,
    flowId: null,
    flowRefId: null,
    flowRevisionId: null,
    packageInstallId: runtime.effective.packageInstallId,
    sessions: [
      {
        sessionName: "default",
        runnerId: runtime.resolution.runnerId,
        runnerResolutionTier: runtime.resolution.runnerResolutionTier,
        runnerSnapshot: identity,
        runnerConfigDigest: retryDigest(runtime.resolution.runnerSnapshot),
      },
    ],
    baseBranch,
    targetBranch,
    deliveryPolicy,
    executionPolicy,
    promotionMode:
      deliveryPolicy.strategy === "ai_rebase_merge"
        ? ("rebase_merge" as const)
        : legacyPromotionModeFromStrategy(deliveryPolicy.strategy),
    autoPromote: selection.autoPromote ?? true,
    brainContext: selection.brainContext ?? null,
    packageVersions: selection.packageVersions ?? {},
    relaunchSource: selection.relaunchOfRunId
      ? await captureConcurrentTaskLaunchRelaunchSource(db, {
          sourceRunId: selection.relaunchOfRunId,
          projectId: project.id,
          taskId: task.id,
        })
      : null,
    resolvedCapabilitySet: null,
    capabilityResolutionDigest: await agentTaskLaunchCapabilityDigest(
      db,
      project.id,
    ),
    taskSettingsDigest: retryDigest(taskLaunchSelectedConfiguration(task)),
  };

  if (
    (await agentTaskLaunchMetadataToken(db, task, project, selection)) !==
    metadataDigest
  )
    throw launchRefusal("launch_settings_changed");

  return {
    ...settings,
    resolutionToken: agentResolutionToken(metadataDigest, agentSnapshot),
  };
}

export async function agentTaskLaunchSettingsToken(
  db: Db,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  selection: Partial<TaskLaunchRequest>,
): Promise<string> {
  return (await resolveAgentTaskLaunchSettings(db, task, project, selection))
    .resolutionToken;
}

/** None has no repository requirement; automatic qualification evidence remains a separate real repository fact. */
export async function resolveTaskLaunchBase(
  _db: Db,
  project: typeof projects.$inferSelect,
  settings: {
    workspace: "none" | "repo_read" | "worktree";
    baseBranch: string;
    targetBranch: string;
    agentSnapshot?: TaskAgentLaunchSnapshot;
  },
  request: Partial<TaskLaunchRequest>,
): Promise<{ baseCommit: string | null; currentBaseCommit: string | null }> {
  if (settings.workspace === "none") {
    if (request.baseCommit)
      throw launchRefusal("launch_agent_target_invalid", "CONFIG");

    return { baseCommit: null, currentBaseCommit: null };
  }
  const branches = new Set(
    await listBranches(project.repoPath, { includeRemotes: true }),
  );

  if (
    !branches.has(settings.baseBranch) ||
    !branches.has(settings.targetBranch)
  )
    throw launchRefusal("launch_target_unavailable", "PRECONDITION");
  const currentBaseCommit = await resolveBaseCommit({
    projectRepoPath: project.repoPath,
    baseRef:
      settings.workspace === "repo_read" && settings.agentSnapshot
        ? (settings.agentSnapshot.workspaceRef ?? "HEAD")
        : settings.baseBranch,
    preferRemote: "origin",
  });
  const sharedSeed = settings.agentSnapshot?.sharedRoot?.baseCommit;

  if (sharedSeed && request.baseCommit && request.baseCommit !== sharedSeed)
    throw launchRefusal("launch_settings_changed");
  const selectedCommit = sharedSeed ?? request.baseCommit;
  const baseCommit = selectedCommit
    ? await assertBaseCommitReachable({
        projectRepoPath: project.repoPath,
        baseRef: settings.baseBranch,
        baseCommit: selectedCommit,
        preferRemote: "origin",
      })
    : currentBaseCommit;

  return { baseCommit, currentBaseCommit };
}

/** Qualification evidence is independent of a repository-less execution workspace. */
export async function resolveTaskLaunchAutomaticEvidenceCommit(
  db: Db,
  project: typeof projects.$inferSelect,
  taskId: string,
): Promise<string> {
  const qualification = await loadTaskQualificationInput(
    db,
    project.id,
    taskId,
  );

  return resolveBaseCommit({
    projectRepoPath: project.repoPath,
    baseRef: qualification.target,
    preferRemote: "origin",
  });
}
