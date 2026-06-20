import "server-only";

import type {
  RunStatus,
  ScratchDialogStatus,
  ScratchPlanMode,
  ScratchReasoningEffort,
  ScratchWorkMode,
} from "@/lib/db/schema";
import type { CapabilityAgent } from "@/lib/config.schema";
import type {
  ScratchLaunchInput,
  ScratchMessageInput,
  ScratchUploadedFileInput,
} from "@/lib/scratch-runs/types";
import type { PromptStopReason } from "@/lib/supervisor-client";

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import { and, eq, inArray, sql } from "drizzle-orm";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import {
  resolveRunner,
  type RunnerCatalogEntry,
} from "@/lib/acp-runners/resolve";
import {
  mergeRunnerAdapterLaunch,
  runnerExecutorInput,
  runnerSupervisorInput,
} from "@/lib/acp-runners/spawn-intent";
import {
  materializeAdapterCapabilityHome,
  materializeFlowAuthoringSkill,
} from "@/lib/capabilities/adapter-home";
import { materializeCapabilityProfile } from "@/lib/capabilities/materialize";
import {
  loadSelectableCapabilities,
  resolveCapabilityProfile,
} from "@/lib/capabilities/resolver";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { runtimeRoot, worktreesRoot } from "@/lib/instance-config";
import {
  assertScratchCapacityAvailable,
  assertScratchCapacityAvailableInTransaction,
} from "@/lib/scheduler";
import { atomicWriteBuffer } from "@/lib/atomic";
import {
  metadataAttachmentRow,
  scratchPromptContentBlocks,
  uploadedFileMetadata,
  validateScratchAttachments,
} from "@/lib/scratch-runs/attachments";
import {
  normalizeScratchPrompt,
  sendScratchPromptAndProjectEvents,
} from "@/lib/scratch-runs/events";
import {
  decoratePromptForPlanMode,
  deriveScratchBranchName,
  planModeToWorkMode,
  scratchNameFallback,
  scratchStepId,
  workModeToPlanMode,
} from "@/lib/scratch-runs/launch";
import {
  launchProgress,
  type LaunchProgressEvent,
} from "@/lib/runs/launch-progress";
import {
  nextScratchMessageSequence,
  userScratchMessageDraft,
} from "@/lib/scratch-runs/messages";
import {
  assertScratchCanAcceptUserMessage,
  dialogStatusAfterPromptCompletion,
  dialogStatusAfterSupervisorStop,
  isTerminalScratchDialogStatus,
  runStatusForDialogStatus,
} from "@/lib/scratch-runs/state";
import {
  checkSupervisorHealth,
  createSession,
  deleteSession,
} from "@/lib/supervisor-client";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";
import {
  addWorktree,
  branchExists,
  currentBranchName,
  headCommit,
  removeBranch,
  removeWorktree,
  resolveBaseCommit,
} from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const {
  capabilityImports,
  localPackages,
  platformAcpRunners,
  platformRouterSidecars,
  platformRuntimeSettings,
  projects,
  runs,
  scratchAttachments,
  scratchCapabilityProfiles,
  scratchMessages,
  scratchRuns,
  tasks,
  workspaces,
} = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

type ScratchResolvedRunner = {
  resolution: ReturnType<typeof resolveRunner>;
  executor: {
    id: string;
    agent: CapabilityAgent;
    model: string;
    executorRefId: string;
    env: null;
    router: "ccr" | null;
  };
};

const log = pino({
  name: "scratch-service",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ScratchRunResponse = {
  runId: string;
  dialogUrl: string;
  status: {
    runId: string;
    projectId: string;
    name: string | null;
    runStatus: RunStatus;
    dialogStatus: ScratchDialogStatus;
    branchName: string;
    baseBranch: string;
    baseCommit: string;
    targetBranch: string | null;
    workMode: ScratchWorkMode;
    reasoningEffort: ScratchReasoningEffort;
    planMode: ScratchPlanMode;
  };
};

export type ScratchMessageResponse = {
  ok: true;
  messageId: string;
  sequence: number;
  dialogStatus: ScratchDialogStatus;
  stopReason: PromptStopReason;
};

function isPostgresDb(): boolean {
  const url = process.env.DB_URL ?? "";

  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

async function lockRunRows(tx: Db, runId: string): Promise<void> {
  if (!isPostgresDb()) return;

  await tx.execute(sql`SELECT id FROM runs WHERE id = ${runId} FOR UPDATE`);
  await tx.execute(
    sql`SELECT run_id FROM scratch_runs WHERE run_id = ${runId} FOR UPDATE`,
  );
}

function launchResponse(args: {
  runId: string;
  projectId: string;
  name: string | null;
  runStatus: RunStatus;
  dialogStatus: ScratchDialogStatus;
  branchName: string;
  baseBranch: string;
  baseCommit: string;
  targetBranch: string | null;
  workMode: ScratchWorkMode;
  reasoningEffort: ScratchReasoningEffort;
  planMode: ScratchPlanMode;
}): ScratchRunResponse {
  return {
    runId: args.runId,
    dialogUrl: `/scratch-runs/${args.runId}`,
    status: {
      runId: args.runId,
      projectId: args.projectId,
      name: args.name,
      runStatus: args.runStatus,
      dialogStatus: args.dialogStatus,
      branchName: args.branchName,
      baseBranch: args.baseBranch,
      baseCommit: args.baseCommit,
      targetBranch: args.targetBranch,
      workMode: args.workMode,
      reasoningEffort: args.reasoningEffort,
      planMode: args.planMode,
    },
  };
}

function messageResponse(args: {
  messageId: string;
  sequence: number;
  dialogStatus: ScratchDialogStatus;
  stopReason: PromptStopReason;
}): ScratchMessageResponse {
  return {
    ok: true,
    messageId: args.messageId,
    sequence: args.sequence,
    dialogStatus: args.dialogStatus,
    stopReason: args.stopReason,
  };
}

async function loadProject(db: Db, projectId: string) {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId));
  const project = rows[0];

  if (!project || project.archivedAt) {
    throw new MaisterError("PRECONDITION", `project not found: ${projectId}`);
  }

  return project;
}

function runnerProviderKind(provider: unknown): string {
  if (
    provider &&
    typeof provider === "object" &&
    "kind" in provider &&
    typeof provider.kind === "string"
  ) {
    return provider.kind;
  }

  throw new MaisterError(
    "CONFIG",
    `platform ACP runner has invalid provider payload: ${JSON.stringify(provider)}`,
  );
}

function runnerCatalogEntry(
  row: Record<string, any>,
  sidecarById: ReadonlyMap<string, Record<string, any>>,
): RunnerCatalogEntry {
  const sidecar = row.sidecarId ? sidecarById.get(row.sidecarId) : undefined;

  return {
    id: row.id,
    adapter: row.adapter,
    capabilityAgent: row.capabilityAgent,
    model: row.model,
    provider: row.provider,
    providerKind: runnerProviderKind(row.provider),
    permissionPolicy: row.permissionPolicy,
    sidecar: sidecar
      ? {
          id: sidecar.id,
          kind: sidecar.kind,
          lifecycle: sidecar.lifecycle,
          configPath: sidecar.configPath,
          baseUrl: sidecar.baseUrl,
          healthcheckUrl: sidecar.healthcheckUrl,
          authTokenRef: sidecar.authTokenRef,
        }
      : null,
    sidecarId: row.sidecarId,
    enabled: row.enabled,
    ready: row.readinessStatus === "Ready",
  };
}

async function resolveScratchRunner(
  db: Db,
  body: ScratchLaunchInput,
  project: any,
): Promise<ScratchResolvedRunner> {
  const runtimeRows = await db
    .select()
    .from(platformRuntimeSettings)
    .where(eq(platformRuntimeSettings.id, "singleton"));
  const platformRuntime = runtimeRows[0];

  if (!platformRuntime) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "platform default ACP runner is not configured",
    );
  }

  const runnerRows = await db.select().from(platformAcpRunners);
  const sidecarRows = await db.select().from(platformRouterSidecars);
  const sidecarById = new Map<string, Record<string, any>>(
    sidecarRows.map((row: Record<string, any>) => [row.id, row]),
  );
  const resolution = resolveRunner({
    launchOverrideRunnerId: body.runnerId,
    step: { runnerId: null },
    projectFlow: { defaultRunnerId: null },
    platformFlow: { defaultRunnerId: null },
    project: { defaultRunnerId: project.defaultRunnerId },
    platform: { defaultRunnerId: platformRuntime.defaultRunnerId },
    runners: runnerRows.map((row: Record<string, any>) =>
      runnerCatalogEntry(row, sidecarById),
    ),
  });

  return {
    resolution,
    executor: {
      id: resolution.runnerId,
      agent: resolution.capabilityAgent as CapabilityAgent,
      model: resolution.runnerSnapshot.model,
      executorRefId: resolution.runnerId,
      env: null,
      router: resolution.runnerSnapshot.sidecarId ? "ccr" : null,
    },
  };
}

