import type { Db } from "@/lib/execution-host/db";
import type { ExecutionAssignment } from "@/lib/db/schema";
import type {
  AdoptWorkspaceResult,
  AdoptWorkspaceWire,
  CheckpointResult,
  CommandReceipt,
  CreateSessionPayload,
  DeleteSessionOutcome,
  ExecutionHostTransport,
  HostHealth,
  WorkspaceRecord,
} from "@/lib/execution-host/contracts";
import type { CommandEnvelope, CommandKind } from "@/lib/execution-host/types";
import type {
  CreateSessionResult,
  PromptResult,
  SendPromptInput,
  SupervisorEvent,
  SupervisorSessionRecord,
} from "@/lib/supervisor-client";

import { randomUUID } from "node:crypto";

import { MaisterError } from "@/lib/errors";
import {
  createExecutionHosts,
  type BoundClient,
  type ExecutionHosts,
} from "@/lib/execution-host/client";
import { UNKNOWN_OUTCOME_DETAIL } from "@/lib/execution-host/contracts";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { commandSignals } from "@/lib/execution-host/signals";
import { asExecutionWorkspaceId } from "@/lib/execution-host/types";

// ADR-164 T3.1: an in-memory `ExecutionHostTransport` with the host's
// observable semantics (fence high-water, receipts + replay, handles, sessions)
// and programmable faults, for ledger/deliverer/driver tests that must not
// spawn a supervisor. Errors are shaped exactly as the local-direct wire maps
// them, so callers cannot tell the difference.

export type TransportMethod = keyof ExecutionHostTransport;

export type FakeCall = {
  method: TransportMethod;
  envelope: CommandEnvelope<unknown> | null;
  args: unknown[];
  at: number;
};

export type FakeSession = {
  sessionId: string;
  runId: string;
  acpSessionId: string;
  executionWorkspaceId: string;
  assignmentEpoch: number;
  createdByCommandId: string;
  status: "live" | "exited";
};

export type PromptContext = {
  sessionId: string;
  envelope: CommandEnvelope<SendPromptInput>;
  // Move the receipt through its phases from inside a scripted turn.
  setReceipt(
    phase: CommandReceipt["phase"],
    body: Record<string, unknown>,
    inflight?: boolean,
  ): void;
  // Publish a `session.command` event as an SSE consumer would.
  emit(
    phase: "accepted" | "completed",
    extra?: Partial<Extract<SupervisorEvent, { type: "session.command" }>>,
  ): void;
};

export type FakeExecutionHost = {
  transport: ExecutionHostTransport;
  identity: { hostKey: string; bootId: string; protocolVersion: 1 };
  calls: FakeCall[];
  callsOf(method: TransportMethod): FakeCall[];
  sessions: Map<string, FakeSession>;
  workspaces: Map<string, WorkspaceRecord & { path: string }>;
  receipts: Map<string, CommandReceipt>;
  fences: Map<string, number>;
  failOnce(method: TransportMethod, error: unknown): void;
  onCall(
    method: TransportMethod,
    hook: (call: FakeCall) => void | Promise<void>,
  ): void;
  setHealth(health: HostHealth | null): void;
  setPromptBehavior(
    behavior: (ctx: PromptContext) => Promise<PromptResult>,
  ): void;
  restart(): void;
  monotonic(): number;
};

export function unknownOutcomeError(message = "ECONNREFUSED"): MaisterError {
  return new MaisterError("EXECUTOR_UNAVAILABLE", `fake: ${message}`, {
    details: { transport: UNKNOWN_OUTCOME_DETAIL, reason: "network" },
  });
}

export function definitiveUnavailableError(
  message = "supervisor 503",
): MaisterError {
  return new MaisterError("EXECUTOR_UNAVAILABLE", `fake: ${message}`, {
    details: { httpStatus: 503 },
  });
}

