import type { Db } from "./db";
import type { ExecutionAssignment, ExecutionHost } from "@/lib/db/schema";
import type {
  CreateSessionResult,
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

import { ensureWorkspaceAdopted, isUnknownWorkspaceError } from "./adoption";
import {
  getActiveAssignment,
  getAssignmentById,
  getLatestAssignment,
  setAssignmentWorkspace,
} from "./assignments";
import { COMMAND_POLICY, deliverCommand, deliverPrompt } from "./deliverer";
import { issueCommand, type IssuedCommand } from "./ledger";
import { ensureAssignment } from "./placement";
import { hostForAssignment } from "./resolver";
import { commandSignals } from "./signals";
import { defaultTransport } from "./default-transport";
import { asExecutionWorkspaceId, asHostSessionId } from "./types";

import { persistRunSessionHostBinding } from "@/lib/runs/active-run-session";
import { nodeAttempts } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { getDb } from "@/lib/db/client";

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

export type ExecutionHosts = {
  readonly transport: ExecutionHostTransport;
  forAssignment(
    assignment: ExecutionAssignment | { id: string },
  ): Promise<BoundClient>;
  // The run's ACTIVE assignment; a pre-Stage-A run is assigned lazily (D9).
  // `teardown` binds the newest assignment even when it is `released` (X-EH-20:
  // teardown kinds stay admissible there) instead of minting a new epoch.
  forRun(
    runId: string,
    opts?: { reason?: PlacementReason; teardown?: boolean },
  ): Promise<BoundClient>;
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

    const client: BoundClient = {
      get assignment() {
        return current;
      },
      host,
      adoptWorkspace(spec) {
        return immediate<AdoptWorkspaceWire, AdoptWorkspaceResult>(
          "workspace.adopt",
          spec,
          (env) => transport.adoptWorkspace(env),
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
          (env) => transport.releaseWorkspace(executionWorkspaceId, env),
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
            (env) => transport.createSession(env),
            {
              onAck: async (tx, result) => {
                await persistRunSessionHostBinding(tx, {
                  runId: current.runId,
                  sessionName,
                  hostSessionId: result.sessionId,
                  acpSessionId: result.acpSessionId,
                  executionAssignmentId: current.id,
                });
                // The flow attempt that owns this session is stamped with the
                // driver generation here, not at append time: an attempt whose
                // host binding fails must still exist in the ledger as Failed.
                if (payload.nodeAttemptId) {
                  await tx
                    .update(nodeAttempts)
                    .set({ executionAssignmentId: current.id })
                    .where(eq(nodeAttempts.id, payload.nodeAttemptId));
                }
              },
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
          // X-EH-11: the host lost its handle store — re-adopt ONCE and issue
          // a NEW create; a second `unknown_workspace` surfaces as-is.
          if (!isUnknownWorkspaceError(err)) throw err;
          logger.warn(
            {
              runId: current.runId,
              assignmentId: current.id,
              assignmentEpoch: current.epoch,
              executionWorkspaceId: current.executionWorkspaceId,
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

        return deliverPrompt({
          db,
          command: row,
          envelope,
          send: (env) =>
            transport.sendPrompt(
              sessionId,
              env as CommandEnvelope<SendPromptInput>,
              { signal: opts?.signal },
            ),
          lookupReceipt: (id) => transport.getCommandReceipt(id),
          logger,
          sleep: deps.sleep,
          now: deps.now,
        });
      },
      deliverInput(sessionId, payload) {
        return immediate<InputPayload, InputDeliveryResult>(
          "session.input",
          payload,
          (env) => transport.deliverInput(sessionId, env),
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
              (env) => transport.deliverInput(sessionId, env),
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
          (env) => transport.cancelPrompt(sessionId, env),
          { targetSessionId: sessionId },
        );
      },
      checkpoint(sessionId) {
        return immediate<Record<string, never>, CheckpointResult>(
          "session.checkpoint",
          {},
          (env) => transport.checkpointSession(sessionId, env),
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
          (env) => transport.deleteSession(sessionId, env),
          { targetSessionId: sessionId },
        );
      },
    };

    return client;
  }

  const admin: HostAdminClient = {
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
      for await (const event of transport.streamSession(sessionId, opts)) {
        commandSignals.publish(event);
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

  return {
    transport,
    async forAssignment(assignmentOrId) {
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
    },
    async forRun(runId, opts) {
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
