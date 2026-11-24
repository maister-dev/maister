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
  WORKSPACE_CANCEL_OPERATION,
  WORKSPACE_MATERIALIZE_OPERATION,
  WORKSPACE_PREPARE_OPERATION,
  WORKSPACE_PREPARE_TARGET,
  WORKSPACE_RUN_OPERATION,
  WORKSPACE_WORKLOAD_KINDS,
  workspaceEvidenceDigest,
  workspaceCommandRequestDigest,
} from "../../runtime/workspace-prepare";

import { REPLAYED_HEADER } from "./command-receipts";
import { applyFence } from "./execution-fence";
import { prepareOwnedWorkspace } from "./prepare-owned-workspace";
import { isSupervisorError, SupervisorError } from "./types";
import { materializeWorkspaceInputs } from "./workspace-input-materialization";
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

type WorkspaceEffect = Readonly<{
  request: WorkspaceCommandRequest;
  binding: WorkspaceCommandBinding;
  sourceDigest: string | null;
  run: (
    assertOwner: () => void,
  ) => Promise<
    | PreparedWorkspace
    | MaterializedWorkspaceInputs
    | WorkspaceWorkloadResult
    | WorkspaceCancelWorkloadResult
  >;
}>;

function receiptBinding(row: CommandReceiptRow): WorkspaceCommandBinding {
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

  throw new SupervisorError(
    "ACP_PROTOCOL",
    "Stored workspace command target is invalid",
  );
}

function acceptance(commandId: string): {
  commandId: string;
  state: "accepted";
} {
  return { commandId, state: "accepted" };
}

function fenceFor(request: WorkspaceCommandRequest): CommandFence {
  const { hostKey, runId, assignmentId, assignmentEpoch } = request.owner;

  return { hostKey, runId, assignmentId, assignmentEpoch };
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

  function assertCurrent(request: WorkspaceCommandRequest): void {
    const current = state.getFence(request.owner.runId);
    if (
      !current ||
      current.epoch !== request.owner.assignmentEpoch ||
      current.assignmentId !== request.owner.assignmentId
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
    let outcome: Record<string, unknown>;
    let phase: "completed" | "rejected" | "indeterminate";
    try {
      outcome = {
        result: await effect.run(() => assertCurrent(request)),
      };
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
    state.putReceiptWithRuntimeEvent(
      {
        ...row,
        phase: phase === "completed" ? "completed" : "rejected",
        body: {
          ...outcome,
          workspacePhase: phase,
          outcomeSha256,
          workspaceTarget: binding.target,
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
          assignmentId: request.owner.assignmentId,
          assignmentEpoch: request.owner.assignmentEpoch,
          hostSessionId: null,
          eventType: "workspace.command.terminal",
          occurredAt: completedAt,
          payload: {
            commandId: row.commandId,
            requestSha256: workspaceCommandRequestDigest(request, binding),
            ...binding,
            owner: request.owner,
            phase,
            outcomeSha256,
          },
        },
      },
    );
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
    applyFence({ state, fence: fenceFor(request), logger });
    const row: CommandReceiptRow = existing ?? {
      commandId: command.id,
      runId: owner.runId,
      kind: command.kind,
      assignmentId: owner.assignmentId,
      epoch: owner.assignmentEpoch,
      hostSessionId: null,
      hostKey: owner.hostKey,
      requestVersion: 1,
      requestSchema: requestSchemaTag,
      requestDigest,
      eventId: null,
      phase: "accepted",
      httpStatus: 202,
      body: { sourceDigest, workspaceTarget: binding.target },
      receivedAt: new Date().toISOString(),
      completedAt: null,
    };
    if (!existing)
      state.putReceipt(row, {
        kind: command.kind === "workspace.cancel" ? "teardown" : "new_work",
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
      if (
        original?.kind !== "workspace.run" ||
        original.runId !== request.owner.runId ||
        original.assignmentId !== request.owner.assignmentId ||
        original.epoch !== request.owner.assignmentEpoch ||
        !isWorkspaceGenerationTarget(originalTarget) ||
        originalTarget.handle !== handle.data ||
        originalTarget.generation !== request.payload.generation
      )
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
          workloads.get(original.commandId)?.abort();
          await inflight.get(original.commandId);
          const receipt = state.getReceipt(original.commandId);
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
            targetCommandId: original.commandId,
            quiescence: retained?.quiescence ?? "uncertain",
            objects: retained?.objects ?? [],
          };
        },
      });
    },
  );

  app.get<{ Params: { commandId: string } }>(
    "/v1/commands/:commandId",
    async (req, reply) => {
      const row = state.getReceipt(req.params.commandId);
      if (
        !row ||
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
      const record = {
        commandId: row.commandId,
        requestSha256: row.requestDigest,
        ...receiptBinding(row),
        owner: {
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