async function validateLinkedTask(
  db: Db,
  linkedTaskId: string | undefined,
  projectId: string,
): Promise<void> {
  if (!linkedTaskId) return;

  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, linkedTaskId), eq(tasks.projectId, projectId)));

  if (rows.length === 0) {
    throw new MaisterError(
      "PRECONDITION",
      `linked task ${linkedTaskId} is not in project ${projectId}`,
    );
  }
}

function resolveScratchBranch(args: {
  body: ScratchLaunchInput;
  project: any;
  runId: string;
}): string {
  const requested = args.body.branchName?.trim() ?? "";

  if (requested.length > 0) return requested;

  return deriveScratchBranchName({
    branchPrefix: args.project.branchPrefix,
    projectSlug: args.project.slug,
    requestedName: args.body.name,
    runId: args.runId,
  });
}

function scratchPolicy(body: {
  workMode?: ScratchWorkMode;
  planMode?: ScratchPlanMode;
  reasoningEffort?: ScratchReasoningEffort;
}): {
  workMode: ScratchWorkMode;
  reasoningEffort: ScratchReasoningEffort;
  planMode: ScratchPlanMode;
} {
  const workMode = body.workMode ?? planModeToWorkMode(body.planMode ?? "off");
  const reasoningEffort = body.reasoningEffort ?? "high";

  return {
    workMode,
    reasoningEffort,
    planMode: workModeToPlanMode(workMode),
  };
}

function storedAttachmentValues(args: {
  metadataAttachments: ReturnType<typeof metadataAttachmentRow>[];
  uploadedAttachments: ReturnType<typeof uploadedFileMetadata>[];
  runId: string;
  messageId: string | null;
}) {
  return [...args.metadataAttachments, ...args.uploadedAttachments].map(
    (attachment) => ({
      id: randomUUID(),
      runId: args.runId,
      messageId: args.messageId,
      kind: attachment.kind,
      label: attachment.label,
      value: attachment.value,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize,
      sha256: attachment.sha256,
      storagePath: attachment.storagePath,
    }),
  );
}

async function storeUploadedFiles(args: {
  runId: string;
  messageId: string | null;
  projectSlug: string;
  scope: string;
  files: readonly ScratchUploadedFileInput[];
}): Promise<ReturnType<typeof uploadedFileMetadata>[]> {
  if (args.files.length === 0) return [];

  const root = runtimeRoot();
  const safeNames = new Set<string>();
  const attachments = args.files.map((file) =>
    uploadedFileMetadata({
      file,
      projectSlug: args.projectSlug,
      runId: args.runId,
      scope: args.scope,
      runtimeRoot: root,
    }),
  );

  for (const attachment of attachments) {
    if (!attachment.fileName) continue;
    if (safeNames.has(attachment.fileName)) {
      throw new MaisterError(
        "PRECONDITION",
        `duplicate upload filename: ${attachment.fileName}`,
      );
    }
    safeNames.add(attachment.fileName);
  }

  for (const [index, attachment] of attachments.entries()) {
    if (!attachment.storagePath) continue;
    const source = args.files[index];

    if (!source) {
      throw new MaisterError(
        "PRECONDITION",
        `stored upload metadata missing source file: ${attachment.label}`,
      );
    }

    try {
      await atomicWriteBuffer(attachment.storagePath, source.bytes);
      log.info(
        {
          runId: args.runId,
          messageId: args.messageId,
          fileName: attachment.fileName,
          byteSize: attachment.byteSize,
          sha256: attachment.sha256,
        },
        "scratch upload stored",
      );
    } catch (err) {
      log.error(
        {
          runId: args.runId,
          messageId: args.messageId,
          path: attachment.storagePath,
          err: err instanceof Error ? err.message : String(err),
        },
        "scratch upload write failed",
      );
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        `failed to store uploaded file ${attachment.fileName}`,
      );
    }
  }

  return attachments;
}

function downgradeNotes(
  profile: ReturnType<typeof resolveCapabilityProfile>,
): Record<string, unknown> | null {
  if (profile.downgraded.length === 0) return null;

  return {
    downgraded: profile.downgraded.map((entry) => ({
      kind: entry.kind,
      capabilityRefId: entry.capabilityRefId,
      reason: entry.reason,
    })),
  };
}

export async function markScratchCrashed(args: {
  db?: Db;
  runId: string;
  err: unknown;
  clearSupervisorSession?: boolean;
}): Promise<void> {
  const db = args.db ?? getDb();
  const errorCode = isMaisterError(args.err) ? args.err.code : "CRASH";
  const errorMessage =
    args.err instanceof Error ? args.err.message : String(args.err);
  const endedAt = new Date();
  const scratchUpdate: Record<string, unknown> = {
    dialogStatus: "Crashed",
    errorCode,
    errorMessage,
    updatedAt: endedAt,
  };

  if (args.clearSupervisorSession) {
    scratchUpdate.supervisorSessionId = null;
  }

  await db.transaction(async (tx: Db) => {
    // CAS-before-write: only flip a still-live scratch run to Crashed. The
    // allow-list (never `!terminal`) lets the reconcile sweep crash a Running
    // scratch run, while a duplicate call on an already-terminal row is a
    // safe no-op that leaves the run record untouched. Only the CAS winner
    // stamps the scratch metadata.
    const rows = await tx
      .update(runs)
      .set({ status: "Crashed", endedAt, currentStepId: null })
      .where(
        and(
          eq(runs.id, args.runId),
          inArray(runs.status, [
            "Running",
            "NeedsInput",
            "NeedsInputIdle",
            "HumanWorking",
          ]),
        ),
      )
      .returning({ id: runs.id, projectId: runs.projectId });

    if (rows.length === 0) {
      log.warn(
        { runId: args.runId, errorCode },
        "markScratchCrashed: status-guard mismatch — already terminal or gone",
      );

      return;
    }

    await tx
      .update(scratchRuns)
      .set(scratchUpdate)
      .where(eq(scratchRuns.runId, args.runId));

    // ADR-096: a project-less local-package assistant run has no project to
    // attribute domain/webhook events to (both require a non-null projectId,
    // and the consumers are project-scoped). Skip the emits for it; the run's
    // own scratch_runs/runs terminal rows are the record.
    if (rows[0].projectId) {
      const projectId = rows[0].projectId;

      await emitWebhookEvent({
        db: tx,
        type: "run.crashed",
        projectId,
        runId: args.runId,
        data: { errorCode },
      });

      await emitDomainEvent({
        db: tx,
        kind: "run.crashed",
        projectId,
        runId: args.runId,
        actor: { type: "system", id: null },
        payload: {
          runId: args.runId,
          taskId: null,
          flowId: null,
          runKind: "scratch",
          reason: errorCode ?? null,
        },
      });
    }
  });
}

