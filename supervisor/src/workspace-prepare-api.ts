import type { FastifyInstance, FastifyReply } from "fastify";
import type { Logger } from "pino";
import type { HostState, CommandReceiptRow } from "./host-state";
import type { CommandFence } from "./types";
import type { WorkspaceRegistry } from "./workspace-registry";
import type {
  MaterializedWorkspaceInputs,
  PreparedWorkspace,
  WorkspaceCommandBinding,
  WorkspaceCommandRequest,
  WorkspacePrepareRequest,
  WorkspaceWorkloadResult,
  WorkspaceCancelWorkloadResult,
  WorkspaceGitCheckpointResult,
  WorkspaceOperationOwner,
  WorkspaceRetainedBinding,
  WorkspaceRetainedRequest,
  WorkspacePublishResult,
  WorkspaceSyncResult,
  WorkspaceTerminalPayload,
  WorkspacePreserveResult,
  WorkspaceReleaseResult,
} from "../../runtime/workspace-prepare";
import type { RuntimeObjectRegistry } from "./runtime-objects";
import type { RuntimeEventPublisher } from "./runtime-event-publisher";

import { isAbsolute } from "node:path";

import { z } from "zod";

import { EXECUTION_HOST_KEY_PATTERN } from "../../runtime/execution-host-address";
import { GIT_OBJECT_ID } from "../../runtime/wait-head";
import {
  isWorkspaceGenerationTarget,
  isWorkspaceCancelTarget,
  isWorkspaceOperationOwner,
  isWorkspaceRetainedOperation,
  isWorkspaceSourceRef,
  WORKSPACE_CANCEL_OPERATION,
  WORKSPACE_CHECKPOINT_OPERATION,
  WORKSPACE_LOG_MAX_PAGE_SIZE,
  WORKSPACE_MATERIALIZE_OPERATION,
  WORKSPACE_PREPARE_OPERATION,
  WORKSPACE_PREPARE_TARGET,
  WORKSPACE_RUN_OPERATION,
  WORKSPACE_RESTORE_OPERATION,
  WORKSPACE_PUBLISH_OPERATION,
  WORKSPACE_SYNC_OPERATION,
  WORKSPACE_PRESERVE_OPERATION,
  WORKSPACE_RELEASE_OPERATION,
  WORKSPACE_WORKLOAD_KINDS,
  workspaceEvidenceDigest,
  workspaceCommandRequestDigest,
} from "../../runtime/workspace-prepare";

import { REPLAYED_HEADER } from "./command-receipts";
import { applyFence } from "./execution-fence";
import { prepareOwnedWorkspace } from "./prepare-owned-workspace";
import { isSupervisorError, SupervisorError } from "./types";
import { materializeWorkspaceInputs } from "./workspace-input-materialization";
import { inspectWorkspace, loadPreparedWorkspace } from "./workspace-status";
import { readWorkspaceReviewFingerprint, sealWorkspaceDiff } from "./workspace-diff";
import { sealWorkspaceLog } from "./workspace-log";
import { checkpointOwnedWorkspace, restoreOwnedWorkspace, WorkspaceGitEffectUnconfirmed } from "./workspace-git-checkpoint";
import { openRetainedWorkspacePullRequest, publishOwnedWorkspace, readOwnedPublicationTarget } from "./workspace-publish";
import { syncOwnedWorkspace } from "./workspace-sync";
import { preserveOwnedWorkspace, releaseArchivedWorkspace } from "./workspace-archive";
import {
  recoverWorkspaceWorkload,
  runWorkspaceWorkload,
} from "./workspace-workload";

const requestSchemaTag = "maister.workspace.command.request.v1";
const opaqueId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const ownerSchema = z
  .object({
    kind: z.literal("assignment"),
    hostKey: z.string().regex(EXECUTION_HOST_KEY_PATTERN),
    runId: opaqueId,
    assignmentId: z.string().uuid(),
    assignmentEpoch: z.number().int().min(1).max(2_147_483_647),
  })
  .strict();
const requestSchema = z
  .object({
    workspaceProtocol: z.literal(1),
    command: z
      .object({
        id: z.string().uuid(),
        kind: z.literal("workspace.prepare"),
        issuedAt: z.string().max(35).datetime({ offset: true }),
      })
      .strict(),
    owner: ownerSchema,
    payload: z.union([
      z
        .object({
          mode: z.enum(["ownWorktree", "readOnlyCheckout"]),
          repositoryId: opaqueId,
          commit: z.string().regex(GIT_OBJECT_ID),
          inputDigest: sha256,
        })
        .strict(),
      z
        .object({
          mode: z.literal("sharedWorktree"),
          parentHandle: z.string().regex(/^ws_[a-f0-9]{32}$/),
          parentGeneration: generation,
          inputDigest: sha256,
        })
        .strict(),
      z
        .object({
          mode: z.literal("directory"),
          directoryProfileId: opaqueId,
          inputDigest: sha256,
        })
        .strict(),
      z
        .object({ mode: z.literal("emptyDirectory"), inputDigest: sha256 })
        .strict(),
    ]),
  })
  .strict();