export function fencedError(runId: string, commandEpoch: number): MaisterError {
  return new MaisterError("CONFLICT", "fake: assignment fenced", {
    details: {
      reason: "assignment_fenced",
      runId,
      commandEpoch,
      httpStatus: 409,
    },
  });
}

export function unknownWorkspaceError(): MaisterError {
  return new MaisterError("PRECONDITION", "fake: unknown execution workspace", {
    details: { reason: "unknown_workspace", httpStatus: 409 },
  });
}

export function createFakeExecutionHost(
  opts: { hostKey?: string; bootId?: string } = {},
): FakeExecutionHost {
  const identity = {
    hostKey: opts.hostKey ?? `eh_${randomUUID().replace(/-/g, "")}`,
    bootId: opts.bootId ?? randomUUID(),
    protocolVersion: 1 as const,
  };
  const calls: FakeCall[] = [];
  const sessions = new Map<string, FakeSession>();
  const workspaces = new Map<string, WorkspaceRecord & { path: string }>();
  const receipts = new Map<string, CommandReceipt>();
  const fences = new Map<string, number>();
  const faults = new Map<TransportMethod, unknown[]>();
  const hooks = new Map<
    TransportMethod,
    Array<(call: FakeCall) => void | Promise<void>>
  >();
  let health: HostHealth | null = null;
  let monotonicId = 0;
  let promptBehavior: (
    ctx: PromptContext,
  ) => Promise<PromptResult> = async () => ({
    stopReason: "end_turn",
    meta: null,
  });

  const record = async (
    method: TransportMethod,
    envelope: CommandEnvelope<unknown> | null,
    args: unknown[],
  ) => {
    const call: FakeCall = { method, envelope, args, at: Date.now() };

    calls.push(call);
    for (const hook of hooks.get(method) ?? []) await hook(call);
    const queue = faults.get(method);

    if (queue && queue.length > 0) throw queue.shift();
  };

  const fence = (envelope: CommandEnvelope<unknown>) => {
    const runId = envelope.fence.runId;
    const high = fences.get(runId) ?? 0;

    if (envelope.fence.assignmentEpoch < high) {
      throw fencedError(runId, envelope.fence.assignmentEpoch);
    }
    if (envelope.fence.assignmentEpoch > high) {
      fences.set(runId, envelope.fence.assignmentEpoch);
      for (const session of sessions.values()) {
        if (
          session.runId === runId &&
          session.assignmentEpoch < envelope.fence.assignmentEpoch
        ) {
          session.status = "exited";
        }
      }
    }
  };

  const receipt = (
    envelope: CommandEnvelope<unknown>,
    phase: CommandReceipt["phase"],
    httpStatus: number,
    body: Record<string, unknown>,
    inflight = false,
  ) => {
    const now = new Date().toISOString();
    const existing = receipts.get(envelope.command.id);

    receipts.set(envelope.command.id, {
      commandId: envelope.command.id,
      runId: envelope.fence.runId,
      kind: envelope.command.kind as CommandKind,
      assignmentEpoch: envelope.fence.assignmentEpoch,
      phase,
      httpStatus,
      body,
      receivedAt: existing?.receivedAt ?? now,
      completedAt: phase === "accepted" ? null : now,
      inflight,
    });
  };

  const replay = <T>(envelope: CommandEnvelope<unknown>): T | null => {
    const existing = receipts.get(envelope.command.id);

    if (existing && existing.phase !== "accepted") {
      return { ...existing.body, replayed: true } as T;
    }

    return null;
  };

  const liveSession = (sessionId: string) => {
    const session = sessions.get(sessionId);

    if (!session || session.status !== "live") {
      throw new MaisterError(
        "PRECONDITION",
        `fake: unknown session ${sessionId}`,
        {
          details: { httpStatus: 404 },
        },
      );
    }

    return session;
  };

  const transport: ExecutionHostTransport = {
    async health() {
      await record("health", null, []);

      return (
        health ?? {
          kind: "ready",
          identity,
          version: "fake",
          sessions: {
            live: [...sessions.values()].filter((s) => s.status === "live")
              .length,
            exited: [...sessions.values()].filter((s) => s.status === "exited")
              .length,
            crashed: 0,
          },
        }
      );
    },
    async listSessions(): Promise<SupervisorSessionRecord[]> {
      await record("listSessions", null, []);

      return [...sessions.values()].map((s) => ({
        sessionId: s.sessionId,
        runId: s.runId,
        projectSlug: "fake",
        stepId: "fake",
        status: s.status,
        pid: 4242,
        startedAt: new Date(0).toISOString(),
        logPath: "/dev/null",
        monotonicId,
        acpSessionId: s.acpSessionId,
      })) as unknown as SupervisorSessionRecord[];
    },
    async *streamSession() {
      await record("streamSession", null, []);
    },
    async getCommandReceipt(commandId) {
      await record("getCommandReceipt", null, [commandId]);

      return receipts.get(commandId) ?? null;
    },
    async getWorkspace(id) {
      await record("getWorkspace", null, [id]);
      const ws = workspaces.get(id);

      return ws ? { ...ws } : null;
    },
    async adoptWorkspace(envelope) {
      await record("adoptWorkspace", envelope, []);
      fence(envelope);
      const replayed = replay<AdoptWorkspaceResult>(envelope);

      if (replayed) return replayed;
      const existing = [...workspaces.values()].find(
        (w) =>
          w.runId === envelope.payload.runId &&
          w.path === envelope.payload.path &&
          !w.releasedAt,
      );
      const id =
        existing?.executionWorkspaceId ??
        asExecutionWorkspaceId(`ws_${randomUUID().replace(/-/g, "")}`);

      if (!existing) {
        workspaces.set(id, {
          executionWorkspaceId: id,
          runId: envelope.payload.runId,
          projectSlug: envelope.payload.projectSlug,
          kind: envelope.payload.kind,
          adoptedAt: new Date().toISOString(),
          releasedAt: null,
          path: envelope.payload.path,
        });
      }
      const body = {
        executionWorkspaceId: id,
        kind: envelope.payload.kind,
        replayed: Boolean(existing),
      };

      receipt(envelope, "completed", 200, body);

      return body;
    },
    async releaseWorkspace(id, envelope) {
      await record("releaseWorkspace", envelope, [id]);
      fence(envelope);
      const ws = workspaces.get(id);
      const released = Boolean(ws && !ws.releasedAt);

      if (ws) ws.releasedAt = new Date().toISOString();
      receipt(envelope, "completed", 200, { released });

      return { released };
    },
    async createSession(envelope: CommandEnvelope<CreateSessionPayload>) {
      await record("createSession", envelope, []);
      fence(envelope);
      const replayed = replay<CreateSessionResult>(envelope);

      if (replayed) return replayed;
      const ws = workspaces.get(envelope.payload.executionWorkspaceId);

      if (!ws || ws.releasedAt) {
        receipt(envelope, "rejected", 409, {
          code: "PRECONDITION",
          details: { reason: "unknown_workspace" },
        });
        throw unknownWorkspaceError();
      }
      const session: FakeSession = {
        sessionId: `sess-${randomUUID()}`,
        runId: envelope.fence.runId,
        acpSessionId: `acp-${randomUUID()}`,
        executionWorkspaceId: ws.executionWorkspaceId,
        assignmentEpoch: envelope.fence.assignmentEpoch,
        createdByCommandId: envelope.command.id,
        status: "live",
      };

      sessions.set(session.sessionId, session);
      const body = {
        sessionId: session.sessionId,
        pid: 4242,
        acpSessionId: session.acpSessionId,
      };

      receipt(envelope, "completed", 201, body);

      return body;
    },
    async sendPrompt(sessionId, envelope) {
      await record("sendPrompt", envelope, [sessionId]);
      fence(envelope);
      const replayed = replay<PromptResult>(envelope);

      if (replayed) return replayed;
      liveSession(sessionId);
      receipt(envelope, "accepted", 202, {}, true);
      const ctx: PromptContext = {
        sessionId,
        envelope,
        setReceipt: (phase, body, inflight = false) =>
          receipt(
            envelope,
            phase,
            phase === "rejected" ? 409 : 200,
            body,
            inflight,
          ),
        emit: (phase, extra) => {
          monotonicId += 1;
          commandSignals.publish({
            type: "session.command",
            sessionId,
            monotonicId,
            commandId: envelope.command.id,
            kind: "session.prompt",
            phase,
            ...(phase === "completed"
              ? {
                  status: "succeeded" as const,
                  result: { stopReason: "end_turn" },
                }
              : {}),
            ...extra,
          } as SupervisorEvent);
        },
      };
      const result = await promptBehavior(ctx);
      const current = receipts.get(envelope.command.id);

      if (current?.phase === "accepted") {
        receipt(envelope, "completed", 200, { ...result });
      }

      return result;
    },
    async deliverInput(sessionId, envelope) {
      await record("deliverInput", envelope, [sessionId]);
      fence(envelope);
      liveSession(sessionId);
      receipt(envelope, "completed", 200, { ok: true });

      return { ok: true };
    },
    async cancelPrompt(sessionId, envelope) {
      await record("cancelPrompt", envelope, [sessionId]);
      fence(envelope);
      receipt(envelope, "completed", 200, { cancelled: false });

      return { cancelled: false };
    },
    async checkpointSession(sessionId, envelope): Promise<CheckpointResult> {
      await record("checkpointSession", envelope, [sessionId]);
      fence(envelope);
      const session = sessions.get(sessionId);
      const alreadyCheckpointed = !session || session.status !== "live";

      if (session) session.status = "exited";
      monotonicId += 1;
      const body = { alreadyCheckpointed, sessionId, monotonicId };

      receipt(envelope, "completed", 200, body);

      return body;
    },
    async deleteSession(
      sessionId,
      envelope,
    ): Promise<{ outcome: DeleteSessionOutcome }> {
      await record("deleteSession", envelope, [sessionId]);
      fence(envelope);
      const session = sessions.get(sessionId);
      const outcome: DeleteSessionOutcome = session ? "terminated" : "gone";

      sessions.delete(sessionId);
      receipt(envelope, "completed", session ? 200 : 404, { outcome });

      return { outcome };
    },
  };

  return {
    transport,
    identity,
    calls,
    callsOf: (method) => calls.filter((c) => c.method === method),
    sessions,
    workspaces,
    receipts,
    fences,
    failOnce(method, error) {
      faults.set(method, [...(faults.get(method) ?? []), error]);
    },
    onCall(method, hook) {
      hooks.set(method, [...(hooks.get(method) ?? []), hook]);
    },
    setHealth(next) {
      health = next;
    },
    setPromptBehavior(behavior) {
      promptBehavior = behavior;
    },
    // A host restart: new bootId, live sessions gone, in-flight receipts stay
    // `accepted` with `inflight:false` (the turn_lost signature).
    restart() {
      identity.bootId = randomUUID();
      for (const session of sessions.values()) session.status = "exited";
      for (const r of receipts.values()) {
        if (r.phase === "accepted") r.inflight = false;
      }
    },
    monotonic: () => monotonicId,
  };
}

// A `BoundClient` over the fake transport, bound to a real assignment row.
// The seeded host row's key MUST equal the fake identity's key — the resolver
// verifies the assignment's host against the registrar's observation.
export async function fakeBoundClient(args: {
  db: Db;
  fake: FakeExecutionHost;
  assignment: ExecutionAssignment;
}): Promise<{ client: BoundClient; hosts: ExecutionHosts }> {
  resetResolverForTests();
  const hosts = createExecutionHosts({
    db: args.db,
    transport: args.fake.transport,
    sleep: async () => {},
  });

  return { client: await hosts.forAssignment(args.assignment), hosts };
}

export type { AdoptWorkspaceWire };