export async function markScratchPromptRetryable(args: {
  db?: Db;
  runId: string;
  err: unknown;
}): Promise<void> {
  const db = args.db ?? getDb();
  const errorCode = isMaisterError(args.err)
    ? args.err.code
    : "EXECUTOR_UNAVAILABLE";
  const errorMessage =
    args.err instanceof Error ? args.err.message : String(args.err);
  const now = new Date();

  await db.transaction(async (tx: Db) => {
    await tx
      .update(scratchRuns)
      .set({
        dialogStatus: "WaitingForUser",
        errorCode,
        errorMessage,
        updatedAt: now,
      })
      .where(eq(scratchRuns.runId, args.runId));
    await tx
      .update(runs)
      .set({ status: "Running", currentStepId: scratchStepId() })
      .where(eq(runs.id, args.runId));
  });

  log.warn(
    { runId: args.runId, errorCode, errorMessage },
    "scratch prompt failed after message persistence; dialog left retryable",
  );
}

export async function completeScratchPromptTurn(args: {
  db?: Db;
  runId: string;
}): Promise<ScratchDialogStatus> {
  const db = args.db ?? getDb();

  return db.transaction(async (tx: Db) => {
    await lockRunRows(tx, args.runId);

    const rows = await tx
      .select()
      .from(scratchRuns)
      .where(eq(scratchRuns.runId, args.runId));
    const scratch = rows[0];

    if (!scratch) {
      throw new MaisterError(
        "PRECONDITION",
        `scratch metadata not found: ${args.runId}`,
      );
    }

    const nextStatus = dialogStatusAfterPromptCompletion(
      scratch.dialogStatus as ScratchDialogStatus,
    );

    if (nextStatus === scratch.dialogStatus) {
      log.info(
        { runId: args.runId, dialogStatus: nextStatus },
        "scratch prompt completion preserved event-derived status",
      );

      return nextStatus;
    }

    const now = new Date();

    await tx
      .update(scratchRuns)
      .set({ dialogStatus: nextStatus, updatedAt: now })
      .where(eq(scratchRuns.runId, args.runId));
    await tx
      .update(runs)
      .set({ status: runStatusForDialogStatus(nextStatus) })
      .where(eq(runs.id, args.runId));

    log.info(
      { runId: args.runId, previousStatus: scratch.dialogStatus, nextStatus },
      "scratch prompt completion transitioned idle",
    );

    return nextStatus;
  });
}

