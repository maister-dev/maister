import type { Db } from "./db";
import type { ExecutionAssignment, ExecutionHost } from "@/lib/db/schema";
import type {
  CreateSessionResult,
  PromptResult,
  SendPromptInput,
  SupervisorEvent,
  SupervisorDiagnosticsStatus,
  SupervisorMcpProbeRequest,
  SupervisorMcpProbeResult,
  SupervisorModelCatalog,
  SupervisorModelCatalogDraft,
  SupervisorSessionRecord,
} from "@/lib/supervisor-client";
import type { PlatformStatus } from "@/types/platform-status";
import type {
  AdoptWorkspaceResult,
  AdoptWorkspaceWire,
  CheckpointResult,
  CommandReceipt,
  CommandRetirementAck,
  CommandRetirementRequest,
  CreateSessionPayload,
  DeleteSessionOutcome,
  ExecutionHostTransport,
  HostHealth,
  InputDeliveryResult,
  ReserveRuntimeObjectPayload,
  RuntimeObjectMetadata,
  InputPayload,
  WorkspaceRecord,
} from "./contracts";
import type { SessionBindingDisposition } from "./session-binding";
import type { PromptOwnerRegistry } from "./prompt-owners";
import type { PromptHandle } from "./deliverer";
import type {
  CommandEnvelope,
  CommandKind,
  ExecutionWorkspaceId,
  HostSessionId,
  PlacementReason,
} from "./types";
import type { SessionCreateOwner } from "./create-intent";

import { and, eq } from "drizzle-orm";
import pino, { type Logger } from "pino";

import { canonicalCommandJson } from "../../../runtime/command-json";

import {
  ensureWorkspaceAdopted,
  isReadoptableWorkspaceError,
} from "./adoption";
import {
  getActiveAssignment,
  getAssignmentById,
  getLatestAssignment,
  setAssignmentWorkspace,
} from "./assignments";
import { applyCreateAck } from "./create-ack";
import { ensureSessionOutputIntents } from "./session-output-intents";
import {
  createOwnedSession,
  type OwnedSessionOptions,
} from "./owned-session-create";
import { requeueDelivering } from "./commands";
import {
  COMMAND_POLICY,
  deliverCommand,
  startAsyncPrompt,
  waitForPromptCompletion,
} from "./deliverer";
import {
  issueCommand,
  buildEnvelope,
  issueOwnedPrompt,
  type IssuedCommand,
  type PromptOwnerAdmission,
} from "./ledger";
import { ensureAssignment } from "./placement";
import { hostForAssignment } from "./resolver";
import { commandSignals } from "./signals";
import { defaultTransport } from "./default-transport";
import { streamCanonicalSessionEvents } from "./events/session-stream";
import { asExecutionWorkspaceId, asHostSessionId } from "./types";

import { MaisterError } from "@/lib/errors";
import { getDb } from "@/lib/db/client";
import {
  executionAssignments,
  executionCommands,
  executionRuntimeObjects,
  runs,
} from "@/lib/db/schema";

const defaultLog = pino({
  name: "execution-host",
  level: process.env.LOG_LEVEL ?? "info",
}).child({ component: "client" });

export type CreateSessionOptions = {
  // The run_sessions row the create ack binds (`host_session_id`,
  // `acp_session_id`, `execution_assignment_id`). Defaults to the payload's
  // `sessionName`, else "default" (M42 single-session runs).
  sessionName?: string;
};

// ADR-166 D5 ordering for `session.input`: the command row is queued inside the
// caller's own transaction (the HITL Phase-1 claim) and delivered after it
// commits; `onAck` runs in the ack transaction together with `succeeded`.
export type PreparedInput = {
  readonly commandId: string;
  readonly payload: InputPayload;
  deliver(opts?: {
    onAck?: (tx: Db, result: InputDeliveryResult) => Promise<void>;
  }): Promise<InputDeliveryResult>;
};