const workspaceHandle = z.string().regex(/^ws_[a-f0-9]{32}$/);
const workspaceQuery = z.object({
  generation: z.string().regex(/^[1-9][0-9]{0,15}$/).transform(Number).pipe(generation),
}).strict();
const diffQuery = workspaceQuery.extend({
  base: z.string().regex(GIT_OBJECT_ID).optional(),
  head: z.string().regex(GIT_OBJECT_ID).optional(),
  checkpointId: z.string().uuid().optional(),
  format: z.literal("review").optional(),
}).refine(({ checkpointId, base, head, format }) =>
  (!checkpointId || (!base && !head)) && (format !== "review" || (!head && Boolean(base || checkpointId))),
);
const logQuery = workspaceQuery.extend({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).pipe(z.number().max(WORKSPACE_LOG_MAX_PAGE_SIZE)).optional(),
  base: z.string().regex(GIT_OBJECT_ID).optional(),
  head: z.string().regex(GIT_OBJECT_ID).optional(),
}).refine(({ base, head, cursor, limit }) => (!base && !head) || Boolean(base && head && cursor === undefined && limit === undefined));
const reviewFingerprintQuery = workspaceQuery.extend({ base: z.string().regex(GIT_OBJECT_ID) });
const publicationTargetQuery = workspaceQuery.extend({
  remoteId: opaqueId,
  targetRef: z.string().refine(isWorkspaceSourceRef),
});
const materializeSchema = z
  .object({
    workspaceProtocol: z.literal(1),
    owner: ownerSchema,
    command: z
      .object({
        id: z.string().uuid(),
        kind: z.literal("workspace.materialize"),
        issuedAt: z.string().max(35).datetime({ offset: true }),
      })
      .strict(),
    payload: z
      .object({
        generation,
        manifestDigest: sha256,
        objects: z
          .array(z.object({ objectId: z.string().uuid(), sha256 }).strict())
          .min(1)
          .max(256),
      })
      .strict(),
  })
  .strict();

const workloadSchema = z
  .object({
    workspaceProtocol: z.literal(1),
    owner: ownerSchema,
    command: z
      .object({
        id: z.string().uuid(),
        kind: z.literal("workspace.run"),
        issuedAt: z.string().max(35).datetime({ offset: true }),
      })
      .strict(),
    payload: z
      .object({
        generation,
        workload: z.enum(WORKSPACE_WORKLOAD_KINDS),
        declarationId: opaqueId,
        inputGeneration: generation,
        inputDigest: sha256,
        templateContext: z.object({ objectId: z.string().uuid(), sha256 }).strict().optional(),
      })
      .strict(),
  })
  .strict();
const cancelSchema = workloadSchema.extend({
  command: workloadSchema.shape.command.extend({
    kind: z.literal("workspace.cancel"),
  }),
  payload: z.object({ generation }).strict(),
});
const checkpointSchema = workloadSchema.extend({
  command: workloadSchema.shape.command.extend({ kind: z.literal("workspace.checkpoint") }),
  payload: z.object({ generation }).strict(),
});
const restoreSchema = workloadSchema.extend({
  command: workloadSchema.shape.command.extend({ kind: z.literal("workspace.restore") }),
  payload: z.object({ generation, checkpointId: z.string().uuid(), policy: z.literal("fresh-attempt").optional() }).strict(),
});
const publishSchema = workloadSchema.extend({
  command: workloadSchema.shape.command.extend({ kind: z.literal("workspace.publish") }),
  owner: z.object({
    kind: z.literal("workspaceOperation"),
    hostKey: z.string().regex(EXECUTION_HOST_KEY_PATTERN),
    workspaceHandle,
    workspaceGeneration: generation,
    claimId: z.string().uuid(),
    fence: generation,
  }).strict(),
  payload: z.object({
    generation,
    expected: z.object({
      head: z.string().regex(GIT_OBJECT_ID),
      remoteId: opaqueId,
      targetRef: z.string().refine(isWorkspaceSourceRef),
      priorTarget: z.string().regex(GIT_OBJECT_ID).nullable(),
    }).strict(),
    publication: z.enum(["push", "promote", "openPullRequest"]),
    integration: z.enum(["merge", "rebase"]).optional(),
    pullRequest: z.object({
      baseRef: z.string().refine(isWorkspaceSourceRef),
      baseCommit: z.string().regex(GIT_OBJECT_ID),
      title: z.string().min(1).max(256),
      body: z.string().max(32_768),
      draft: z.boolean(),
    }).strict().optional(),
  }).strict().refine(({ integration, publication, expected, pullRequest }) =>
    (!integration || (publication === "promote" && expected.priorTarget !== null)) &&
    (publication === "openPullRequest") === Boolean(pullRequest) &&
    pullRequest?.baseRef !== expected.targetRef,
  ),
});
const archiveSchema = publishSchema.extend({
  command: publishSchema.shape.command.extend({ kind: z.literal("workspace.preserve") }),
  payload: z.object({ generation, disposition: z.literal("archive"), quiescenceId: opaqueId }).strict(),
});
const syncSchema = publishSchema.extend({
  command: publishSchema.shape.command.extend({ kind: z.literal("workspace.sync") }),
  payload: z.object({
    generation,
    expected: publishSchema.shape.payload.shape.expected,
    strategy: z.enum(["fastForward", "merge", "rebase"]),
  }).strict(),
});
const releaseSchema = publishSchema.extend({
  command: publishSchema.shape.command.extend({ kind: z.literal("workspace.release") }),
  payload: z.object({ generation, dispositionId: z.string().uuid(), quiescenceId: opaqueId }).strict(),
});