// Phase 6 (FR-F1/F2): the staged launch. Runs every precondition up to the
// first `yield "precondition"`, so the route can drive ONE `.next()` and turn
// a head-check failure into a JSON error (status preserved) BEFORE committing
// to a `text/event-stream` response. Once past `precondition`, each side-effect
// boundary yields a progress event and the final `return` is the result frame.
// `opts.signal` is checked at each side-effect boundary so a client cancel GCs
// the worktree (pre-commit) or marks the run Crashed (post-commit) — no orphan.
export async function* launchScratchRunStaged(
  args: {
    body: ScratchLaunchInput;
    uploadedFiles?: readonly ScratchUploadedFileInput[];
    userId: string;
  },
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<LaunchProgressEvent, ScratchRunResponse, void> {
  const db = getDb() as Db;
  const project = await loadProject(db, args.body.projectId);

  await requireProjectAction(project.id, "launchRun");

  const { executor, resolution: runnerResolution } = await resolveScratchRunner(
    db,
    args.body,
    project,
  );

  await validateLinkedTask(db, args.body.linkedTaskId, project.id);

  const catalog = await loadSelectableCapabilities(project.id, db);
  const policy = scratchPolicy(args.body);
  // FR-C3: scratch materializes a BROAD skill set (all project skills; the
  // resolver filters to runner-supported). MCP stays selected/defaults.
  const broadSkillIds = catalog
    .filter((record) => record.kind === "skill")
    .map((record) => record.capabilityRefId);
  const profile = resolveCapabilityProfile({
    projectId: project.id,
    executorAgent: executor.agent,
    selectedMcpIds: args.body.capabilities?.mcpIds,
    selectedSkillIds: broadSkillIds,
    selectedRuleIds: args.body.capabilities?.ruleIds,
    selectedAgentDefinitionIds: args.body.capabilities?.agentDefinitionIds,
    selectedRestrictionIds: args.body.capabilities?.restrictionIds,
    planMode: policy.planMode,
    workMode: policy.workMode,
    reasoningEffort: policy.reasoningEffort,
    catalog,
  });
  const platformStatus = await checkSupervisorHealth();

  if (platformStatus.kind === "unavailable") {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `supervisor unavailable (${platformStatus.reason}): ${platformStatus.message}`,
    );
  }

  await assertScratchCapacityAvailable({ db });

  const runId = randomUUID();
  const branch = resolveScratchBranch({ body: args.body, project, runId });
  const baseCommit = await resolveBaseCommit({
    projectRepoPath: project.repoPath,
    baseRef: args.body.baseBranch,
  });

  if (await branchExists({ projectRepoPath: project.repoPath, branch })) {
    throw new MaisterError(
      "PRECONDITION",
      `scratch branch already exists: ${branch}`,
    );
  }

  const worktreePath = path.join(worktreesRoot(), project.slug, runId);
  const rawPrompt = args.body.prompt.trim();
  const hasInitialPrompt = rawPrompt.length > 0;
  const prompt = hasInitialPrompt
    ? decoratePromptForPlanMode({
        planMode: policy.planMode,
        workMode: policy.workMode,
        reasoningEffort: policy.reasoningEffort,
        prompt: rawPrompt,
      })
    : "";
  const now = new Date();
  const name = args.body.name?.trim() || scratchNameFallback(args.body.prompt);
  const messageId = hasInitialPrompt ? randomUUID() : null;
  const initialMessage = hasInitialPrompt
    ? userScratchMessageDraft({
        sequence: 1,
        content: rawPrompt,
      })
    : null;
  const validatedAttachments = validateScratchAttachments(
    args.body.attachments,
    {
      projectRepoPath: project.repoPath,
      worktreePath,
    },
  );
  const uploadedFiles = args.uploadedFiles ?? [];
  let worktreeCreated = false;
  let uploadedAttachments: ReturnType<typeof uploadedFileMetadata>[] = [];

  // Every precondition has passed; the route turns this first yield into the
  // signal to start streaming (a throw above here is still a JSON error).
  yield launchProgress("precondition");

  await addWorktree({
    projectRepoPath: project.repoPath,
    branch,
    worktreePath,
    startPoint: args.body.baseBranch,
  });
  worktreeCreated = true;
  yield launchProgress("worktree_created");

  let materialized: Awaited<ReturnType<typeof materializeCapabilityProfile>>;
  // FR-C2/C3: per-adapter capability home env (e.g. codex CODEX_HOME), merged
  // into the session adapterLaunch below. Empty for claude (cwd `.claude/`).
  let adapterHomeEnv: Record<string, string> = {};

  try {
    // Cancel here (pre-commit) compensates the worktree+branch via this catch.
    opts.signal?.throwIfAborted();
    yield launchProgress("materializing", executor.agent);
    materialized = await materializeCapabilityProfile({
      runId,
      worktreePath,
      executor: {
        agent: executor.agent,
        model: executor.model,
        executorRefId: executor.executorRefId,
        router: executor.router ?? null,
      },
      workMode: policy.workMode,
      reasoningEffort: policy.reasoningEffort,
      profile,
    });

    // FR-C2/C3: materialize the broad bundle skills (+ subagents for claude)
    // into the per-adapter target and capture the runner home redirect env.
    const installedImports: Array<{ installedPath: string }> = await db
      .select({ installedPath: capabilityImports.installedPath })
      .from(capabilityImports)
      .where(
        and(
          eq(capabilityImports.projectId, project.id),
          eq(capabilityImports.packageStatus, "Installed"),
        ),
      );
    const adapterHome = await materializeAdapterCapabilityHome({
      agent: executor.agent,
      worktreePath,
      runId,
      installedPaths: installedImports.map((imp) => imp.installedPath),
    });

    adapterHomeEnv = adapterHome.env;
    uploadedAttachments = await storeUploadedFiles({
      runId,
      messageId,
      projectSlug: project.slug,
      scope: "launch",
      files: uploadedFiles,
    });
    await db.transaction(async (tx: Db) => {
      await assertScratchCapacityAvailableInTransaction(tx);

      await tx.insert(runs).values({
        id: runId,
        runKind: "scratch",
        taskId: null,
        projectId: project.id,
        flowId: null,
        runnerId: runnerResolution.runnerId,
        runnerResolutionTier: runnerResolution.runnerResolutionTier,
        capabilityAgent: runnerResolution.capabilityAgent,
        runnerSnapshot: runnerResolution.runnerSnapshot,
        status: "Running",
        currentStepId: scratchStepId(),
        flowVersion: "scratch",
        flowRevision: "manual",
        flowRevisionId: null,
        createdByUserId: args.userId,
        startedAt: now,
      });
      await tx.insert(workspaces).values({
        id: randomUUID(),
        runId,
        projectId: project.id,
        branch,
        worktreePath,
        parentRepoPath: project.repoPath,
      });
      await tx.insert(scratchRuns).values({
        runId,
        projectId: project.id,
        name,
        initialPrompt: args.body.prompt,
        workMode: policy.workMode,
        reasoningEffort: policy.reasoningEffort,
        planMode: policy.planMode,
        linkedTaskId: args.body.linkedTaskId ?? null,
        linkedIssueUrl: args.body.linkedIssueUrl ?? null,
        baseBranch: args.body.baseBranch,
        baseCommit,
        targetBranch: args.body.baseBranch,
        dialogStatus: "Starting",
        createdByUserId: args.userId,
        lastUserMessageAt: hasInitialPrompt ? now : null,
        updatedAt: now,
      });
      if (initialMessage && messageId) {
        await tx.insert(scratchMessages).values({
          id: messageId,
          runId,
          sequence: initialMessage.sequence,
          role: initialMessage.role,
          content: initialMessage.content,
          supervisorEventId: initialMessage.supervisorEventId ?? null,
          createdAt: now,
        });
      }
      const metadataAttachments = validatedAttachments.map(
        metadataAttachmentRow,
      );
      const storedAttachments = storedAttachmentValues({
        metadataAttachments,
        uploadedAttachments,
        runId,
        messageId,
      });

      if (storedAttachments.length > 0) {
        await tx.insert(scratchAttachments).values(storedAttachments);
      }
      await tx.insert(scratchCapabilityProfiles).values({
        id: randomUUID(),
        runId,
        profileDigest: profile.profileDigest,
        materializedPath: materialized.rootPath,
        selectedMcpIds: profile.selectedMcpIds,
        selectedSkillIds: profile.selectedSkillIds,
        selectedRuleIds: profile.selectedRuleIds,
        restrictions: {
          selectedRestrictionIds: profile.selectedRestrictionIds,
          selectedAgentDefinitionIds: profile.selectedAgentDefinitionIds,
        },
        adapterLaunch: materialized.adapterLaunch,
        downgradeNotes: downgradeNotes(profile),
      });
    });
  } catch (err) {
    log.warn(
      { runId, err: err instanceof Error ? err.message : String(err) },
      "scratch launch artifact/DB step failed after addWorktree; removing worktree",
    );
    if (worktreeCreated) {
      await removeWorktree({
        projectRepoPath: project.repoPath,
        worktreePath,
        force: true,
      }).catch((rmErr) =>
        log.error(
          {
            worktreePath,
            rmErr: rmErr instanceof Error ? rmErr.message : String(rmErr),
          },
          "scratch compensating removeWorktree failed",
        ),
      );
      await removeBranch({
        projectRepoPath: project.repoPath,
        branch,
      }).catch((branchErr) =>
        log.error(
          {
            branch,
            branchErr:
              branchErr instanceof Error
                ? branchErr.message
                : String(branchErr),
          },
          "scratch compensating removeBranch failed",
        ),
      );
    }
    if (uploadedAttachments.length > 0) {
      const uploadDir = path.dirname(uploadedAttachments[0].storagePath ?? "");

      await rm(uploadDir, { recursive: true, force: true }).catch((rmErr) =>
        log.warn(
          {
            runId,
            uploadDir,
            rmErr: rmErr instanceof Error ? rmErr.message : String(rmErr),
          },
          "scratch compensating upload cleanup failed",
        ),
      );
    }
    throw err;
  }

  try {
    // Cancel here (post-commit) marks the run Crashed via this catch — the
    // worktree + run row are tracked rows, not an orphan.
    opts.signal?.throwIfAborted();
    yield launchProgress("spawning");
    const session = await createSession({
      runId,
      projectSlug: project.slug,
      worktreePath,
      // Scratch is the one path that sends file content-blocks; pass the repo
      // root so the supervisor's URI confinement allows repo-absolute file_path
      // attachments (web-confined to repo ∪ worktree).
      repoPath: project.repoPath,
      stepId: scratchStepId(),
      executor: runnerExecutorInput(runnerResolution.runnerSnapshot),
      runner: runnerSupervisorInput({
        snapshot: runnerResolution.runnerSnapshot,
      }),
      capabilityProfilePath: materialized.profilePath,
      adapterLaunch: mergeRunnerAdapterLaunch(runnerResolution.runnerSnapshot, {
        ...materialized.adapterLaunch,
        env: {
          ...(materialized.adapterLaunch.env ?? {}),
          ...adapterHomeEnv,
        },
      }),
      mcpServers: materialized.mcpServers,
    });

    await db.transaction(async (tx: Db) => {
      const dialogStatus: ScratchDialogStatus = hasInitialPrompt
        ? "Running"
        : "WaitingForUser";

      await tx
        .update(runs)
        .set({ acpSessionId: session.acpSessionId })
        .where(eq(runs.id, runId));
      await tx
        .update(scratchRuns)
        .set({
          supervisorSessionId: session.sessionId,
          dialogStatus,
          updatedAt: new Date(),
        })
        .where(eq(scratchRuns.runId, runId));
    });
    yield launchProgress("session_ready");

    if (!hasInitialPrompt) {
      log.info(
        {
          runId,
          projectId: project.id,
          runnerId: runnerResolution.runnerId,
          runnerResolutionTier: runnerResolution.runnerResolutionTier,
          createdByUserId: args.userId,
          workMode: policy.workMode,
          reasoningEffort: policy.reasoningEffort,
          dialogStatus: "WaitingForUser",
          uploadCount: uploadedFiles.length,
          uploadBytes: uploadedFiles.reduce(
            (sum, file) => sum + file.byteSize,
            0,
          ),
        },
        "scratch workspace prepared without initial prompt",
      );

      return launchResponse({
        runId,
        projectId: project.id,
        name,
        runStatus: runStatusForDialogStatus("WaitingForUser"),
        dialogStatus: "WaitingForUser",
        branchName: branch,
        baseBranch: args.body.baseBranch,
        baseCommit,
        targetBranch: args.body.baseBranch,
        workMode: policy.workMode,
        reasoningEffort: policy.reasoningEffort,
        planMode: policy.planMode,
      });
    }

    const launchPrompt = normalizeScratchPrompt(prompt, executor.agent, {
      runId,
    });
    const promptResult = await sendScratchPromptAndProjectEvents({
      runId,
      sessionId: session.sessionId,
      stepId: scratchStepId(),
      prompt: launchPrompt,
      contentBlocks: scratchPromptContentBlocks(launchPrompt, [
        ...validatedAttachments.map(metadataAttachmentRow),
        ...uploadedAttachments,
      ]),
    });
    const dialogStatus = await completeScratchPromptTurn({ db, runId });

    log.info(
      {
        runId,
        projectId: project.id,
        runnerId: runnerResolution.runnerId,
        runnerResolutionTier: runnerResolution.runnerResolutionTier,
        createdByUserId: args.userId,
        workMode: policy.workMode,
        reasoningEffort: policy.reasoningEffort,
        dialogStatus,
        stopReason: promptResult.stopReason,
        uploadCount: uploadedFiles.length,
        uploadBytes: uploadedFiles.reduce(
          (sum, file) => sum + file.byteSize,
          0,
        ),
      },
      "scratch run launched",
    );

    return launchResponse({
      runId,
      projectId: project.id,
      name,
      runStatus: runStatusForDialogStatus(dialogStatus),
      dialogStatus,
      branchName: branch,
      baseBranch: args.body.baseBranch,
      baseCommit,
      targetBranch: args.body.baseBranch,
      workMode: policy.workMode,
      reasoningEffort: policy.reasoningEffort,
      planMode: policy.planMode,
    });
  } catch (err) {
    await markScratchCrashed({ db, runId, err }).catch((markErr) =>
      log.error(
        {
          runId,
          markErr: markErr instanceof Error ? markErr.message : String(markErr),
        },
        "failed to mark scratch run crashed",
      ),
    );
    throw err;
  }
}