// ADR-166 D3/D4: every host-bound command of a run goes through the client
// bound to the run's ACTIVE assignment. Each method is a thin wrapper over
// ONE `issue → deliver` path; kind differences live in `COMMAND_POLICY`.
export interface BoundClient {
  readonly assignment: ExecutionAssignment;
  readonly host: ExecutionHost;
  adoptWorkspace(spec: AdoptWorkspaceWire): Promise<AdoptWorkspaceResult>;
  ensureWorkspace(opts?: { force?: boolean }): Promise<ExecutionWorkspaceId>;
  releaseWorkspace(
    executionWorkspaceId: ExecutionWorkspaceId | string,
  ): Promise<{ released: boolean }>;
  createSession(
    payload: Omit<CreateSessionPayload, "executionWorkspaceId">,
    opts?: CreateSessionOptions,
  ): Promise<CreateSessionResult & { hostSessionId: HostSessionId }>;
  createOwnedSession(
    owner: SessionCreateOwner,
    preparePayload: () => Promise<
      Omit<CreateSessionPayload, "executionWorkspaceId">
    >,
    options?: OwnedSessionOptions,
  ): Promise<
    CreateSessionResult & {
      hostSessionId: HostSessionId;
      sessionFallback: boolean;
    }
  >;
  // ADR-167 S2.12: every prompt carries a durable owner. There is no unowned
  // branch left — a continuation that cannot name its owner must refuse rather
  // than start a turn nothing can finish after a restart.
  prompt(
    sessionId: HostSessionId | string,
    input: SendPromptInput,
    opts: {
      admitOwner: (tx: Db) => Promise<PromptOwnerAdmission>;
      signal?: AbortSignal;
    },
  ): Promise<PromptHandle>;
  waitForPrompt(
    handle: PromptHandle,
    opts?: { signal?: AbortSignal; owners?: PromptOwnerRegistry },
  ): Promise<PromptResult>;
  deliverInput(
    sessionId: HostSessionId | string,
    payload: InputPayload,
  ): Promise<InputDeliveryResult>;
  prepareInput(
    tx: Db,
    sessionId: HostSessionId | string,
    payload: InputPayload,
  ): Promise<PreparedInput>;
  reattachPermissionInput(
    tx: Db,
    commandId: string,
    sessionId: string,
    payload: {
      kind: "permission";
      action: "select";
      requestId: string;
      optionId: string;
    },
  ): Promise<PreparedInput>;
  // The host's session records for THIS run (any status); callers pick the
  // live one for the node they act on.
  sessionsForRun(): Promise<SupervisorSessionRecord[]>;
  cancelPrompt(
    sessionId: HostSessionId | string,
  ): Promise<{ cancelled: boolean }>;
  checkpoint(sessionId: HostSessionId | string): Promise<CheckpointResult>;
  deleteSession(
    sessionId: HostSessionId | string,
  ): Promise<{ outcome: DeleteSessionOutcome }>;
  reserveRuntimeObject(
    payload: ReserveRuntimeObjectPayload,
  ): Promise<RuntimeObjectMetadata>;
  uploadRuntimeObject(input: {
    objectId: string;
    generation: number;
    bytes: Uint8Array;
    sha256: string;
  }): Promise<RuntimeObjectMetadata>;
  deleteRuntimeObject(input: {
    objectId: string;
    generation: number;
  }): Promise<void>;
}

// Host-scoped reads that carry no fence: health, the live session list, the
// per-session event stream (which feeds `commandSignals`), receipts, handles.
export interface HostAdminClient {
  health(opts?: { timeoutMs?: number }): Promise<HostHealth>;
  diagnostics(opts?: {
    timeoutMs?: number;
  }): Promise<SupervisorDiagnosticsStatus>;
  platformStatus(opts?: { timeoutMs?: number }): Promise<PlatformStatus>;
  resolveModelSuggestions(
    draft: SupervisorModelCatalogDraft,
    opts?: { force?: boolean },
  ): Promise<SupervisorModelCatalog>;
  probeMcp(req: SupervisorMcpProbeRequest): Promise<SupervisorMcpProbeResult>;
  listSessions(): Promise<SupervisorSessionRecord[]>;
  streamSession(
    sessionId: HostSessionId | string,
    opts?: { lastEventId?: number; signal?: AbortSignal },
  ): AsyncGenerator<SupervisorEvent, void, void>;
  getCommandReceipt(commandId: string): Promise<CommandReceipt | null>;
  // D6: the host's half of retirement. Host-scoped and fenceless by design —
  // the command's own epoch travels in the request as evidence, and the host
  // re-derives eligibility from its receipt rather than trusting the caller.
  retireCommand(
    commandId: string,
    request: CommandRetirementRequest,
  ): Promise<CommandRetirementAck>;
  getWorkspace(
    executionWorkspaceId: ExecutionWorkspaceId | string,
  ): Promise<WorkspaceRecord | null>;
}