type WorkspaceEffect = (
  | { request: WorkspaceCommandRequest; binding: WorkspaceCommandBinding }
  | { request: WorkspaceRetainedRequest; binding: WorkspaceRetainedBinding }
) & Readonly<{
  sourceDigest: string | null;
  run: (
    assertOwner: () => void,
  ) => Promise<
    | PreparedWorkspace
    | MaterializedWorkspaceInputs
    | WorkspaceWorkloadResult
    | WorkspaceCancelWorkloadResult
    | WorkspaceGitCheckpointResult
    | WorkspacePublishResult
    | WorkspaceSyncResult
    | WorkspacePreserveResult
    | WorkspaceReleaseResult
    | null
  >;
}>;

function receiptBinding(row: CommandReceiptRow): WorkspaceCommandBinding | WorkspaceRetainedBinding {
  if (row.kind === "workspace.prepare")
    return {
      operationId: WORKSPACE_PREPARE_OPERATION,
      target: WORKSPACE_PREPARE_TARGET,
    };
  const stored = row.body as { workspaceTarget?: unknown };
  if (
    row.kind === "workspace.cancel" &&
    isWorkspaceCancelTarget(stored.workspaceTarget)
  )
    return {
      operationId: WORKSPACE_CANCEL_OPERATION,
      target: stored.workspaceTarget,
    };
  if (
    row.kind === "workspace.run" &&
    isWorkspaceGenerationTarget(stored.workspaceTarget)
  )
    return {
      operationId: WORKSPACE_RUN_OPERATION,
      target: stored.workspaceTarget,
    };
  if (
    row.kind === "workspace.materialize" &&
    isWorkspaceGenerationTarget(stored.workspaceTarget)
  )
    return {
      operationId: WORKSPACE_MATERIALIZE_OPERATION,
      target: stored.workspaceTarget,
    };
  if (row.kind === "workspace.checkpoint" && isWorkspaceGenerationTarget(stored.workspaceTarget))
    return { operationId: WORKSPACE_CHECKPOINT_OPERATION, target: stored.workspaceTarget };
  if (row.kind === "workspace.restore" && isWorkspaceGenerationTarget(stored.workspaceTarget))
    return { operationId: WORKSPACE_RESTORE_OPERATION, target: stored.workspaceTarget };
  if (row.kind === "workspace.publish" && isWorkspaceGenerationTarget(stored.workspaceTarget))
    return { operationId: WORKSPACE_PUBLISH_OPERATION, target: stored.workspaceTarget };
  if (row.kind === "workspace.sync" && isWorkspaceGenerationTarget(stored.workspaceTarget))
    return { operationId: WORKSPACE_SYNC_OPERATION, target: stored.workspaceTarget };
  if (row.kind === "workspace.preserve" && isWorkspaceGenerationTarget(stored.workspaceTarget))
    return { operationId: WORKSPACE_PRESERVE_OPERATION, target: stored.workspaceTarget };
  if (row.kind === "workspace.release" && isWorkspaceGenerationTarget(stored.workspaceTarget))
    return { operationId: WORKSPACE_RELEASE_OPERATION, target: stored.workspaceTarget };

  throw new SupervisorError(
    "ACP_PROTOCOL",
    "Stored workspace command target is invalid",
  );
}

function storedPublicationOwner(row: CommandReceiptRow): WorkspaceOperationOwner {
  const { workspaceOwner } = row.body as { workspaceOwner?: unknown };
  if (!isWorkspaceOperationOwner(workspaceOwner))
    throw new SupervisorError("ACP_PROTOCOL", "Stored publication owner is invalid");

  return workspaceOwner;
}

function acceptance(commandId: string): {
  commandId: string;
  state: "accepted";
} {
  return { commandId, state: "accepted" };
}

function refusal(code: string, reason: string, message: string) {
  return { code, message, details: { reason } };
}

function getSource(
  sources: ReadonlyMap<string, string>,
  directories: ReadonlyMap<string, string>,
  request: WorkspacePrepareRequest,
): string | null {
  const { payload } = request;
  if (payload.mode === "ownWorktree" || payload.mode === "readOnlyCheckout")
    return sources.get(payload.repositoryId) ?? null;
  if (payload.mode === "directory")
    return directories.get(payload.directoryProfileId) ?? null;

  return null;
}

function readDirectoryProfiles(): ReadonlyMap<string, string> {
  const raw = process.env.MAISTER_WORKSPACE_DIRECTORIES;
  if (!raw) return new Map();
  try {
    const parsed = z
      .record(opaqueId, z.string().max(4_096).refine(isAbsolute))
      .parse(JSON.parse(raw));

    return new Map(Object.entries(parsed));
  } catch {
    throw new SupervisorError(
      "PRECONDITION",
      "MAISTER_WORKSPACE_DIRECTORIES must map approved IDs to absolute paths",
    );
  }
}