// Back-compat drain: non-route callers get a Promise<ScratchRunResponse>;
// `onProgress` observes stages without driving the generator directly.
export async function launchScratchRun(
  args: {
    body: ScratchLaunchInput;
    uploadedFiles?: readonly ScratchUploadedFileInput[];
    userId: string;
  },
  opts: {
    onProgress?: (ev: LaunchProgressEvent) => void;
    signal?: AbortSignal;
  } = {},
): Promise<ScratchRunResponse> {
  const gen = launchScratchRunStaged(args, { signal: opts.signal });
  let step = await gen.next();

  while (!step.done) {
    opts.onProgress?.(step.value);
    step = await gen.next();
  }

  return step.value;
}

// --- M36 Phase 5 (ADR-096): docked AI authoring assistant ------------------
// A scratch-run ACP session rooted at a NON-project local-package working dir.
// There is NO project, NO managed git worktree, NO `git worktree add`, NO
// workspace row. The session's cwd + sole confinement root is the local
// package's `working_dir` (already git-backed). The run is project-less:
// runs.project_id / scratch_runs.project_id stay NULL and scratch_runs.
// local_package_id carries the owner (DB XOR CHECK). runs.local_package_id is
// the launch-time snapshot every terminal/read path reads.

export type LocalPackageAssistantLaunchInput = {
  localPackageId: string;
  prompt: string;
  runnerId?: string;
  workMode?: ScratchWorkMode;
  reasoningEffort?: ScratchReasoningEffort;
  planMode?: ScratchPlanMode;
};

// Resolve the runner for a project-less assistant launch. There is no project
// (so no project default tier); the chain is launch-override → platform default.
async function resolveLocalPackageAssistantRunner(
  db: Db,
  body: LocalPackageAssistantLaunchInput,
): Promise<ScratchResolvedRunner> {
  const runtimeRows = await db
    .select()
    .from(platformRuntimeSettings)
    .where(eq(platformRuntimeSettings.id, "singleton"));
  const platformRuntime = runtimeRows[0];

  if (!platformRuntime) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "platform default ACP runner is not configured",
    );
  }

  const runnerRows = await db.select().from(platformAcpRunners);
  const sidecarRows = await db.select().from(platformRouterSidecars);
  const sidecarById = new Map<string, Record<string, any>>(
    sidecarRows.map((row: Record<string, any>) => [row.id, row]),
  );
  const resolution = resolveRunner({
    launchOverrideRunnerId: body.runnerId,
    step: { runnerId: null },
    projectFlow: { defaultRunnerId: null },
    platformFlow: { defaultRunnerId: null },
    project: { defaultRunnerId: null },
    platform: { defaultRunnerId: platformRuntime.defaultRunnerId },
    runners: runnerRows.map((row: Record<string, any>) =>
      runnerCatalogEntry(row, sidecarById),
    ),
  });

  return {
    resolution,
    executor: {
      id: resolution.runnerId,
      agent: resolution.capabilityAgent as CapabilityAgent,
      model: resolution.runnerSnapshot.model,
      executorRefId: resolution.runnerId,
      env: null,
      router: resolution.runnerSnapshot.sidecarId ? "ccr" : null,
    },
  };
}

async function loadActiveLocalPackage(db: Db, localPackageId: string) {
  const rows = await db
    .select()
    .from(localPackages)
    .where(eq(localPackages.id, localPackageId));
  const pkg = rows[0];

  if (!pkg || pkg.status !== "active") {
    throw new MaisterError(
      "PRECONDITION",
      `local package not found or not active: ${localPackageId}`,
    );
  }

  return pkg;
}

