import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";
import type { HostState, CommandReceiptRow } from "./host-state";
import type { CommandFence } from "./types";
import type { WorkspaceRegistry } from "./workspace-registry";
import type { WorkspacePrepareRequest } from "../../runtime/workspace-prepare";

import { isAbsolute } from "node:path";

import { z } from "zod";

import { EXECUTION_HOST_KEY_PATTERN } from "../../runtime/execution-host-address";
import { GIT_OBJECT_ID } from "../../runtime/wait-head";
import {
  WORKSPACE_PREPARE_OPERATION,
  WORKSPACE_PREPARE_TARGET,
  workspaceEvidenceDigest,
  workspacePrepareRequestDigest,
} from "../../runtime/workspace-prepare";

import { REPLAYED_HEADER } from "./command-receipts";
import { applyFence } from "./execution-fence";
import { prepareOwnedWorkspace } from "./prepare-owned-workspace";
import { isSupervisorError, SupervisorError } from "./types";

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

function acceptance(commandId: string): {
  commandId: string;
  state: "accepted";
} {
  return { commandId, state: "accepted" };
}

function fenceFor(request: WorkspacePrepareRequest): CommandFence {
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
  runtimeRoot: string;
  sources: ReadonlyMap<string, string>;
  logger: Logger;
}): void {
  const { app, state, registry, runtimeRoot, sources, logger } = args;
  const directories = readDirectoryProfiles();
  const inflight = new Map<string, Promise<void>>();

  app.addHook("onClose", async () => {
    await Promise.allSettled(inflight.values());
  });

  function assertCurrent(request: WorkspacePrepareRequest): void {
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
    request: WorkspacePrepareRequest,
    source: string | null,
  ): Promise<void> {
    let outcome: Record<string, unknown>;
    let phase: "completed" | "rejected" | "indeterminate";
    try {
      outcome = {
        result: await prepareOwnedWorkspace({
          request,
          source,
          state,
          registry,
          runtimeRoot,
          assertOwner: () => assertCurrent(request),
        }),
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
        body: { ...outcome, workspacePhase: phase, outcomeSha256 },
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
            requestSha256: workspacePrepareRequestDigest(request),
            operationId: WORKSPACE_PREPARE_OPERATION,
            owner: request.owner,
            target: WORKSPACE_PREPARE_TARGET,
            phase,
            outcomeSha256,
          },
        },
      },
    );
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
    const requestDigest = workspacePrepareRequestDigest(request);
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

    const source = getSource(sources, directories, request);
    const sourceDigest =
      source === null ? null : workspaceEvidenceDigest(source);
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
      body: { sourceDigest },
      receivedAt: new Date().toISOString(),
      completedAt: null,
    };
    if (!existing) state.putReceipt(row, { kind: "new_work" });

    const execution = finish(row, request, source)
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
  });

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
        operationId: WORKSPACE_PREPARE_OPERATION,
        owner: {
          kind: "assignment",
          hostKey: row.hostKey,
          runId: row.runId,
          assignmentId: row.assignmentId,
          assignmentEpoch: row.epoch,
        },
        target: WORKSPACE_PREPARE_TARGET,
      };
      if (row.phase === "accepted")
        return reply.status(200).send({
          ...record,
          phase: "accepted",
          status: 202,
          acceptance: acceptance(row.commandId),
        });

      const { workspacePhase, ...outcome } = row.body as Record<
        string,
        unknown
      >;

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