// A driver's execution seam: the client bound to ITS assignment plus the
// host-scoped admin reads (the per-session event stream).
export type ExecutionBinding = {
  client: BoundClient;
  admin: HostAdminClient;
};

export type BindRunOptions = {
  // The assignment the caller's own claim minted (or the run's
  // `execution_assignment_id` read at driver entry). Binding by id makes the
  // fence structural: a driver never adopts a NEWER epoch minted behind its
  // back — the host fences it instead.
  assignmentId?: string | null;
  reason?: PlacementReason;
  // Binds the newest assignment even when it is `released` (X-EH-20: teardown
  // kinds stay admissible there) instead of minting a new epoch.
  teardown?: boolean;
};

export type ExecutionHosts = {
  readonly transport: ExecutionHostTransport;
  forAssignment(
    assignment: ExecutionAssignment | { id: string },
  ): Promise<BoundClient>;
  // The run's ACTIVE assignment; a never-placed (pre-ADR-166) run is assigned
  // lazily (D9), a placed run without an active assignment is refused.
  forRun(runId: string, opts?: BindRunOptions): Promise<BoundClient>;
  // `forAssignment` when the caller carries the assignment id, else `forRun`,
  // paired with the admin client — the ONE composition every driver binds.
  executionFor(runId: string, opts?: BindRunOptions): Promise<ExecutionBinding>;
  local(): HostAdminClient;
};

