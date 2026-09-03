import type { Db } from "@/lib/execution-host/db";
import type { ExecutionAssignment, ExecutionHost } from "@/lib/db/schema";
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
  WorkspaceRecord,
} from "@/lib/execution-host/contracts";
import type {
  CommandEnvelope,
  CommandKind,
  ExecutionWorkspaceId,
} from "@/lib/execution-host/types";
import type {
  CreateSessionResult,
  PromptResult,
  SendPromptInput,
  SupervisorDiagnosticsStatus,
  SupervisorEvent,
  SupervisorSessionRecord,
} from "@/lib/supervisor-client";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PlatformStatus } from "@/types/platform-status";

import { randomUUID } from "node:crypto";

import { MaisterError } from "@/lib/errors";
import { isUnknownWorkspaceError } from "@/lib/execution-host/adoption";
import {
  createExecutionHosts,
  type BoundClient,
  type ExecutionHosts,
  type HostAdminClient,
} from "@/lib/execution-host/client";
import { UNKNOWN_OUTCOME_DETAIL } from "@/lib/execution-host/contracts";
import { buildEnvelope } from "@/lib/execution-host/ledger";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { setDefaultTransportForTests } from "@/lib/execution-host/default-transport";
import { commandSignals } from "@/lib/execution-host/signals";
import {
  asExecutionWorkspaceId,
  asHostSessionId,
} from "@/lib/execution-host/types";

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
  stepId: string;
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
  // The host executes the next call of `method` (receipt written) but the
  // response is lost: the deliverer's same-id retry then meets a replay.
  loseResponseOnce(method: TransportMethod): void;
  onCall(
    method: TransportMethod,
    hook: (call: FakeCall) => void | Promise<void>,
  ): void;
  setHealth(health: HostHealth | null): void;
  setDiagnostics(status: SupervisorDiagnosticsStatus | null): void;
  setPromptBehavior(
    behavior: (ctx: PromptContext) => Promise<PromptResult>,
  ): void;
  restart(): void;
  monotonic(): number;
  // Script the per-session SSE stream a driver consumes.
  pushEvent(sessionId: string, event: SupervisorEvent): void;
  endStream(sessionId: string): void;
  // Events every session's FIRST stream yields (before pushed ones); `end`
  // closes the stream after them (a DB-less driver double that must return).
  setStreamEvents(
    events: SupervisorEvent[] | null,
    opts?: { end?: boolean },
  ): void;
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
  const lostResponses = new Set<TransportMethod>();
  const loseResponse = (method: TransportMethod) => {
    if (!lostResponses.delete(method)) return;
    throw unknownOutcomeError(`fake: response to ${method} lost`);
  };
  const hooks = new Map<
    TransportMethod,
    Array<(call: FakeCall) => void | Promise<void>>
  >();
  let health: HostHealth | null = null;
  let diagnostics: SupervisorDiagnosticsStatus | null = null;
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
          // Like the host: an evicted session's pending turn is rejected
          // FENCED, and its stream ends with a fenced exit.
          evictions.get(session.sessionId)?.(
            fencedError(runId, session.assignmentEpoch),
          );
          streamQueueFor(session.sessionId).push({
            type: "session.exited",
            sessionId: session.sessionId,
            monotonicId: ++monotonicId,
            exitCode: 143,
            reason: "fenced",
          } as SupervisorEvent);
        }
      }
    }
  };
  // In-flight prompt turns by session, rejectable on eviction.
  const evictions = new Map<string, (err: MaisterError) => void>();

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

  class StreamQueue {
    scripted = false;
    private readonly events: SupervisorEvent[] = [];
    private closed = false;
    private waiter: (() => void) | null = null;

    push(event: SupervisorEvent): void {
      this.events.push(event);
      this.waiter?.();
    }

    close(): void {
      this.closed = true;
      this.waiter?.();
    }

    async next(signal?: AbortSignal): Promise<SupervisorEvent | null> {
      for (;;) {
        if (this.events.length > 0) return this.events.shift()!;
        if (this.closed || signal?.aborted) return null;
        await new Promise<void>((resolve) => {
          this.waiter = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        this.waiter = null;
      }
    }
  }
  const streams = new Map<string, StreamQueue>();
  let scriptedEvents: SupervisorEvent[] | null = null;
  let scriptedEnd = false;
  const streamQueueFor = (sessionId: string) => {
    let queue = streams.get(sessionId);

    if (!queue) {
      queue = new StreamQueue();
      streams.set(sessionId, queue);
    }

    return queue;
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
    async diagnostics() {
      await record("diagnostics", null, []);

      return (
        diagnostics ?? {
          kind: "unavailable",
          reason: "network",
          message: "fake: no diagnostics scripted",
        }
      );
    },
    async platformStatus() {
      await record("platformStatus", null, []);
      const current = await transport.health();

      if (current.kind !== "ready") return current as PlatformStatus;

      return {
        kind: "ready",
        health: {
          status: "ready",
          host: identity,
          version: current.version,
          uptimeMs: 1,
          checkedAt: new Date().toISOString(),
          sessions: current.sessions,
        },
      } as PlatformStatus;
    },
    // Admin operations a suite scripts by overriding the transport method.
    async startSidecar(sidecarId) {
      await record("startSidecar", null, [sidecarId]);

      return { ok: true as const, state: "ready" as const };
    },
    async stopSidecar(sidecarId) {
      await record("stopSidecar", null, [sidecarId]);

      return { ok: true as const, state: "idle" as const };
    },
    async resolveModelSuggestions(draft) {
      await record("resolveModelSuggestions", null, [draft]);
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "fake: no model catalog scripted",
      );
    },
    async probeMcp(req) {
      await record("probeMcp", null, [req]);
      throw new MaisterError("EXECUTOR_UNAVAILABLE", "fake: no probe scripted");
    },
    async listSessions(): Promise<SupervisorSessionRecord[]> {
      await record("listSessions", null, []);

      return [...sessions.values()].map((s) => ({
        sessionId: s.sessionId,
        runId: s.runId,
        projectSlug: "fake",
        stepId: s.stepId,
        status: s.status,
        pid: 4242,
        startedAt: new Date(0).toISOString(),
        logPath: "/dev/null",
        monotonicId,
        acpSessionId: s.acpSessionId,
      })) as unknown as SupervisorSessionRecord[];
    },
    // Per-session event queue: yields what `pushEvent` scripted (plus the
    // shared `setStreamEvents` script on the first stream of a session), ends
    // on `session.exited|crashed`, `endStream`, or the consumer's abort signal.
    async *streamSession(sessionId, opts) {
      await record("streamSession", null, [sessionId, opts?.lastEventId]);
      const queue = streamQueueFor(sessionId);

      if (scriptedEvents && !queue.scripted) {
        queue.scripted = true;
        for (const event of scriptedEvents) queue.push(event);
        if (scriptedEnd) queue.close();
      }
      for (;;) {
        const event = await queue.next(opts?.signal);

        if (event === null) return;
        commandSignals.publish(event);
        yield event;
        if (
          event.type === "session.exited" ||
          event.type === "session.crashed"
        ) {
          return;
        }
        // Give the consumer's side effects a turn, like the real SSE stream.
        await new Promise((r) => setImmediate(r));
      }
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
        stepId: envelope.payload.stepId ?? "fake",
        // Like the host: a resume restores the SAME ACP conversation.
        acpSessionId: envelope.payload.resumeSessionId ?? `acp-${randomUUID()}`,
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
      const evicted = new Promise<never>((_, reject) => {
        evictions.set(sessionId, reject);
      });
      let result: PromptResult;

      try {
        result = await Promise.race([promptBehavior(ctx), evicted]);
      } finally {
        evictions.delete(sessionId);
      }
      const current = receipts.get(envelope.command.id);

      if (current?.phase === "accepted") {
        receipt(envelope, "completed", 200, { ...result });
      }

      return result;
    },
    async deliverInput(sessionId, envelope) {
      await record("deliverInput", envelope, [sessionId]);
      fence(envelope);
      const replayed = replay<InputDeliveryResult>(envelope);

      if (replayed) return replayed;
      liveSession(sessionId);
      receipt(envelope, "completed", 200, { ok: true });
      loseResponse("deliverInput");

      return { ok: true, replayed: false };
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
    loseResponseOnce(method) {
      lostResponses.add(method);
    },
    onCall(method, hook) {
      hooks.set(method, [...(hooks.get(method) ?? []), hook]);
    },
    setHealth(next) {
      health = next;
    },
    setDiagnostics(next) {
      diagnostics = next;
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
    pushEvent(sessionId, event) {
      streamQueueFor(sessionId).push(event);
    },
    endStream(sessionId) {
      streamQueueFor(sessionId).close();
    },
    setStreamEvents(events, opts) {
      scriptedEvents = events;
      scriptedEnd = opts?.end ?? false;
    },
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

// A DB-backed `ExecutionHosts` over the fake transport for integration tests
// that drive `runFlow`/services: registers the fake identity as THE active
// local host (retiring any other active row of a previous fake) and, when a
// run id is given, mints its `launch` assignment so `forRun` binds normally.
export async function fakeExecutionHosts(
  // Any drizzle client over the main schema — the graph suites hold a bare
  // `NodePgDatabase`; the execution-host modules see it as `Db`.
  anyDb: NodePgDatabase | Db,
  opts: { fake?: FakeExecutionHost; runId?: string } = {},
): Promise<{
  hosts: ExecutionHosts;
  fake: FakeExecutionHost;
  hostId: string;
  host: ExecutionHost;
  assignment: ExecutionAssignment | null;
}> {
  const db = anyDb as unknown as Db;
  const fake = opts.fake ?? createFakeExecutionHost();
  const { executionHosts } = await import("@/lib/db/schema");
  const { and, eq, isNull } = await import("drizzle-orm");
  const { mintAssignment } = await import("@/lib/execution-host/assignments");
  const { getActiveAssignment } = await import(
    "@/lib/execution-host/assignments"
  );

  resetResolverForTests();
  const active = await db
    .select()
    .from(executionHosts)
    .where(
      and(
        eq(executionHosts.kind, "local_direct"),
        isNull(executionHosts.retiredAt),
      ),
    );
  let hostId = active.find((h) => h.hostKey === fake.identity.hostKey)?.id;

  if (!hostId) {
    for (const other of active) {
      await db
        .update(executionHosts)
        .set({ retiredAt: new Date() })
        .where(eq(executionHosts.id, other.id));
    }
    hostId = randomUUID();
    await db.insert(executionHosts).values({
      id: hostId,
      hostKey: fake.identity.hostKey,
      kind: "local_direct",
      displayName: "fake local host",
      transport: { kind: "local_direct" },
      capabilities: {
        protocolVersion: 1,
        supervisorVersion: "fake",
        adapters: [],
      },
      readiness: "ready",
      lastBootId: fake.identity.bootId,
      lastSeenAt: new Date(),
    });
  }

  // Every implicit resolution in this process (a claim transition minting
  // through `localHost({db: tx})`, a route's `createExecutionHosts({db})`)
  // now reaches the fake instead of the real wire — and the resolver memo is
  // warm, so a suite's one-shot db fault never lands on a host registration.
  setDefaultTransportForTests(fake.transport);
  const { localHost } = await import("@/lib/execution-host/resolver");

  await localHost({ db, transport: fake.transport, force: true });
  const [host] = await db
    .select()
    .from(executionHosts)
    .where(eq(executionHosts.id, hostId));

  let assignment: ExecutionAssignment | null = null;

  if (opts.runId) {
    const seededHostId = hostId;
    const runId = opts.runId;

    assignment =
      (await getActiveAssignment(db, runId)) ??
      (await db.transaction((tx) =>
        mintAssignment(tx as unknown as Db, {
          runId,
          hostId: seededHostId,
          reason: "launch",
        }),
      ));
  }

  return {
    hosts: createExecutionHosts({
      db,
      transport: fake.transport,
      sleep: async () => {},
    }),
    fake,
    hostId,
    host,
    assignment,
  };
}

// Script one agent turn the way the graph tests used to stub `SupervisorApi`:
// the session stream yields `text` as one agent_message_chunk then a clean
// exit, every prompt is captured into `prompts`, and the turn ends with
// `stopReason`. Re-applies to every session the fake creates.
export function scriptAgentTurn(
  fake: FakeExecutionHost,
  opts: {
    text?: string;
    stopReason?: PromptResult["stopReason"];
    prompts?: string[];
    onPrompt?: (ctx: PromptContext) => Promise<PromptResult> | PromptResult;
  } = {},
): { prompts: string[] } {
  const prompts = opts.prompts ?? [];
  const events: SupervisorEvent[] = [];

  if (opts.text !== undefined) {
    events.push({
      type: "session.update",
      sessionId: "fake",
      monotonicId: 1,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: opts.text },
      },
    } as SupervisorEvent);
  }
  events.push({
    type: "session.exited",
    sessionId: "fake",
    monotonicId: events.length + 1,
    exitCode: 0,
  } as SupervisorEvent);
  fake.setStreamEvents(events);
  fake.setPromptBehavior(async (ctx) => {
    prompts.push(ctx.envelope.payload.prompt);
    if (opts.onPrompt) return opts.onPrompt(ctx);

    return { stopReason: opts.stopReason ?? "end_turn", meta: null };
  });

  return { prompts };
}

// The graph-test seam in one call: a DB-backed `ExecutionHosts` over a fake
// scripted like the old `makeEndTurnSupervisor()` stubs.
export async function fakeGraphHosts(
  db: NodePgDatabase | Db,
  runId: string,
  script: Parameters<typeof scriptAgentTurn>[1] = {},
): Promise<{
  hosts: ExecutionHosts;
  fake: FakeExecutionHost;
  prompts: string[];
  creates: () => Record<string, unknown>[];
  adopts: () => Record<string, unknown>[];
}> {
  const fake = createFakeExecutionHost();
  const { prompts } = scriptAgentTurn(fake, script);
  const { hosts } = await fakeExecutionHosts(db, { fake, runId });
  const payloads = (method: TransportMethod) =>
    fake
      .callsOf(method)
      .map((c) => (c.envelope?.payload ?? {}) as Record<string, unknown>);

  return {
    hosts,
    fake,
    prompts,
    creates: () => payloads("createSession"),
    adopts: () => payloads("adoptWorkspace"),
  };
}

// ---------------------------------------------------------------------------
// DB-less doubles for unit-level driver tests (runner-agent, hooks): a
// `BoundClient` whose commands go straight to the fake transport with a
// synthesized fence — no ledger, no database. Integration tests bind through
// `createExecutionHosts({ db, transport })` instead.
// ---------------------------------------------------------------------------

export function memoryHost(
  fake: FakeExecutionHost,
  id = "host-fake",
): ExecutionHost {
  const now = new Date(0);

  return {
    id,
    hostKey: fake.identity.hostKey,
    kind: "local_direct",
    displayName: "fake host",
    transport: { kind: "local_direct" },
    capabilities: {
      protocolVersion: 1,
      supervisorVersion: "fake",
      adapters: [],
    },
    readiness: "ready",
    readinessReason: null,
    lastBootId: fake.identity.bootId,
    lastSeenAt: now,
    registeredAt: now,
    updatedAt: now,
    retiredAt: null,
  };
}

export function memoryAssignment(input: {
  runId: string;
  id?: string;
  epoch?: number;
  hostId?: string;
  executionWorkspaceId?: string | null;
}): ExecutionAssignment {
  const now = new Date(0);

  return {
    id: input.id ?? randomUUID(),
    runId: input.runId,
    executionHostId: input.hostId ?? "host-fake",
    epoch: input.epoch ?? 1,
    state: "active",
    placementReason: "launch",
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    workspaceAdoptedAt: null,
    leaseExpiresAt: null,
    supersededById: null,
    releasedReason: null,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
  };
}

export function memoryBoundClient(args: {
  fake: FakeExecutionHost;
  runId: string;
  assignment?: ExecutionAssignment;
  host?: ExecutionHost;
  projectSlug?: string;
  workspacePath?: string;
}): BoundClient {
  const { fake } = args;
  const host = args.host ?? memoryHost(fake);
  let current =
    args.assignment ?? memoryAssignment({ runId: args.runId, hostId: host.id });
  const envelope = <TPayload>(kind: CommandKind, payload: TPayload) =>
    buildEnvelope({
      commandId: randomUUID(),
      kind,
      hostKey: host.hostKey,
      assignmentId: current.id,
      assignmentEpoch: current.epoch,
      runId: current.runId,
      payload,
    });
  const adopt = async () => {
    const result = await fake.transport.adoptWorkspace(
      envelope("workspace.adopt", {
        runId: current.runId,
        projectSlug: args.projectSlug ?? "fake",
        kind: "directory" as const,
        path: args.workspacePath ?? `/tmp/fake/${current.runId}`,
      }),
    );

    current = {
      ...current,
      executionWorkspaceId: result.executionWorkspaceId,
      workspaceAdoptedAt: new Date(),
    };

    return result;
  };
  const client: BoundClient = {
    get assignment() {
      return current;
    },
    host,
    adoptWorkspace: (spec) =>
      fake.transport.adoptWorkspace(envelope("workspace.adopt", spec)),
    async ensureWorkspace(opts) {
      if (!opts?.force && current.executionWorkspaceId) {
        return asExecutionWorkspaceId(current.executionWorkspaceId);
      }

      return (await adopt()).executionWorkspaceId;
    },
    releaseWorkspace: (id) =>
      fake.transport.releaseWorkspace(id, envelope("workspace.release", {})),
    async createSession(payload, opts) {
      const sessionName = opts?.sessionName ?? payload.sessionName ?? "default";
      const attempt = async (executionWorkspaceId: ExecutionWorkspaceId) => {
        const result = await fake.transport.createSession(
          envelope("session.create", {
            ...payload,
            sessionName,
            executionWorkspaceId,
          }),
        );

        return { ...result, hostSessionId: asHostSessionId(result.sessionId) };
      };

      try {
        return await attempt(await client.ensureWorkspace());
      } catch (err) {
        if (!isUnknownWorkspaceError(err)) throw err;

        return attempt(await client.ensureWorkspace({ force: true }));
      }
    },
    async prompt(sessionId, input, opts) {
      const env = envelope("session.prompt", input);

      return {
        commandId: env.command.id,
        completion: fake.transport.sendPrompt(sessionId, env, {
          signal: opts?.signal,
        }),
      };
    },
    deliverInput: (sessionId, payload) =>
      fake.transport.deliverInput(
        sessionId,
        envelope("session.input", payload),
      ),
    async prepareInput(_tx, sessionId, payload) {
      const env = envelope("session.input", payload);

      return {
        commandId: env.command.id,
        payload,
        deliver: async (opts) => {
          const result = await fake.transport.deliverInput(sessionId, env);

          await opts?.onAck?.(null as never, result);

          return result;
        },
      };
    },
    async sessionsForRun() {
      const runId = current.runId;

      return (await fake.transport.listSessions()).filter(
        (record) => record.runId === runId,
      );
    },
    cancelPrompt: (sessionId) =>
      fake.transport.cancelPrompt(sessionId, envelope("session.cancel", {})),
    checkpoint: (sessionId) =>
      fake.transport.checkpointSession(
        sessionId,
        envelope("session.checkpoint", {}),
      ),
    deleteSession: (sessionId) =>
      fake.transport.deleteSession(sessionId, envelope("session.delete", {})),
  };

  return client;
}

export function memoryAdminClient(fake: FakeExecutionHost): HostAdminClient {
  return {
    health: (opts) => fake.transport.health(opts),
    diagnostics: (opts) => fake.transport.diagnostics(opts),
    platformStatus: (opts) => fake.transport.platformStatus(opts),
    startSidecar: (id, config) => fake.transport.startSidecar(id, config),
    stopSidecar: (id) => fake.transport.stopSidecar(id),
    resolveModelSuggestions: (draft, opts) =>
      fake.transport.resolveModelSuggestions(draft, opts),
    probeMcp: (req) => fake.transport.probeMcp(req),
    listSessions: () => fake.transport.listSessions(),
    streamSession: (sessionId, opts) =>
      fake.transport.streamSession(sessionId, opts),
    getCommandReceipt: (id) => fake.transport.getCommandReceipt(id),
    getWorkspace: (id) => fake.transport.getWorkspace(id),
  };
}

// A DB-less `ExecutionHosts` over the fake: every run binds a memory client
// (synthesized fence, no ledger) — for dep-injected unit suites that never
// touch Postgres (workbench lifecycle).
export function memoryExecutionHosts(fake: FakeExecutionHost): ExecutionHosts {
  const host = memoryHost(fake);

  return {
    transport: fake.transport,
    forAssignment: async (assignment) =>
      memoryBoundClient({
        fake,
        runId: (assignment as ExecutionAssignment).runId ?? "run-memory",
        assignment: assignment as ExecutionAssignment,
        host,
      }),
    forRun: async (runId) => memoryBoundClient({ fake, runId, host }),
    local: () => memoryAdminClient(fake),
  };
}

export type FakeAgentExecution = {
  fake: FakeExecutionHost;
  client: BoundClient;
  admin: HostAdminClient;
};

// The runner-agent seam for unit tests: `events` scripts the session stream
// (yielded on the first stream of any session), `promptStopReason` the turn.
export function fakeAgentExecution(
  args: {
    fake?: FakeExecutionHost;
    runId?: string;
    events?: SupervisorEvent[];
    promptStopReason?: PromptResult["stopReason"];
    promptBehavior?: (ctx: PromptContext) => Promise<PromptResult>;
  } = {},
): FakeAgentExecution {
  const fake = args.fake ?? createFakeExecutionHost();

  if (args.events) fake.setStreamEvents(args.events, { end: true });
  if (args.promptBehavior) {
    fake.setPromptBehavior(args.promptBehavior);
  } else if (args.promptStopReason) {
    const stopReason = args.promptStopReason;

    fake.setPromptBehavior(async () => ({ stopReason, meta: null }));
  }

  return {
    fake,
    client: memoryBoundClient({ fake, runId: args.runId ?? "run-1" }),
    admin: memoryAdminClient(fake),
  };
}

export type { AdoptWorkspaceWire };