export function registerWorkspacePreparation(args: {
  app: FastifyInstance;
  state: HostState;
  registry: WorkspaceRegistry;
  objects: RuntimeObjectRegistry;
  events: RuntimeEventPublisher;
  runtimeRoot: string;
  sources: ReadonlyMap<string, string>;
  logger: Logger;
}): void {
  const {
    app,
    state,
    registry,
    objects,
    events,
    runtimeRoot,
    sources,
    logger,
  } = args;
  const directories = readDirectoryProfiles();
  const inflight = new Map<string, Promise<void>>();
  const workloads = new Map<string, AbortController>();

  app.addHook("preClose", async () => {
    for (const controller of workloads.values()) controller.abort();
  });
  app.addHook("onClose", async () => {
    await Promise.allSettled(inflight.values());
  });

  function assertCurrent(row: CommandReceiptRow): void {
    const current = state.getFence(row.runId);
    if (
      !current ||
      current.epoch !== row.epoch ||
      current.assignmentId !== row.assignmentId
    )
      throw new SupervisorError(
        "FENCED",
        "Workspace preparation lost its assignment",
        { details: { reason: "stale_assignment_epoch" } },
      );
  }

  async function finish(
    row: CommandReceiptRow,
    effect: WorkspaceEffect,
  ): Promise<void> {
    const { request, binding } = effect;
    if (row.assignmentId === null)
      throw new SupervisorError("ACP_PROTOCOL", "Workspace receipt has no retained assignment provenance");
    let outcome: Record<string, unknown>;
    let phase: "completed" | "rejected" | "indeterminate";
    try {
      const result = await effect.run(() => assertCurrent(row));
      if (result === null) return;
      outcome = { result };
      phase = "completed";
    } catch (error) {
      if (isSupervisorError(error)) {
        const reason = error.details?.reason;
        outcome = {
          refusal: refusal(
            error.code,
            typeof reason === "string" ? reason : "workspace_rejected",
            "Workspace preparation was refused",
          ),
        };
        phase = "rejected";
      } else {
        outcome = { condition: "effect_unconfirmed" };
        phase = "indeterminate";
      }
      logger.warn(
        {
          commandId: row.commandId,
          runId: row.runId,
          phase,
          errorType: error instanceof Error ? error.name : typeof error,
        },
        "workspace-preparation-unsettled",
      );
    }
    const completedAt = new Date().toISOString();
    const outcomeSha256 = workspaceEvidenceDigest(outcome);
    const identity = {
      commandId: row.commandId,
      requestSha256: workspaceCommandRequestDigest(request, binding),
      phase,
      outcomeSha256,
    };
    let payload: WorkspaceTerminalPayload;
    const retained = binding.operationId === WORKSPACE_PUBLISH_OPERATION || binding.operationId === WORKSPACE_SYNC_OPERATION ||
      binding.operationId === WORKSPACE_PRESERVE_OPERATION || binding.operationId === WORKSPACE_RELEASE_OPERATION;
    if (retained && request.owner.kind === "workspaceOperation") {
      payload = { ...identity, ...binding, owner: request.owner };
    } else if (!retained && request.owner.kind === "assignment") {
      payload = { ...identity, ...binding, owner: request.owner };
    } else {
      throw new SupervisorError("ACP_PROTOCOL", "Workspace command owner and target disagree");
    }
    state.putReceiptWithRuntimeEvent(
      {
        ...row,
        phase: phase === "completed" ? "completed" : "rejected",
        body: {
          ...outcome,
          workspacePhase: phase,
          outcomeSha256,
          workspaceTarget: binding.target,
          ...(request.owner.kind === "workspaceOperation" ? { workspaceOwner: request.owner } : {}),
          ...("quiescenceId" in request.payload ? { archiveQuiescenceId: request.payload.quiescenceId } : {}),
          ...("dispositionId" in request.payload ? { archiveDispositionId: request.payload.dispositionId } : {}),
          ...(request.command.kind === "workspace.run"
            ? {
                workspaceProcess: (
                  state.getReceipt(row.commandId)?.body as
                    | {
                        workspaceProcess?: unknown;
                      }
                    | undefined
                )?.workspaceProcess,
              }
            : {}),
        },
        completedAt,
      },
      {
        terminal: true,
        draft: {
          runId: row.runId,
          assignmentId: row.assignmentId,
          assignmentEpoch: row.epoch,
          hostSessionId: null,
          eventType: "workspace.command.terminal",
          occurredAt: completedAt,
          payload,
        },
      },
    );
    if (request.owner.kind === "workspaceOperation")
      logger.info({
        commandId: row.commandId,
        runId: row.runId,
        workspaceHandle: request.owner.workspaceHandle,
        generation: request.owner.workspaceGeneration,
        claimId: request.owner.claimId,
        fence: request.owner.fence,
        phase,
        outcomeSha256,
        ...("expected" in request.payload && phase === "completed"
          ? { verifiedHead: request.payload.expected.head, targetRef: request.payload.expected.targetRef }
          : {}),
      }, "retained-workspace-operation-settled");
  }

  function admit(reply: FastifyReply, effect: WorkspaceEffect): FastifyReply {
    const { request, binding, sourceDigest } = effect;
    if (request.owner.hostKey !== state.hostKey)
      return reply
        .status(409)
        .send(
          refusal(
            "EXECUTOR_UNAVAILABLE",
            "host_identity_mismatch",
            "Workspace preparation belongs to another host",
          ),
        );
    const { command, owner } = request;
    const requestDigest = workspaceCommandRequestDigest(request, binding);
    const existing = state.getReceipt(command.id);
    if (
      existing &&
      (existing.requestSchema !== requestSchemaTag ||
        existing.requestDigest !== requestDigest)
    )
      return reply
        .status(409)
        .send(
          refusal(
            "CONFLICT",
            "command_digest_mismatch",
            "Command ID already binds a different workspace request",
          ),
        );
    const accept = () =>
      reply
        .header("location", `/v1/commands/${command.id}`)
        .status(202)
        .send(acceptance(command.id));
    if (existing) reply.header(REPLAYED_HEADER, "true");
    if (existing && (existing.phase !== "accepted" || inflight.has(command.id)))
      return accept();

    if (
      existing &&
      (existing.body as { sourceDigest?: unknown }).sourceDigest !==
        sourceDigest
    )
      return reply
        .status(409)
        .send(
          refusal(
            "PRECONDITION",
            "source_ref_unapproved",
            "Workspace source approval changed since acceptance",
          ),
        );
    let provenance: { runId: string; assignmentId: string; assignmentEpoch: number };
    if ("runId" in owner) {
      const { hostKey, runId, assignmentId, assignmentEpoch }: CommandFence = owner;
      applyFence({ state, fence: { hostKey, runId, assignmentId, assignmentEpoch }, logger });
      provenance = owner;
    } else {
      const workspace = state.getWorkspace(owner.workspaceHandle);
      const fence = workspace && state.getFence(workspace.runId);
      if (!workspace || !fence || (existing && (
        existing.runId !== workspace.runId || existing.assignmentId !== fence.assignmentId || existing.epoch !== fence.epoch
      )))
        return reply.status(409).send(refusal("FENCED", "stale_workspace_generation", "Retained workspace ownership is unavailable"));
      provenance = { runId: workspace.runId, assignmentId: fence.assignmentId, assignmentEpoch: fence.epoch };
    }
    const row: CommandReceiptRow = existing ?? {
      commandId: command.id,
      runId: provenance.runId,
      kind: command.kind,
      assignmentId: provenance.assignmentId,
      epoch: provenance.assignmentEpoch,
      hostSessionId: null,
      hostKey: owner.hostKey,
      requestVersion: 1,
      requestSchema: requestSchemaTag,
      requestDigest,
      eventId: null,
      phase: "accepted",
      httpStatus: 202,
      body: {
        sourceDigest,
        workspaceTarget: binding.target,
        ...(owner.kind === "workspaceOperation" ? { workspaceOwner: owner } : {}),
        ...("dispositionId" in request.payload ? { archiveDispositionId: request.payload.dispositionId } : {}),
      },
      receivedAt: new Date().toISOString(),
      completedAt: null,
    };
    if (!existing)
      state.putReceipt(row, {
        kind: command.kind === "workspace.cancel" || command.kind === "workspace.release" ? "teardown" : "new_work",
      });

    const execution = finish(
      row,
      existing &&
        request.command.kind === "workspace.run" &&
        binding.operationId === WORKSPACE_RUN_OPERATION
        ? {
            ...effect,
            run: () =>
              recoverWorkspaceWorkload(existing, binding.target.generation),
          }
        : effect,
    )
      .catch((error: unknown) => {
        state.reportRuntimeStorageFailure(error);
        logger.error(
          {
            commandId: row.commandId,
            runId: row.runId,
            errorType: error instanceof Error ? error.name : typeof error,
          },
          "workspace-preparation-terminal-write-failed",
        );
      })
      .finally(() => inflight.delete(command.id));
    inflight.set(command.id, execution);

    return accept();
  }

  type StatusRequest = { Params: { id: string }; Querystring: unknown };
  async function readWorkspaceStatus(id: string, query: unknown) {
    const handle = workspaceHandle.safeParse(id);
    const parsed = workspaceQuery.safeParse(query);
    if (!handle.success || !parsed.success)
      throw new SupervisorError("PRECONDITION", "Workspace handle and generation are required", {
        details: { reason: "invalid_request" },
      });

    return inspectWorkspace(state, handle.data, parsed.data.generation);
  }

  const missingWorkspace = refusal("NOT_FOUND", "resource_not_found", "Workspace is unavailable");

  app.get<StatusRequest>("/v1/workspaces/:id", async (req, reply) => {
    const result = await readWorkspaceStatus(req.params.id, req.query);

    return result?.workspace ?? reply.status(404).send(missingWorkspace);
  });
  app.get<StatusRequest>("/v1/workspaces/:id/status", async (req, reply) => {
    const result = await readWorkspaceStatus(req.params.id, req.query);

    return result ?? reply.status(404).send(missingWorkspace);
  });
  app.get<StatusRequest>("/v1/workspaces/:id/diff", async (req, reply) => {
    const handle = workspaceHandle.safeParse(req.params.id);
    const parsed = diffQuery.safeParse(req.query);
    if (!handle.success || !parsed.success)
      throw new SupervisorError("PRECONDITION", "Workspace diff requires a handle, generation and exact commit IDs", {
        details: { reason: "invalid_request" },
      });
    const result = await sealWorkspaceDiff({ state, objects, events }, { ...parsed.data, handle: handle.data });

    return result ?? reply.status(404).send(missingWorkspace);
  });
  app.get<StatusRequest>("/v1/workspaces/:id/review-fingerprint", async (req, reply) => {
    const handle = workspaceHandle.safeParse(req.params.id);
    const parsed = reviewFingerprintQuery.safeParse(req.query);
    if (!handle.success || !parsed.success)
      return reply.status(400).send(refusal("PRECONDITION", "invalid_request", "Review fingerprint requires a handle, generation and pinned base"));
    const result = await readWorkspaceReviewFingerprint(state, { ...parsed.data, handle: handle.data });

    return result ?? reply.status(404).send(missingWorkspace);
  });
  app.get<StatusRequest>("/v1/workspaces/:id/publication-target", async (req, reply) => {
    const handle = workspaceHandle.safeParse(req.params.id);
    const parsed = publicationTargetQuery.safeParse(req.query);
    if (!handle.success || !parsed.success)
      return reply.status(400).send(refusal("PRECONDITION", "invalid_request", "Publication target requires a handle, generation, repository and branch"));
    const { generation, remoteId, targetRef } = parsed.data;
    const owned = loadPreparedWorkspace(state, handle.data, generation);
    if (!owned) return reply.status(404).send(missingWorkspace);
    const source = sources.get(remoteId);
    if (owned.mode !== "ownWorktree" || owned.workspace.projectSlug !== remoteId || !source)
      return reply.status(409).send(refusal("PRECONDITION", "source_ref_unapproved", "The workspace has no approved publication source"));

    return readOwnedPublicationTarget({ state, runtimeRoot, source, handle: handle.data, generation, remoteId, targetRef });
  });
  app.get<StatusRequest>("/v1/workspaces/:id/log", async (req, reply) => {
    const handle = workspaceHandle.safeParse(req.params.id);
    const parsed = logQuery.safeParse(req.query);
    if (!handle.success || !parsed.success)
      return reply.status(400).send(refusal("PRECONDITION", "invalid_request", "Git log requires a handle, generation and valid page options"));
    const result = await sealWorkspaceLog({ state, objects, events }, { ...parsed.data, handle: handle.data });

    return result ?? reply.status(404).send(missingWorkspace);
  });

  app.post("/v1/workspaces/prepare", async (req, reply) => {
    if (
      req.body &&
      typeof req.body === "object" &&
      "workspaceProtocol" in req.body &&
      req.body.workspaceProtocol !== 1
    )
      return reply
        .status(503)
        .send(
          refusal(
            "EXECUTOR_UNAVAILABLE",
            "workspace_protocol_unsupported",
            "Workspace protocol 1 is required",
          ),
        );
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success)
      return reply
        .status(400)
        .send(
          refusal(
            "PRECONDITION",
            "invalid_request",
            "Invalid workspace preparation request",
          ),
        );
    const request = parsed.data;
    const source = getSource(sources, directories, request);
    return admit(reply, {
      request,
      binding: {
        operationId: WORKSPACE_PREPARE_OPERATION,
        target: WORKSPACE_PREPARE_TARGET,
      },
      sourceDigest: source === null ? null : workspaceEvidenceDigest(source),
      run: (assertOwner) =>
        prepareOwnedWorkspace({
          request,
          source,
          state,
          registry,
          runtimeRoot,
          assertOwner,
        }),
    });
  });

  app.post<{ Params: { id: string } }>(
    "/v1/workspaces/:id/materialization",
    async (req, reply) => {
      const parsed = materializeSchema.safeParse(req.body);
      const handle = workspaceHandle.safeParse(req.params.id);
      if (!parsed.success || !handle.success)
        return reply
          .status(400)
          .send(
            refusal(
              "PRECONDITION",
              "invalid_request",
              "Invalid workspace input request",
            ),
          );
      const request = parsed.data;
      return admit(reply, {
        request,
        binding: {
          operationId: WORKSPACE_MATERIALIZE_OPERATION,
          target: {
            kind: "workspace",
            handle: handle.data,
            generation: request.payload.generation,
          },
        },
        sourceDigest: null,
        run: (assertOwner) =>
          materializeWorkspaceInputs({
            handle: handle.data,
            request,
            state,
            objects,
            runtimeRoot,
            sources,
            assertOwner,
          }),
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/workspaces/:id/commands",
    async (req, reply) => {
      const parsed = workloadSchema.safeParse(req.body);
      const handle = workspaceHandle.safeParse(req.params.id);
      if (!parsed.success || !handle.success)
        return reply
          .status(400)
          .send(
            refusal(
              "PRECONDITION",
              "invalid_request",
              "Invalid workspace workload request",
            ),
          );
      const request = parsed.data;

      if (request.owner.hostKey === state.hostKey && state.isWorkspaceWorkloadCancelled({
        ...request.owner,
        commandId: request.command.id,
        handle: handle.data,
        generation: request.payload.generation,
      })) return reply.status(409).send(refusal("CONFLICT", "workspace_workload_cancelled", "The retained cancellation forbids admitting this workload"));

      return admit(reply, {
        request,
        binding: {
          operationId: WORKSPACE_RUN_OPERATION,
          target: {
            kind: "workspace",
            handle: handle.data,
            generation: request.payload.generation,
          },
        },
        sourceDigest: null,
        async run(assertOwner) {
          const controller = new AbortController();
          workloads.set(request.command.id, controller);
          try {
            return await runWorkspaceWorkload({
              request,
              handle: handle.data,
              state,
              events,
              objects,
              runtimeRoot,
              signal: controller.signal,
              assertOwner,
              logger,
            });
          } finally {
            workloads.delete(request.command.id);
          }
        },
      });
    },
  );

  app.post<{ Params: { id: string; commandId: string } }>(
    "/v1/workspaces/:id/commands/:commandId/cancel",
    async (req, reply) => {
      const parsed = cancelSchema.safeParse(req.body);
      const handle = workspaceHandle.safeParse(req.params.id);
      const targetId = z.string().uuid().safeParse(req.params.commandId);
      if (
        !parsed.success ||
        !handle.success ||
        !targetId.success ||
        parsed.data.command.id === targetId.data
      )
        return reply
          .status(400)
          .send(
            refusal(
              "PRECONDITION",
              "invalid_request",
              "Invalid workload cancellation",
            ),
          );
      const request = parsed.data;
      const original = state.getReceipt(targetId.data);
      const originalTarget = (
        original?.body as { workspaceTarget?: unknown } | undefined
      )?.workspaceTarget;
      const workspace = state.getWorkspace(handle.data);
      const matchingOriginal = original &&
        original.kind === "workspace.run" &&
        original.runId === request.owner.runId &&
        original.assignmentId === request.owner.assignmentId &&
        original.epoch === request.owner.assignmentEpoch &&
        isWorkspaceGenerationTarget(originalTarget) &&
        originalTarget.handle === handle.data &&
        originalTarget.generation === request.payload.generation;
      const pendingTarget = !original && workspace?.runId === request.owner.runId &&
        workspace.releasedAt === null &&
        state.getWorkspaceExecutionState(handle.data)?.generation === request.payload.generation;
      if (!state.getReceipt(request.command.id) && !matchingOriginal && !pendingTarget)
        return reply
          .status(409)
          .send(
            refusal(
              "FENCED",
              "stale_workspace_generation",
              "The cancellation owner differs from the retained workload",
            ),
          );

      return admit(reply, {
        request,
        binding: {
          operationId: WORKSPACE_CANCEL_OPERATION,
          target: {
            kind: "cancelWorkload",
            handle: handle.data,
            generation: request.payload.generation,
            commandId: targetId.data,
          },
        },
        sourceDigest: null,
        async run(assertOwner) {
          assertOwner();
          const targetCommandId = targetId.data;
          if (!original) {
            if (!state.isWorkspaceWorkloadCancelled({
              ...request.owner,
              commandId: targetCommandId,
              handle: handle.data,
              generation: request.payload.generation,
            })) throw new SupervisorError("FENCED", "Cancellation no longer owns the missing workload", {
              details: { reason: "stale_workspace_generation" },
            });

            return { targetCommandId, quiescence: "proved", objects: [] };
          }
          if (!matchingOriginal)
            throw new SupervisorError("FENCED", "Cancellation no longer owns its workload", {
              details: { reason: "stale_workspace_generation" },
            });
          workloads.get(targetCommandId)?.abort();
          await inflight.get(targetCommandId);
          const receipt = state.getReceipt(targetCommandId);
          const retained =
            receipt?.phase === "completed"
              ? (receipt.body as { result?: WorkspaceWorkloadResult }).result
              : receipt
                ? await recoverWorkspaceWorkload(
                    receipt,
                    request.payload.generation,
                  )
                : undefined;

          return {
            targetCommandId,
            quiescence: retained?.quiescence ?? "uncertain",
            objects: retained?.objects ?? [],
          };
        },
      });
    },
  );

  app.post<{ Params: { id: string } }>("/v1/workspaces/:id/checkpoint", async (req, reply) => {
    const parsed = checkpointSchema.safeParse(req.body);
    const handle = workspaceHandle.safeParse(req.params.id);
    if (!parsed.success || !handle.success)
      return reply.status(400).send(refusal("PRECONDITION", "invalid_request", "Invalid workspace checkpoint request"));
    return admit(reply, {
      request: parsed.data,
      binding: { operationId: WORKSPACE_CHECKPOINT_OPERATION, target: { kind: "workspace", handle: handle.data, generation: parsed.data.payload.generation } },
      sourceDigest: null,
      run: (assertOwner) => checkpointOwnedWorkspace({ state, handle: handle.data, assertOwner }, parsed.data),
    });
  });

  app.post<{ Params: { id: string } }>("/v1/workspaces/:id/restore", async (req, reply) => {
    const parsed = restoreSchema.safeParse(req.body);
    const handle = workspaceHandle.safeParse(req.params.id);
    if (!parsed.success || !handle.success)
      return reply.status(400).send(refusal("PRECONDITION", "invalid_request", "Invalid workspace restore request"));
    return admit(reply, {
      request: parsed.data,
      binding: { operationId: WORKSPACE_RESTORE_OPERATION, target: { kind: "workspace", handle: handle.data, generation: parsed.data.payload.generation } },
      sourceDigest: null,
      async run(assertOwner) {
        const replayingClaim = state.getWorkspaceExecutionState(handle.data)?.operationClaimId === parsed.data.command.id;
        try {
          return await restoreOwnedWorkspace({ state, handle: handle.data, assertOwner }, parsed.data);
        } catch (cause) {
          if (!replayingClaim) throw cause;
          // Once a restore may have reached Git, refusal cannot release its writer fence.
          throw new WorkspaceGitEffectUnconfirmed("Retained restore could not prove its exact resulting tree", { cause });
        }
      },
    });
  });

  app.post<{ Params: { id: string } }>("/v1/workspaces/:id/publication", async (req, reply) => {
    const parsed = publishSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.owner.workspaceHandle !== req.params.id ||
      parsed.data.owner.workspaceGeneration !== parsed.data.payload.generation)
      return reply.status(400).send(refusal("PRECONDITION", "invalid_request", "Publication owner and workspace must match"));

    const request = parsed.data;
    const { workspaceHandle: handle, workspaceGeneration: generation } = request.owner;
    const source = sources.get(request.payload.expected.remoteId);
    return admit(reply, {
      request,
      binding: { operationId: WORKSPACE_PUBLISH_OPERATION, target: { kind: "workspace", handle, generation } },
      sourceDigest: source === undefined ? null : workspaceEvidenceDigest(source),
      async run(assertOwner) {
        const replaying = state.getWorkspaceExecutionState(handle)?.operationClaimId === request.command.id;
        try {
          const workspace = state.getWorkspace(handle);
          const fence = workspace && state.getFence(workspace.runId);
          if (!workspace || !fence || source === undefined)
            throw new SupervisorError("PRECONDITION", "The publication source or checkout is unavailable", {
              details: { reason: "source_ref_unapproved" },
            });
          assertOwner();
          const input = {
            state, runtimeRoot, source, runId: workspace.runId,
            assignmentId: fence.assignmentId, assignmentEpoch: fence.epoch,
          };
          return request.payload.publication === "openPullRequest"
            ? await openRetainedWorkspacePullRequest(input, request, assertOwner, logger)
            : await publishOwnedWorkspace(input, request);
        } catch (cause) {
          if (!replaying || cause instanceof WorkspaceGitEffectUnconfirmed) throw cause;
          throw new WorkspaceGitEffectUnconfirmed("Retained publication verification could not finish", { cause });
        }
      },
    });
  });

  app.post<{ Params: { id: string } }>("/v1/workspaces/:id/sync", async (req, reply) => {
    const parsed = syncSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.owner.workspaceHandle !== req.params.id ||
      parsed.data.owner.workspaceGeneration !== parsed.data.payload.generation)
      return reply.status(400).send(refusal("PRECONDITION", "invalid_request", "Sync owner and workspace must match"));
    const request = parsed.data;
    const { workspaceHandle: handle, workspaceGeneration: generation } = request.owner;
    const source = sources.get(request.payload.expected.remoteId);
    return admit(reply, {
      request,
      binding: { operationId: WORKSPACE_SYNC_OPERATION, target: { kind: "workspace", handle, generation } },
      sourceDigest: source === undefined ? null : workspaceEvidenceDigest(source),
      async run(assertOwner) {
        const workspace = state.getWorkspace(handle);
        const fence = workspace && state.getFence(workspace.runId);
        if (!workspace || !fence || source === undefined)
          throw new SupervisorError("PRECONDITION", "The sync source or checkout is unavailable", {
            details: { reason: "source_ref_unapproved" },
          });
        assertOwner();
        return syncOwnedWorkspace({
          state, runtimeRoot, source, runId: workspace.runId,
          assignmentId: fence.assignmentId, assignmentEpoch: fence.epoch, assertOwner,
        }, request);
      },
    });
  });

  app.post<{ Params: { id: string } }>("/v1/workspaces/:id/preserve", async (req, reply) => {
    const parsed = archiveSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.owner.workspaceHandle !== req.params.id ||
      parsed.data.owner.workspaceGeneration !== parsed.data.payload.generation)
      return reply.status(400).send(refusal("PRECONDITION", "invalid_request", "Archive owner and workspace must match"));
    const request = parsed.data;
    const { workspaceHandle: handle, workspaceGeneration: generation } = request.owner;

    return admit(reply, {
      request, sourceDigest: null,
      binding: { operationId: WORKSPACE_PRESERVE_OPERATION, target: { kind: "workspace", handle, generation } },
      run: (assertOwner) => preserveOwnedWorkspace({ state, runtimeRoot, assertOwner }, request),
    });
  });

  app.delete<{ Params: { id: string } }>("/v1/workspaces/:id", async (req, reply) => {
    const parsed = releaseSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.owner.workspaceHandle !== req.params.id ||
      parsed.data.owner.workspaceGeneration !== parsed.data.payload.generation)
      return reply.status(400).send(refusal("PRECONDITION", "invalid_request", "Release owner and workspace must match"));
    const request = parsed.data;
    const { workspaceHandle: handle, workspaceGeneration: generation } = request.owner;

    return admit(reply, {
      request, sourceDigest: null,
      binding: { operationId: WORKSPACE_RELEASE_OPERATION, target: { kind: "workspace", handle, generation } },
      run: (assertOwner) => releaseArchivedWorkspace({ state, runtimeRoot, assertOwner }, request),
    });
  });

  app.get<{ Params: { commandId: string } }>(
    "/v1/commands/:commandId",
    async (req, reply) => {
      const row = state.getReceipt(req.params.commandId);
      if (
        !row ||
        (row.body as { retired?: unknown }).retired === true ||
        row.requestSchema !== requestSchemaTag ||
        row.hostKey !== state.hostKey
      )
        return reply
          .status(404)
          .send(
            refusal(
              "NOT_FOUND",
              "resource_not_found",
              "Workspace receipt not found",
            ),
          );
      const binding = receiptBinding(row);
      const record = {
        commandId: row.commandId,
        requestSha256: row.requestDigest,
        ...binding,
        owner: isWorkspaceRetainedOperation(binding.operationId) ? storedPublicationOwner(row) : {
          kind: "assignment",
          hostKey: row.hostKey,
          runId: row.runId,
          assignmentId: row.assignmentId,
          assignmentEpoch: row.epoch,
        },
      };
      if (row.phase === "accepted")
        return reply.status(200).send({
          ...record,
          phase: "accepted",
          status: 202,
          acceptance: acceptance(row.commandId),
        });

      const {
        workspacePhase,
        workspaceTarget: _workspaceTarget,
        workspaceProcess: _workspaceProcess,
        workspaceOwner: _workspaceOwner,
        archiveDispositionId: _archiveDispositionId,
        archiveQuiescenceId: _archiveQuiescenceId,
        ...outcome
      } = row.body as Record<string, unknown>;

      return reply.status(200).send({
        ...record,
        phase: workspacePhase,
        streamId: row.terminalStreamId,
        eventId: row.eventId,
        ...outcome,
      });
    },
  );
}