// Launch a docked AI authoring assistant session against a local-package
// working dir. Project-less; runs IN the existing git-backed working dir (no
// worktree add, no workspace row); base branch/commit are read from it.
export async function launchLocalPackageAssistant(args: {
  body: LocalPackageAssistantLaunchInput;
  userId: string;
}): Promise<ScratchRunResponse> {
  const db = getDb() as Db;

  // Member-level RBAC (ADR-095): authoring a local package is any active user.
  await requireActiveSession();

  const pkg = await loadActiveLocalPackage(db, args.body.localPackageId);
  const { executor, resolution: runnerResolution } =
    await resolveLocalPackageAssistantRunner(db, args.body);

  const policy = scratchPolicy(args.body);
  // The assistant carries no project capability catalog — an empty selectable
  // set. The flow-authoring skill is seeded by the Studio surface (separate
  // task); the backend foundation materializes a bare per-adapter profile.
  const profile = resolveCapabilityProfile({
    projectId: pkg.id,
    executorAgent: executor.agent,
    planMode: policy.planMode,
    workMode: policy.workMode,
    reasoningEffort: policy.reasoningEffort,
    catalog: [],
  });

  const platformStatus = await checkSupervisorHealth();

  if (platformStatus.kind === "unavailable") {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `supervisor unavailable (${platformStatus.reason}): ${platformStatus.message}`,
    );
  }

  await assertScratchCapacityAvailable({ db });

  const workingDir = pkg.workingDir as string;
  // Base branch/commit are read from the EXISTING working dir — no new branch.
  const baseBranch =
    (await currentBranchName(workingDir)) ?? pkg.branchName ?? "main";
  const baseCommit = await headCommit({ worktreePath: workingDir });

  const runId = randomUUID();
  const rawPrompt = args.body.prompt.trim();
  const hasInitialPrompt = rawPrompt.length > 0;
  const prompt = hasInitialPrompt
    ? decoratePromptForPlanMode({
        planMode: policy.planMode,
        workMode: policy.workMode,
        reasoningEffort: policy.reasoningEffort,
        prompt: rawPrompt,
      })
    : "";
  const now = new Date();
  const name = pkg.name ? `${pkg.name} assistant` : scratchNameFallback(prompt);
  const messageId = hasInitialPrompt ? randomUUID() : null;
  const initialMessage = hasInitialPrompt
    ? userScratchMessageDraft({ sequence: 1, content: rawPrompt })
    : null;

  const materialized = await materializeCapabilityProfile({
    runId,
    worktreePath: workingDir,
    executor: {
      agent: executor.agent,
      model: executor.model,
      executorRefId: executor.executorRefId,
      router: executor.router ?? null,
    },
    workMode: policy.workMode,
    reasoningEffort: policy.reasoningEffort,
    profile,
  });

  // T5.3: seed the flow-authoring skill into the session's per-adapter target
  // (the assistant has no project catalog, so this is its only skill). The
  // returned env (codex CODEX_HOME redirect; empty for claude) is merged into
  // the session adapterLaunch below.
  const authoringSkill = await materializeFlowAuthoringSkill({
    agent: executor.agent,
    worktreePath: workingDir,
    runId,
  });

  // Single launch insert: project-less runs + scratch_runs rows, snapshotting
  // local_package_id. NO workspace row (no managed worktree). The XOR CHECK on
  // scratch_runs enforces local_package_id-set / project_id-null.
  await db.transaction(async (tx: Db) => {
    await assertScratchCapacityAvailableInTransaction(tx);

    await tx.insert(runs).values({
      id: runId,
      runKind: "scratch",
      taskId: null,
      projectId: null,
      localPackageId: pkg.id,
      flowId: null,
      runnerId: runnerResolution.runnerId,
      runnerResolutionTier: runnerResolution.runnerResolutionTier,
      capabilityAgent: runnerResolution.capabilityAgent,
      runnerSnapshot: runnerResolution.runnerSnapshot,
      status: "Running",
      currentStepId: scratchStepId(),
      flowVersion: "scratch",
      flowRevision: "manual",
      flowRevisionId: null,
      createdByUserId: args.userId,
      startedAt: now,
    });
    await tx.insert(scratchRuns).values({
      runId,
      projectId: null,
      localPackageId: pkg.id,
      name,
      initialPrompt: args.body.prompt,
      workMode: policy.workMode,
      reasoningEffort: policy.reasoningEffort,
      planMode: policy.planMode,
      linkedTaskId: null,
      linkedIssueUrl: null,
      baseBranch,
      baseCommit,
      targetBranch: baseBranch,
      dialogStatus: "Starting",
      createdByUserId: args.userId,
      lastUserMessageAt: hasInitialPrompt ? now : null,
      updatedAt: now,
    });
    if (initialMessage && messageId) {
      await tx.insert(scratchMessages).values({
        id: messageId,
        runId,
        sequence: initialMessage.sequence,
        role: initialMessage.role,
        content: initialMessage.content,
        supervisorEventId: initialMessage.supervisorEventId ?? null,
        createdAt: now,
      });
    }
    await tx.insert(scratchCapabilityProfiles).values({
      id: randomUUID(),
      runId,
      profileDigest: profile.profileDigest,
      materializedPath: materialized.rootPath,
      selectedMcpIds: profile.selectedMcpIds,
      selectedSkillIds: profile.selectedSkillIds,
      selectedRuleIds: profile.selectedRuleIds,
      restrictions: {
        selectedRestrictionIds: profile.selectedRestrictionIds,
        selectedAgentDefinitionIds: profile.selectedAgentDefinitionIds,
      },
      adapterLaunch: materialized.adapterLaunch,
      downgradeNotes: downgradeNotes(profile),
    });
  });

  // Tracked so a turn failure AFTER the session exists tears it down — the
  // supervisor's session-delete purges any open permission deferred (HARD RULE:
  // every failure path that created a deferred releases it).
  let createdSessionId: string | null = null;

  try {
    const session = await createSession({
      runId,
      // No project — the local-package slug names the runtime/cost subtree
      // (.maister/<slug>/runs/<runId>); it is kebab-case + unique by construction.
      projectSlug: pkg.slug,
      worktreePath: workingDir,
      // ADR-096: the SOLE confinement root is the working dir (no repo/worktree
      // widening). A `file:` URI outside it is rejected supervisor-side.
      confineRoot: workingDir,
      stepId: scratchStepId(),
      executor: runnerExecutorInput(runnerResolution.runnerSnapshot),
      runner: runnerSupervisorInput({
        snapshot: runnerResolution.runnerSnapshot,
      }),
      capabilityProfilePath: materialized.profilePath,
      adapterLaunch: mergeRunnerAdapterLaunch(runnerResolution.runnerSnapshot, {
        ...materialized.adapterLaunch,
        env: {
          ...(materialized.adapterLaunch.env ?? {}),
          ...authoringSkill.env,
        },
      }),
      mcpServers: materialized.mcpServers,
    });

    createdSessionId = session.sessionId;

    await db.transaction(async (tx: Db) => {
      const dialogStatus: ScratchDialogStatus = hasInitialPrompt
        ? "Running"
        : "WaitingForUser";

      await tx
        .update(runs)
        .set({ acpSessionId: session.acpSessionId })
        .where(eq(runs.id, runId));
      await tx
        .update(scratchRuns)
        .set({
          supervisorSessionId: session.sessionId,
          dialogStatus,
          updatedAt: new Date(),
        })
        .where(eq(scratchRuns.runId, runId));
    });

    if (!hasInitialPrompt) {
      return localPackageAssistantResponse({
        runId,
        name,
        runStatus: runStatusForDialogStatus("WaitingForUser"),
        dialogStatus: "WaitingForUser",
        baseBranch,
        baseCommit,
        policy,
      });
    }

    const launchPrompt = normalizeScratchPrompt(prompt, executor.agent, {
      runId,
    });
    const promptResult = await sendScratchPromptAndProjectEvents({
      runId,
      sessionId: session.sessionId,
      stepId: scratchStepId(),
      prompt: launchPrompt,
    });
    const dialogStatus = await completeScratchPromptTurn({ db, runId });

    log.info(
      {
        runId,
        localPackageId: pkg.id,
        runnerId: runnerResolution.runnerId,
        createdByUserId: args.userId,
        dialogStatus,
        stopReason: promptResult.stopReason,
      },
      "local-package assistant run launched",
    );

    return localPackageAssistantResponse({
      runId,
      name,
      runStatus: runStatusForDialogStatus(dialogStatus),
      dialogStatus,
      baseBranch,
      baseCommit,
      policy,
    });
  } catch (err) {
    // Release any open permission deferred the turn created: deleting the
    // supervisor session purges all pending deferreds for it (purgeSession).
    if (createdSessionId) {
      await deleteScratchSupervisorSessionIfLive(createdSessionId, runId).catch(
        (delErr) =>
          log.error(
            {
              runId,
              delErr: delErr instanceof Error ? delErr.message : String(delErr),
            },
            "failed to release supervisor session on assistant launch failure",
          ),
      );
    }
    await markScratchCrashed({
      db,
      runId,
      err,
      clearSupervisorSession: true,
    }).catch((markErr) =>
      log.error(
        {
          runId,
          markErr: markErr instanceof Error ? markErr.message : String(markErr),
        },
        "failed to mark local-package assistant run crashed",
      ),
    );
    throw err;
  }
}

