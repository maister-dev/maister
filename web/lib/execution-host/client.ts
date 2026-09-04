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
import type { PromptHandle } from "./deliverer";
import type {
  CommandEnvelope,
  CommandKind,
  ExecutionWorkspaceId,
  HostSessionId,
  PlacementReason,
} from "./types";

import { eq } from "drizzle-orm";
import pino, { type Logger } from "pino";

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
import {
  COMMAND_POLICY,
  deliverCommand,
  deliverPrompt,
  startAsyncPrompt,
  waitForPromptCompletion,
} from "./deliverer";
import { issueCommand, type IssuedCommand } from "./ledger";
import { ensureAssignment } from "./placement";
import { hostForAssignment } from "./resolver";
import { commandSignals } from "./signals";
import { defaultTransport } from "./default-transport";
import { streamCanonicalSessionEvents } from "./events/session-stream";
import { asExecutionWorkspaceId, asHostSessionId } from "./types";

import { MaisterError } from "@/lib/errors";
import { getDb } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";

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
  prompt(
    sessionId: HostSessionId | string,
    input: SendPromptInput,
    opts?: { signal?: AbortSignal },
  ): Promise<PromptHandle>;
  waitForPrompt(
    handle: PromptHandle,
    opts?: { signal?: AbortSignal },
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

    async function dataPlaneModeForCurrentRun(): Promise<
      "legacy_file_v1" | "canonical_events_v1"
    > {
      const rows = await db
        .select({ executionDataPlaneMode: runs.executionDataPlaneMode })
        .from(runs)
        .where(eq(runs.id, current.runId))
        .limit(1);
      const run = rows[0];
      if (!run) {
        throw new MaisterError(
          "PRECONDITION",
          `run ${current.runId} is missing while issuing an execution command`,
          { details: { reason: "run_missing", runId: current.runId } },
        );
      }

      return run.executionDataPlaneMode;
    }

    type ImmediateOptions<TResult> = {
      targetSessionId?: string;
      onAck?: (tx: Db, result: TResult) => Promise<void>;
      resultSummary?: (result: TResult) => Record<string, unknown> | null;
    };

    function issue<TPayload>(
      issueDb: Db,
      kind: CommandKind,
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
      kind: CommandKind,
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
        const attempt = (executionWorkspaceId: ExecutionWorkspaceId) =>
          immediate<CreateSessionPayload, CreateSessionResult>(
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
      async prompt(sessionId, input, opts) {
        const policy = COMMAND_POLICY["session.prompt"];
        const { row, envelope } = await issueCommand(db, {
          assignment: current,
          host,
          kind: "session.prompt",
          payload: input,
          maxAttempts: policy.maxAttempts,
          driverless: policy.driverless,
          targetSessionId: sessionId,
          logger,
        });

        if ((await dataPlaneModeForCurrentRun()) === "canonical_events_v1") {
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
        }

        return deliverPrompt({
          db,
          command: row,
          envelope,
          send: (env) =>
            transport.sendPrompt(
              sessionId,
              env as CommandEnvelope<SendPromptInput>,
              { signal: opts?.signal, ...timeoutFor("session.prompt") },
            ),
          lookupReceipt: (id) => transport.getCommandReceipt(id),
          logger,
          sleep: deps.sleep,
          now: deps.now,
        });
      },
      waitForPrompt(handle, opts) {
        return waitForPromptCompletion({ db, handle, signal: opts?.signal });
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
      reserveRuntimeObject(payload) {
        return immediate<ReserveRuntimeObjectPayload, RuntimeObjectMetadata>(
          "runtime_object.reserve",
          payload,
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
          { targetSessionId: input.objectId },
        );
      },
      async deleteRuntimeObject(input) {
        return immediate<{ generation: number }, void>(
          "runtime_object.delete",
          { generation: input.generation },
          (env) =>
            transport.deleteRuntimeObject(
              input.objectId,
              env as CommandEnvelope<{ generation: number }>,
              timeoutFor("runtime_object.delete"),
            ),
          { targetSessionId: input.objectId },
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
          if (modeRows[0]?.executionDataPlaneMode === "canonical_events_v1") {
            yield* streamCanonicalSessionEvents({
              db: dbOf(),
              runId,
              hostSessionId: sessionId,
              lastEventId: opts?.lastEventId,
              signal: opts?.signal,
            });
            return;
          }
        }
        for await (const event of transport.streamSession(sessionId, opts)) {
          commandSignals.publishLegacy(event);
          yield event;
        }
      },
      getCommandReceipt(commandId) {
        return transport.getCommandReceipt(commandId);
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
