import "server-only";

import type {
  RunStatus,
  ScratchDialogStatus,
  ScratchPlanMode,
  ScratchReasoningEffort,
  ScratchWorkMode,
} from "@/lib/db/schema";
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

import { requireProjectAction } from "@/lib/authz";
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
  uploadedFileMetadata,
  validateScratchAttachments,
} from "@/lib/scratch-runs/attachments";
import { sendScratchPromptAndProjectEvents } from "@/lib/scratch-runs/events";
import {
  decoratePromptForPlanMode,
  deriveScratchBranchName,
  planModeToWorkMode,
  scratchNameFallback,
  scratchStepId,
  workModeToPlanMode,
} from "@/lib/scratch-runs/launch";
import {
  nextScratchMessageSequence,
  userScratchMessageDraft,
} from "@/lib/scratch-runs/messages";
import {
  assertScratchCanAcceptUserMessage,
  dialogStatusAfterPromptCompletion,
  runStatusForDialogStatus,
} from "@/lib/scratch-runs/state";
import { checkSupervisorHealth, createSession } from "@/lib/supervisor-client";
import {
  addWorktree,
  branchExists,
  removeBranch,
  removeWorktree,
  resolveBaseCommit,
} from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const {
  executors,
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

async function loadExecutor(db: Db, body: ScratchLaunchInput, project: any) {
  const rows = await db
    .select()
    .from(executors)
    .where(
      and(
        eq(executors.id, body.executorId),
        eq(executors.projectId, project.id),
      ),
    );
  const executor = rows[0];

  if (!executor) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `executor ${body.executorId} not registered for project ${project.slug}`,
    );
  }

  return executor;
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

function scratchPolicy(body: ScratchLaunchInput): {
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

function attachmentPromptLines(
  attachments: readonly ReturnType<typeof uploadedFileMetadata>[],
): string[] {
  if (attachments.length === 0) return [];

  return [
    "",
    "Uploaded files for this message:",
    ...attachments.map(
      (attachment) =>
        `- ${attachment.fileName} (${attachment.mimeType}, ${attachment.byteSize} bytes, sha256 ${attachment.sha256}): ${attachment.value}; local path ${attachment.storagePath}`,
    ),
  ];
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
      .returning({ id: runs.id });

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
    "[FIX] scratch prompt failed after message persistence; dialog left retryable",
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
        "[FIX] scratch prompt completion preserved event-derived status",
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
      "[FIX] scratch prompt completion transitioned idle",
    );

    return nextStatus;
  });
}

export async function launchScratchRun(args: {
  body: ScratchLaunchInput;
  uploadedFiles?: readonly ScratchUploadedFileInput[];
  userId: string;
}): Promise<ScratchRunResponse> {
  const db = getDb() as Db;
  const project = await loadProject(db, args.body.projectId);

  await requireProjectAction(project.id, "launchRun");

  const executor = await loadExecutor(db, args.body, project);

  await validateLinkedTask(db, args.body.linkedTaskId, project.id);

  const catalog = await loadSelectableCapabilities(project.id, db);
  const policy = scratchPolicy(args.body);
  const profile = resolveCapabilityProfile({
    projectId: project.id,
    executorAgent: executor.agent,
    selectedMcpIds: args.body.capabilities?.mcpIds,
    selectedSkillIds: args.body.capabilities?.skillIds,
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

  await addWorktree({
    projectRepoPath: project.repoPath,
    branch,
    worktreePath,
    startPoint: args.body.baseBranch,
  });
  worktreeCreated = true;

  let materialized: Awaited<ReturnType<typeof materializeCapabilityProfile>>;

  try {
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
        executorId: executor.id,
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
      "[FIX] scratch launch artifact/DB step failed after addWorktree; removing worktree",
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
          "[FIX] scratch compensating removeBranch failed",
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
    const session = await createSession({
      runId,
      projectSlug: project.slug,
      worktreePath,
      stepId: scratchStepId(),
      executor: {
        agent: executor.agent,
        model: executor.model,
        env: executor.env ?? undefined,
        router: executor.router ?? undefined,
      },
      capabilityProfilePath: materialized.profilePath,
      adapterLaunch: materialized.adapterLaunch,
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

    if (!hasInitialPrompt) {
      log.info(
        {
          runId,
          projectId: project.id,
          executorId: executor.id,
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

    const promptResult = await sendScratchPromptAndProjectEvents({
      runId,
      sessionId: session.sessionId,
      stepId: scratchStepId(),
      prompt: [prompt, ...attachmentPromptLines(uploadedAttachments)].join(
        "\n",
      ),
    });
    const dialogStatus = await completeScratchPromptTurn({ db, runId });

    log.info(
      {
        runId,
        projectId: project.id,
        executorId: executor.id,
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
  const workspace = workspaceRows[0];

  if (!scratch) {
    throw new MaisterError(
      "PRECONDITION",
      `scratch metadata not found: ${runId}`,
    );
  }
  if (!workspace) {
    throw new MaisterError("PRECONDITION", `workspace not found: ${runId}`);
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

  await requireProjectAction(run.projectId, "operateScratchRun");

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
            const projectRows = await tx
              .select()
              .from(projects)
              .where(eq(projects.id, lockedRun.projectId));
            const project = projectRows[0];

            if (!project) {
              throw new MaisterError(
                "PRECONDITION",
                `project not found for scratch run: ${args.runId}`,
              );
            }

            return storeUploadedFiles({
              runId: args.runId,
              messageId,
              projectSlug: project.slug,
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
      uploadedAttachments,
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
    const promptResult = await sendScratchPromptAndProjectEvents({
      runId: args.runId,
      sessionId: appended.supervisorSessionId,
      stepId: scratchStepId(),
      prompt: [
        args.body.content,
        ...attachmentPromptLines(appended.uploadedAttachments),
      ].join("\n"),
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

    await markScratchCrashed({ db, runId: args.runId, err }).catch((markErr) =>
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