function localPackageAssistantResponse(args: {
  runId: string;
  name: string | null;
  runStatus: RunStatus;
  dialogStatus: ScratchDialogStatus;
  baseBranch: string;
  baseCommit: string;
  policy: ReturnType<typeof scratchPolicy>;
}): ScratchRunResponse {
  return {
    runId: args.runId,
    dialogUrl: `/scratch-runs/${args.runId}`,
    status: {
      runId: args.runId,
      // Project-less: the DTO projectId field is empty for a local-package run.
      projectId: "",
      name: args.name,
      runStatus: args.runStatus,
      dialogStatus: args.dialogStatus,
      branchName: args.baseBranch,
      baseBranch: args.baseBranch,
      baseCommit: args.baseCommit,
      targetBranch: args.baseBranch,
      workMode: args.policy.workMode,
      reasoningEffort: args.policy.reasoningEffort,
      planMode: args.policy.planMode,
    },
  };
}

// ADR-096: the turn path needs the run's working dir (for attachment URI
// confinement) and parent repo. A project scratch run reads them from its
// `workspaces` row; a project-less local-package assistant run has NO workspace
// row — its working dir is the local package's git-backed `working_dir`, which
// is both the cwd and (being its own repo root) the parent repo. This returns a
// workspace-SHAPED value either way so callers stay uniform.
type ScratchWorkspaceLike = {
  worktreePath: string;
  parentRepoPath: string;
  removedAt: Date | null;
};

async function loadScratchRows(db: Db, runId: string) {
  const runRows = await db.select().from(runs).where(eq(runs.id, runId));
  const run = runRows[0];

  if (!run) {
    throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
  }
  if (run.runKind !== "scratch") {
    throw new MaisterError("PRECONDITION", `run is not scratch: ${runId}`);
  }

  const [scratchRows, workspaceRows] = await Promise.all([
    db.select().from(scratchRuns).where(eq(scratchRuns.runId, runId)),
    db.select().from(workspaces).where(eq(workspaces.runId, runId)),
  ]);
  const scratch = scratchRows[0];

  if (!scratch) {
    throw new MaisterError(
      "PRECONDITION",
      `scratch metadata not found: ${runId}`,
    );
  }

  let workspace: ScratchWorkspaceLike | undefined = workspaceRows[0];

  if (!workspace) {
    if (run.localPackageId) {
      const pkgRows = await db
        .select()
        .from(localPackages)
        .where(eq(localPackages.id, run.localPackageId));
      const pkg = pkgRows[0];

      if (!pkg) {
        throw new MaisterError(
          "PRECONDITION",
          `local package not found for assistant run: ${runId}`,
        );
      }

      workspace = {
        worktreePath: pkg.workingDir,
        parentRepoPath: pkg.workingDir,
        removedAt: null,
      };
    } else {
      throw new MaisterError("PRECONDITION", `workspace not found: ${runId}`);
    }
  }

  return { run, scratch, workspace };
}

async function appendScratchUserMessage(args: {
  db: Db;
  runId: string;
  body: ScratchMessageInput;
  uploadedFiles: readonly ScratchUploadedFileInput[];
}) {
  const runRows = await args.db
    .select()
    .from(runs)
    .where(eq(runs.id, args.runId));
  const run = runRows[0];

  if (!run) {
    throw new MaisterError("PRECONDITION", `run not found: ${args.runId}`);
  }
  if (run.runKind !== "scratch") {
    throw new MaisterError("PRECONDITION", `run is not scratch: ${args.runId}`);
  }

  // ADR-096: a project-less local-package assistant run carries member-level
  // RBAC (any active user, per ADR-095); a project scratch run keeps its
  // project-scoped action gate.
  if (run.projectId) {
    await requireProjectAction(run.projectId, "operateScratchRun");
  } else {
    await requireActiveSession();
  }

  return args.db.transaction(async (tx: Db) => {
    await lockRunRows(tx, args.runId);

    const {
      run: lockedRun,
      scratch,
      workspace,
    } = await loadScratchRows(tx, args.runId);

    assertScratchCanAcceptUserMessage({
      runId: args.runId,
      runStatus: lockedRun.status,
      dialogStatus: scratch.dialogStatus,
      supervisorSessionId: scratch.supervisorSessionId,
    });

    const sequenceRows: Array<{ sequence: number }> = await tx
      .select({ sequence: scratchMessages.sequence })
      .from(scratchMessages)
      .where(eq(scratchMessages.runId, args.runId));
    const sequence = nextScratchMessageSequence(
      sequenceRows.map((row) => row.sequence),
    );
    const message = userScratchMessageDraft({
      sequence,
      content: args.body.content,
    });
    const messageId = randomUUID();
    const now = new Date();
    const attachments = validateScratchAttachments(args.body.attachments, {
      projectRepoPath: workspace.parentRepoPath,
      worktreePath: workspace.worktreePath,
    });
    const uploadedAttachments =
      args.uploadedFiles.length > 0
        ? await (async () => {
            // ADR-096: a project-less local-package assistant run has no
            // project — the runtime/cost subtree is keyed by the local package
            // slug instead (mirrors the launch's createSession projectSlug).
            const slug = lockedRun.projectId
              ? (
                  await tx
                    .select()
                    .from(projects)
                    .where(eq(projects.id, lockedRun.projectId))
                )[0]?.slug
              : (
                  await tx
                    .select()
                    .from(localPackages)
                    .where(eq(localPackages.id, lockedRun.localPackageId))
                )[0]?.slug;

            if (!slug) {
              throw new MaisterError(
                "PRECONDITION",
                `owner slug not found for scratch run: ${args.runId}`,
              );
            }

            return storeUploadedFiles({
              runId: args.runId,
              messageId,
              projectSlug: slug,
              scope: messageId,
              files: args.uploadedFiles,
            });
          })()
        : [];

    await tx.insert(scratchMessages).values({
      id: messageId,
      runId: args.runId,
      sequence: message.sequence,
      role: message.role,
      content: message.content,
      supervisorEventId: message.supervisorEventId ?? null,
      createdAt: now,
    });
    const metadataAttachments = attachments.map(metadataAttachmentRow);
    const storedAttachments = storedAttachmentValues({
      metadataAttachments,
      uploadedAttachments,
      runId: args.runId,
      messageId,
    });

    if (storedAttachments.length > 0) {
      await tx.insert(scratchAttachments).values(storedAttachments);
    }
    await tx
      .update(scratchRuns)
      .set({
        dialogStatus: "Running",
        lastUserMessageAt: now,
        updatedAt: now,
        errorCode: null,
        errorMessage: null,
        errorMetadata: null,
      })
      .where(eq(scratchRuns.runId, args.runId));
    await tx
      .update(runs)
      .set({ status: "Running", currentStepId: scratchStepId() })
      .where(eq(runs.id, args.runId));

    return {
      messageId,
      sequence,
      supervisorSessionId: scratch.supervisorSessionId as string,
      capabilityAgent: run.capabilityAgent,
      // ADR-096: project-less ⇒ a local-package assistant run; its turn-failure
      // path explicitly releases the supervisor deferred (see caller).
      isLocalPackageAssistant: !run.projectId,
      uploadedAttachments,
      metadataAttachments,
    };
  });
}