export type ExecutionHostsDeps = {
  db?: Db;
  owners?: PromptOwnerRegistry;
  transport?: ExecutionHostTransport;
  logger?: Logger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

export function createExecutionHosts(
  deps: ExecutionHostsDeps = {},
): ExecutionHosts {
  const transport = deps.transport ?? defaultTransport();
  const logger = deps.logger ?? defaultLog;
  const dbOf = () => deps.db ?? getDb();

  function bind(
    assignment: ExecutionAssignment,
    host: ExecutionHost,
  ): BoundClient {
    let current = assignment;
    const db = dbOf();

    type ImmediateOptions<TResult> = {
      targetSessionId?: string;
      onAck?: (
        tx: Db,
        result: TResult,
      ) => Promise<void | SessionBindingDisposition>;
      resultSummary?: (result: TResult) => Record<string, unknown> | null;
    };

    // S2.12: `session.prompt` is deliberately not issuable here — a prompt is
    // minted only by `issueOwnedPrompt`, which requires its owner.
    function issue<TPayload>(
      issueDb: Db,
      kind: Exclude<CommandKind, "session.prompt">,
      payload: TPayload,
      targetSessionId: string | null,
    ) {
      const policy = COMMAND_POLICY[kind];

      return issueCommand(issueDb, {
        assignment: current,
        host,
        kind,
        payload,
        maxAttempts: policy.maxAttempts,
        driverless: policy.driverless,
        targetSessionId,
        logger,
      });
    }

    function deliver<TPayload, TResult>(
      issued: IssuedCommand<TPayload>,
      send: (envelope: CommandEnvelope<TPayload>) => Promise<TResult>,
      opts: ImmediateOptions<TResult>,
    ): Promise<TResult> {
      return deliverCommand<TResult>({
        db,
        command: issued.row,
        envelope: issued.envelope,
        send: (env) => send(env as CommandEnvelope<TPayload>),
        onAck: opts.onAck,
        resultSummary: opts.resultSummary,
        logger,
        sleep: deps.sleep,
        now: deps.now,
      });
    }

    async function immediate<TPayload, TResult>(
      kind: Exclude<CommandKind, "session.prompt">,
      payload: TPayload,
      send: (envelope: CommandEnvelope<TPayload>) => Promise<TResult>,
      opts: ImmediateOptions<TResult> = {},
    ): Promise<TResult> {
      const issued = await issue(
        db,
        kind,
        payload,
        opts.targetSessionId ?? null,
      );

      return deliver(issued, send, opts);
    }

    // ADR-166 D5 transport timeouts come from the ONE per-kind policy table.
    const timeoutFor = (kind: CommandKind) => ({
      timeoutMs: COMMAND_POLICY[kind].timeoutMs,
    });

    const client: BoundClient = {
      get assignment() {
        return current;
      },
      host,
      adoptWorkspace(spec) {
        return immediate<AdoptWorkspaceWire, AdoptWorkspaceResult>(
          "workspace.adopt",
          spec,
          (env) => transport.adoptWorkspace(env, timeoutFor("workspace.adopt")),
          {
            onAck: async (tx, result) => {
              await setAssignmentWorkspace(
                tx,
                current.id,
                result.executionWorkspaceId,
                deps.now?.() ?? new Date(),
              );
              current = {
                ...current,
                executionWorkspaceId: result.executionWorkspaceId,
                workspaceAdoptedAt: deps.now?.() ?? new Date(),
              };
            },
          },
        );
      },
      ensureWorkspace(opts) {
        return ensureWorkspaceAdopted({
          db,
          client,
          force: opts?.force,
          logger,
        });
      },
      releaseWorkspace(executionWorkspaceId) {
        return immediate<Record<string, never>, { released: boolean }>(
          "workspace.release",
          {},
          (env) =>
            transport.releaseWorkspace(
              executionWorkspaceId,
              env,
              timeoutFor("workspace.release"),
            ),
          { targetSessionId: executionWorkspaceId },
        );
      },
      async createSession(payload, opts) {
        const sessionName =
          opts?.sessionName ?? payload.sessionName ?? "default";
        const attempt = async (executionWorkspaceId: ExecutionWorkspaceId) => {
          await ensureSessionOutputIntents(db, client, payload);

          return immediate<CreateSessionPayload, CreateSessionResult>(
            "session.create",
            { ...payload, sessionName, executionWorkspaceId },
            (env) => transport.createSession(env, timeoutFor("session.create")),
            {
              onAck: (tx, result) =>
                applyCreateAck(tx, {
                  runId: current.runId,
                  sessionName,
                  assignmentId: current.id,
                  nodeAttemptId: payload.nodeAttemptId ?? null,
                  result,
                }),
              resultSummary: (result) => ({
                sessionId: result.sessionId,
                acpSessionId: result.acpSessionId,
                pid: result.pid,
              }),
            },
          );
        };
        const withHostSessionId = (result: CreateSessionResult) => ({
          ...result,
          hostSessionId: asHostSessionId(result.sessionId),
        });

        try {
          return withHostSessionId(
            await attempt(await client.ensureWorkspace()),
          );
        } catch (err) {
          // X-EH-11/X-EH-12: the host refused the stored handle (store wiped,
          // or the handle released and the path re-created) — re-adopt ONCE
          // and issue a NEW create; a second refusal surfaces as-is.
          if (!isReadoptableWorkspaceError(err)) throw err;
          logger.warn(
            {
              runId: current.runId,
              assignmentId: current.id,
              assignmentEpoch: current.epoch,
              executionWorkspaceId: current.executionWorkspaceId,
              reason: (err as MaisterError).details?.reason,
            },
            "workspace-readopting",
          );

          return withHostSessionId(
            await attempt(await client.ensureWorkspace({ force: true })),
          );
        }
      },
      createOwnedSession(owner, preparePayload, options) {
        return createOwnedSession({
          db,
          client,
          transport,
          owner,
          preparePayload,
          options,
          logger,
        });
      },
      async prompt(sessionId, input, opts) {
        const policy = COMMAND_POLICY["session.prompt"];
        const commandInput = {
          assignment: current,
          host,
          payload: input,
          maxAttempts: policy.maxAttempts,
          targetSessionId: sessionId,
          logger,
        };
        const { row, envelope } = await issueOwnedPrompt(db, {
          ...commandInput,
          admitOwner: opts.admitOwner,
        });

        return startAsyncPrompt({
          db,
          command: row,
          envelope,
          start: (env) =>
            transport.startPrompt(
              sessionId,
              env as CommandEnvelope<SendPromptInput>,
              timeoutFor("session.prompt"),
            ),
          lookupReceipt: (id) => transport.getCommandReceipt(id),
          logger,
          sleep: deps.sleep,
          now: deps.now,
        });
      },
      async waitForPrompt(handle, opts) {
        const result = await waitForPromptCompletion({
          db,
          handle,
          owners: opts?.owners ?? deps.owners,
          signal: opts?.signal,
          assignmentIsCurrent: async () => {
            const rows = await db
              .select({ id: executionAssignments.id })
              .from(executionAssignments)
              .where(
                and(
                  eq(executionAssignments.id, current.id),
                  eq(executionAssignments.runId, current.runId),
                  eq(executionAssignments.executionHostId, host.id),
                  eq(executionAssignments.epoch, current.epoch),
                  eq(executionAssignments.state, "active"),
                ),
              )
              .limit(1);

            return Boolean(rows[0]);
          },
          lookupReceipt: (commandId) => transport.getCommandReceipt(commandId),
          logger,
        });

        if (result.runtimeObjects?.length) {
          await db.transaction(async (tx) => {
            for (const metadata of result.runtimeObjects ?? []) {
              if (
                metadata.state !== "available" ||
                !Number.isSafeInteger(metadata.sizeBytes) ||
                metadata.sizeBytes === null ||
                metadata.sizeBytes < 0 ||
                typeof metadata.sha256 !== "string" ||
                !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
                !metadata.sealedAt
              ) {
                throw new MaisterError(
                  "ACP_PROTOCOL",
                  "prompt receipt contains invalid runtime output metadata",
                );
              }
              const rows = await tx
                .select()
                .from(executionRuntimeObjects)
                .where(eq(executionRuntimeObjects.id, metadata.objectId))
                .for("update")
                .limit(1);
              const object = rows[0];

              if (
                !object ||
                object.runId !== current.runId ||
                object.executionHostId !== host.id ||
                object.executionAssignmentId !== current.id ||
                object.assignmentEpoch !== current.epoch ||
                object.kind !== metadata.kind ||
                object.logicalName !== metadata.logicalName ||
                object.mimeType !== metadata.mimeType ||
                object.generation !== metadata.generation ||
                object.retentionClass !== metadata.retentionClass
              ) {
                throw new MaisterError(
                  "CONFLICT",
                  "prompt runtime output conflicts with its manager allocation",
                  { details: { reason: "command_invariant_conflict" } },
                );
              }
              await tx
                .update(executionRuntimeObjects)
                .set({
                  state: "available",
                  sizeBytes: BigInt(metadata.sizeBytes),
                  sha256: metadata.sha256,
                  sealedAt: new Date(metadata.sealedAt),
                  lastError: null,
                })
                .where(eq(executionRuntimeObjects.id, metadata.objectId));
            }
          });
        }

        return result;
      },
      deliverInput(sessionId, payload) {
        return immediate<InputPayload, InputDeliveryResult>(
          "session.input",
          payload,
          (env) =>
            transport.deliverInput(sessionId, env, timeoutFor("session.input")),
          { targetSessionId: sessionId },
        );
      },
      async prepareInput(tx, sessionId, payload) {
        const issued = await issue(tx, "session.input", payload, sessionId);

        return {
          commandId: issued.row.id,
          payload,
          deliver: (opts) =>
            deliver<InputPayload, InputDeliveryResult>(
              issued,
              (env) =>
                transport.deliverInput(
                  sessionId,
                  env,
                  timeoutFor("session.input"),
                ),
              { targetSessionId: sessionId, onAck: opts?.onAck },
            ),
        };
      },
      async reattachPermissionInput(tx, commandId, sessionId, payload) {
        const [original] = await tx
          .select()
          .from(executionCommands)
          .where(eq(executionCommands.id, commandId))
          .for("update");

        if (
          !original ||
          original.kind !== "session.input" ||
          original.runId !== current.runId ||
          original.executionAssignmentId !== current.id ||
          original.assignmentEpoch !== current.epoch ||
          original.executionHostId !== host.id ||
          original.targetSessionId !== sessionId ||
          canonicalCommandJson(original.payload) !==
            canonicalCommandJson(payload)
        )
          throw new MaisterError(
            "CONFLICT",
            "permission replay does not match its stored delivery",
            { details: { reason: "permission_delivery_identity", commandId } },
          );
        if (original.state === "succeeded") {
          if (original.result?.ok !== true)
            throw new MaisterError(
              "CONFLICT",
              "permission receipt has no successful delivery result",
            );

          return {
            commandId,
            payload,
            deliver: async (opts) => {
              const result: InputDeliveryResult = { ok: true, replayed: true };

              await db.transaction(async (ackTx) => {
                await opts?.onAck?.(ackTx, result);
              });

              return result;
            },
          };
        }
        if (original.state !== "queued" && original.state !== "delivering")
          throw new MaisterError(
            "CONFLICT",
            "permission delivery requires an explicit retry decision",
            {
              details: {
                reason: "permission_delivery_terminal",
                commandId,
                state: original.state,
              },
            },
          );
        // A permission selection carries its complete persisted request. The
        // host deduplicates the same ID even if the lost delivery did arrive.
        const row =
          original.state === "delivering"
            ? (await requeueDelivering(tx, commandId, { logger })).row
            : original;

        if (!row)
          throw new MaisterError(
            "CONFLICT",
            "permission delivery disappeared during reattachment",
          );
        const issued: IssuedCommand<InputPayload> = {
          row,
          envelope: buildEnvelope({
            commandId,
            kind: "session.input",
            hostKey: host.hostKey,
            assignmentId: current.id,
            assignmentEpoch: current.epoch,
            runId: current.runId,
            payload,
            issuedAt: original.createdAt,
          }),
        };

        return {
          commandId,
          payload,
          deliver: (opts) =>
            deliver<InputPayload, InputDeliveryResult>(
              issued,
              (env) =>
                transport.deliverInput(
                  sessionId,
                  env,
                  timeoutFor("session.input"),
                ),
              { targetSessionId: sessionId, onAck: opts?.onAck },
            ),
        };
      },
      async sessionsForRun() {
        const runId = current.runId;

        return (await transport.listSessions()).filter(
          (record) => record.runId === runId,
        );
      },
      cancelPrompt(sessionId) {
        return immediate<Record<string, never>, { cancelled: boolean }>(
          "session.cancel",
          {},
          (env) =>
            transport.cancelPrompt(
              sessionId,
              env,
              timeoutFor("session.cancel"),
            ),
          { targetSessionId: sessionId },
        );
      },
      checkpoint(sessionId) {
        return immediate<Record<string, never>, CheckpointResult>(
          "session.checkpoint",
          {},
          (env) =>
            transport.checkpointSession(
              sessionId,
              env,
              timeoutFor("session.checkpoint"),
            ),
          { targetSessionId: sessionId },
        );
      },
      deleteSession(sessionId) {
        return immediate<
          Record<string, never>,
          { outcome: DeleteSessionOutcome }
        >(
          "session.delete",
          {},
          (env) =>
            transport.deleteSession(
              sessionId,
              env,
              timeoutFor("session.delete"),
            ),
          { targetSessionId: sessionId },
        );
      },
      async reserveRuntimeObject(payload) {
        const expiresAt = payload.expiresAt
          ? new Date(payload.expiresAt)
          : null;
        const issued = await db.transaction(async (tx) => {
          const rows = await tx
            .select()
            .from(executionRuntimeObjects)
            .where(
              and(
                eq(executionRuntimeObjects.id, payload.objectId),
                eq(executionRuntimeObjects.runId, current.runId),
              ),
            )
            .for("update")
            .limit(1);
          const existing = rows[0];

          if (existing) {
            const sameIntent =
              existing.executionHostId === host.id &&
              existing.executionAssignmentId === current.id &&
              existing.assignmentEpoch === current.epoch &&
              existing.kind === payload.kind &&
              existing.logicalName === payload.logicalName &&
              existing.mimeType === payload.mimeType &&
              existing.generation === payload.generation &&
              existing.retentionClass === payload.retentionClass &&
              existing.expiresAt?.getTime() === expiresAt?.getTime() &&
              (existing.state === "pending" ||
                (existing.state === "available" &&
                  existing.sizeBytes === BigInt(payload.sizeBytes) &&
                  existing.sha256 === payload.sha256));

            if (!sameIntent) {
              throw new MaisterError(
                "CONFLICT",
                "runtime object ID is already bound to different metadata",
                { details: { reason: "command_invariant_conflict" } },
              );
            }
          } else {
            await tx.insert(executionRuntimeObjects).values({
              id: payload.objectId,
              runId: current.runId,
              executionHostId: host.id,
              executionAssignmentId: current.id,
              assignmentEpoch: current.epoch,
              kind: payload.kind,
              logicalName: payload.logicalName,
              mimeType: payload.mimeType,
              sizeBytes: null,
              sha256: null,
              generation: payload.generation,
              retentionClass: payload.retentionClass,
              state: "pending",
              expiresAt,
            });
          }

          return issue(tx, "runtime_object.reserve", payload, payload.objectId);
        });

        return deliver(
          issued,
          (env) =>
            transport.reserveRuntimeObject(
              env as CommandEnvelope<ReserveRuntimeObjectPayload>,
              timeoutFor("runtime_object.reserve"),
            ),
          { targetSessionId: payload.objectId },
        );
      },
      async uploadRuntimeObject(input) {
        const payload = {
          objectId: input.objectId,
          generation: input.generation,
          sizeBytes: input.bytes.byteLength,
          sha256: input.sha256,
        };
        const issued = await issue(
          db,
          "runtime_object.upload",
          payload,
          input.objectId,
        );

        return deliver(
          issued,
          (env) =>
            transport.uploadRuntimeObject({
              objectId: input.objectId,
              envelope: {
                command: env.command,
                fence: env.fence,
                payload: {
                  generation: input.generation,
                  sizeBytes: input.bytes.byteLength,
                  sha256: input.sha256,
                },
              },
              bytes: input.bytes,
            }),
          {
            targetSessionId: input.objectId,
            onAck: async (tx, metadata) => {
              const updated = await tx
                .update(executionRuntimeObjects)
                .set({
                  sizeBytes: BigInt(
                    metadata.sizeBytes ?? input.bytes.byteLength,
                  ),
                  sha256: metadata.sha256 ?? input.sha256,
                  state: "available",
                  sealedAt: metadata.sealedAt
                    ? new Date(metadata.sealedAt)
                    : (deps.now?.() ?? new Date()),
                  lastError: null,
                })
                .where(
                  and(
                    eq(executionRuntimeObjects.id, input.objectId),
                    eq(executionRuntimeObjects.runId, current.runId),
                    eq(
                      executionRuntimeObjects.executionAssignmentId,
                      current.id,
                    ),
                    eq(executionRuntimeObjects.assignmentEpoch, current.epoch),
                  ),
                )
                .returning({ id: executionRuntimeObjects.id });

              if (!updated[0]) {
                throw new MaisterError(
                  "CONFLICT",
                  "runtime object upload acknowledgement no longer matches its catalogue binding",
                  { details: { reason: "command_invariant_conflict" } },
                );
              }
            },
          },
        );
      },
      async deleteRuntimeObject(input) {
        const issued = await db.transaction(async (tx) => {
          const rows = await tx
            .select()
            .from(executionRuntimeObjects)
            .where(eq(executionRuntimeObjects.id, input.objectId))
            .for("update")
            .limit(1);
          const object = rows[0];

          if (
            !object ||
            object.runId !== current.runId ||
            object.executionHostId !== host.id ||
            object.executionAssignmentId !== current.id ||
            object.assignmentEpoch !== current.epoch ||
            object.generation !== input.generation
          ) {
            throw new MaisterError(
              "CONFLICT",
              "runtime object deletion does not match its immutable assignment binding",
              { details: { reason: "assignment_fenced" } },
            );
          }
          if (
            object.state !== "available" &&
            object.state !== "deleting" &&
            object.state !== "deleted"
          ) {
            throw new MaisterError(
              "PRECONDITION",
              `runtime object ${input.objectId} cannot be deleted from state ${object.state}`,
              { details: { reason: "runtime_object_missing" } },
            );
          }
          if (object.state !== "deleted") {
            await tx
              .update(executionRuntimeObjects)
              .set({ state: "deleting", lastError: null })
              .where(eq(executionRuntimeObjects.id, input.objectId));
          }

          return issue(
            tx,
            "runtime_object.delete",
            { generation: input.generation },
            input.objectId,
          );
        });

        return deliver(
          issued,
          (env) =>
            transport.deleteRuntimeObject(
              input.objectId,
              env as CommandEnvelope<{ generation: number }>,
              timeoutFor("runtime_object.delete"),
            ),
          {
            targetSessionId: input.objectId,
            onAck: async (tx) => {
              await tx
                .update(executionRuntimeObjects)
                .set({
                  state: "deleted",
                  deletedAt: deps.now?.() ?? new Date(),
                  lastError: null,
                })
                .where(
                  and(
                    eq(executionRuntimeObjects.id, input.objectId),
                    eq(executionRuntimeObjects.runId, current.runId),
                    eq(
                      executionRuntimeObjects.executionAssignmentId,
                      current.id,
                    ),
                    eq(executionRuntimeObjects.assignmentEpoch, current.epoch),
                  ),
                );
            },
          },
        );
      },
    };

    return client;
  }

  function adminForRun(runId?: string): HostAdminClient {
    return {
      health(opts) {
        return transport.health(opts);
      },
      diagnostics(opts) {
        return transport.diagnostics(opts);
      },
      platformStatus(opts) {
        return transport.platformStatus(opts);
      },
      resolveModelSuggestions(draft, opts) {
        return transport.resolveModelSuggestions(draft, opts);
      },
      probeMcp(req) {
        return transport.probeMcp(req);
      },
      listSessions() {
        return transport.listSessions();
      },
      async *streamSession(sessionId, opts) {
        if (runId) {
          const modeRows = await dbOf()
            .select({ executionDataPlaneMode: runs.executionDataPlaneMode })
            .from(runs)
            .where(eq(runs.id, runId))
            .limit(1);

          if (!modeRows[0]) {
            throw new MaisterError(
              "PRECONDITION",
              `run ${runId} is missing while streaming an execution session`,
              { details: { reason: "run_missing", runId } },
            );
          }
          yield* streamCanonicalSessionEvents({
            db: dbOf(),
            runId,
            hostSessionId: sessionId,
            lastEventId: opts?.lastEventId,
            signal: opts?.signal,
          });

          return;
        }
        for await (const event of transport.streamSession(sessionId, opts)) {
          commandSignals.publishLegacy(event);
          yield event;
        }
      },
      getCommandReceipt(commandId) {
        return transport.getCommandReceipt(commandId);
      },
      retireCommand(commandId, request) {
        return transport.retireCommand(commandId, request);
      },
      getWorkspace(executionWorkspaceId) {
        return transport.getWorkspace(executionWorkspaceId);
      },
    };
  }

  const admin = adminForRun();

  async function forAssignment(
    assignmentOrId: ExecutionAssignment | { id: string },
  ): Promise<BoundClient> {
    const db = dbOf();
    const assignment =
      "runId" in assignmentOrId
        ? assignmentOrId
        : await getAssignmentById(db, assignmentOrId.id);

    if (!assignment) {
      throw new MaisterError(
        "PRECONDITION",
        `execution assignment ${assignmentOrId.id} not found`,
        {
          details: {
            reason: "assignment_missing",
            assignmentId: assignmentOrId.id,
          },
        },
      );
    }

    return bind(
      assignment,
      await hostForAssignment(db, assignment, { logger, transport }),
    );
  }

  async function forRun(
    runId: string,
    opts?: BindRunOptions,
  ): Promise<BoundClient> {
    const db = dbOf();
    const assignment =
      (await getActiveAssignment(db, runId)) ??
      (opts?.teardown ? await getLatestAssignment(db, runId) : null) ??
      (await ensureAssignment(db, runId, opts?.reason ?? "legacy_backfill", {
        logger,
        transport,
      }));

    return bind(
      assignment,
      await hostForAssignment(db, assignment, { logger, transport }),
    );
  }

  return {
    transport,
    forAssignment,
    forRun,
    async executionFor(runId, opts) {
      const client = opts?.assignmentId
        ? await forAssignment({ id: opts.assignmentId })
        : await forRun(runId, opts);

      return { client, admin: adminForRun(runId) };
    },
    local() {
      return admin;
    },
  };
}

declare global {
  var __maisterExecutionHosts: ExecutionHosts | undefined;
}

// HMR-safe process singleton over the local-direct transport.
export const executionHosts: ExecutionHosts =
  globalThis.__maisterExecutionHosts ?? createExecutionHosts();

globalThis.__maisterExecutionHosts = executionHosts;

export { asExecutionWorkspaceId };