export async function sendScratchUserMessage(args: {
  runId: string;
  body: ScratchMessageInput;
  uploadedFiles?: readonly ScratchUploadedFileInput[];
}): Promise<ScratchMessageResponse> {
  const db = getDb() as Db;
  const appended = await appendScratchUserMessage({
    db,
    runId: args.runId,
    body: args.body,
    uploadedFiles: args.uploadedFiles ?? [],
  });

  try {
    const messagePrompt = normalizeScratchPrompt(
      args.body.content,
      appended.capabilityAgent,
      { runId: args.runId },
    );
    const promptResult = await sendScratchPromptAndProjectEvents({
      runId: args.runId,
      sessionId: appended.supervisorSessionId,
      stepId: scratchStepId(),
      prompt: messagePrompt,
      contentBlocks: scratchPromptContentBlocks(messagePrompt, [
        ...appended.metadataAttachments,
        ...appended.uploadedAttachments,
      ]),
    });
    const dialogStatus = await completeScratchPromptTurn({
      db,
      runId: args.runId,
    });

    return messageResponse({
      messageId: appended.messageId,
      sequence: appended.sequence,
      dialogStatus,
      stopReason: promptResult.stopReason,
    });
  } catch (err) {
    if (isMaisterError(err) && err.code === "EXECUTOR_UNAVAILABLE") {
      await markScratchPromptRetryable({ db, runId: args.runId, err }).catch(
        (markErr) =>
          log.error(
            {
              runId: args.runId,
              markErr:
                markErr instanceof Error ? markErr.message : String(markErr),
            },
            "failed to mark scratch message prompt retryable",
          ),
      );
      throw err;
    }

    // ADR-096: a local-package assistant turn failure explicitly releases any
    // open permission deferred by tearing down the supervisor session
    // (purgeSession cancels all pending deferreds), THEN marks crashed —
    // idempotent on an already-gone session. Project scratch runs keep their
    // prior behavior (supervisor purge on the natural session exit).
    if (appended.isLocalPackageAssistant) {
      await deleteScratchSupervisorSessionIfLive(
        appended.supervisorSessionId,
        args.runId,
      ).catch((delErr) =>
        log.error(
          {
            runId: args.runId,
            delErr: delErr instanceof Error ? delErr.message : String(delErr),
          },
          "failed to release supervisor session on assistant turn failure",
        ),
      );
    }
    await markScratchCrashed({
      db,
      runId: args.runId,
      err,
      clearSupervisorSession: appended.isLocalPackageAssistant,
    }).catch((markErr) =>
      log.error(
        {
          runId: args.runId,
          markErr: markErr instanceof Error ? markErr.message : String(markErr),
        },
        "failed to mark scratch message prompt failure",
      ),
    );
    throw err;
  }
}

export type StopScratchWorkbenchResult = {
  runId: string;
  dialogStatus: ScratchDialogStatus;
  runStatus: RunStatus;
  supervisorStopped: boolean;
  workspaceActive: boolean;
};

async function deleteScratchSupervisorSessionIfLive(
  sessionId: string,
  runId: string,
): Promise<boolean> {
  try {
    await deleteSession(sessionId);

    return true;
  } catch (err) {
    if (
      isMaisterError(err) &&
      (err.code === "PRECONDITION" || err.code === "ACP_PROTOCOL") &&
      /unknown session|not found|404/i.test(err.message)
    ) {
      log.info(
        { runId, sessionId },
        "scratch stop treated missing supervisor session as already stopped",
      );

      return false;
    }

    throw err;
  }
}

// Stop a live scratch run: kill its supervisor session and land the run in
// Review (when it still has a worktree) or Abandoned. The caller authorizes;
// this primitive is shared by the scratch stop route and the combined
// workbench stop+archive op. Terminal runs are an idempotent no-op.
export async function stopScratchWorkbench(
  runId: string,
  opts: { db?: Db } = {},
): Promise<StopScratchWorkbenchResult> {
  const db = opts.db ?? getDb();

  const runRows = await db.select().from(runs).where(eq(runs.id, runId));
  const run = runRows[0];

  if (!run) {
    throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
  }
  if (run.runKind !== "scratch") {
    throw new MaisterError("PRECONDITION", `run is not scratch: ${runId}`);
  }

  const [scratchRows, workspaceRows] = await Promise.all([
    db.select().from(scratchRuns).where(eq(scratchRuns.runId, runId)),
    db.select().from(workspaces).where(eq(workspaces.runId, runId)),
  ]);
  const scratch = scratchRows[0];

  if (!scratch) {
    throw new MaisterError(
      "PRECONDITION",
      `scratch metadata not found: ${runId}`,
    );
  }
  const workspace = workspaceRows[0] ?? null;

  if (isTerminalScratchDialogStatus(scratch.dialogStatus)) {
    log.info(
      { runId, dialogStatus: scratch.dialogStatus },
      "scratch stop skipped terminal run",
    );

    return {
      runId,
      dialogStatus: scratch.dialogStatus,
      runStatus: run.status,
      supervisorStopped: false,
      workspaceActive: Boolean(workspace && !workspace.removedAt),
    };
  }

  const workspaceActive = Boolean(workspace && !workspace.removedAt);
  const nextDialogStatus = dialogStatusAfterSupervisorStop({
    hasWorkspace: workspaceActive,
  });
  const nextRunStatus = runStatusForDialogStatus(nextDialogStatus);
  const now = new Date();
  let supervisorStopped = false;

  if (scratch.supervisorSessionId) {
    supervisorStopped = await deleteScratchSupervisorSessionIfLive(
      scratch.supervisorSessionId,
      runId,
    );
  }

  await db.transaction(async (tx: Db) => {
    await tx
      .update(scratchRuns)
      .set({
        dialogStatus: nextDialogStatus,
        supervisorSessionId: null,
        updatedAt: now,
      })
      .where(eq(scratchRuns.runId, runId));
    await tx
      .update(runs)
      .set({
        status: nextRunStatus,
        acpSessionId: null,
        currentStepId: null,
        endedAt: now,
      })
      .where(eq(runs.id, runId));
  });

  return {
    runId,
    dialogStatus: nextDialogStatus,
    runStatus: nextRunStatus,
    supervisorStopped,
    workspaceActive,
  };
}
