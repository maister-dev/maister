import type { Db } from "@/lib/execution-host/db";
import type { ExecutionAssignment, ExecutionHost } from "@/lib/db/schema";
import type {
  AdoptWorkspaceResult,
  AdoptWorkspaceWire,
  CheckpointResult,
  CommandCallOptions,
  CommandReceipt,
  CreateSessionPayload,
  DeleteSessionOutcome,
  ExecutionHostTransport,
  HostHealth,
  InputDeliveryResult,
  RuntimeObjectContent,
  RuntimeObjectMetadata,
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
import type {
  ImmutableObjectReference,
  CommandTerminalEvidenceV2,
} from "../../runtime/command-evidence";

import { createHash, randomUUID } from "node:crypto";

import { canonicalCommandJson } from "../../runtime/command-json";

import {
  isMaisterError,
  MaisterError,
  type MaisterErrorCode,
} from "@/lib/errors";
import { isReadoptableWorkspaceError } from "@/lib/execution-host/adoption";
import {
  createExecutionHosts,
  type BoundClient,
  type ExecutionHosts,
  type HostAdminClient,
} from "@/lib/execution-host/client";
import { UNKNOWN_OUTCOME_DETAIL } from "@/lib/execution-host/contracts";
import { normalizeCommandReceiptV2 } from "@/lib/execution-host/command-receipt";
import { storePromptRequest } from "@/lib/execution-host/command-request";
import { buildEnvelope } from "@/lib/execution-host/ledger";
import {
  primeResolverForTests,
  resetResolverForTests,
} from "@/lib/execution-host/resolver";
import { setDefaultTransportForTests } from "@/lib/execution-host/default-transport";
import { commandSignals } from "@/lib/execution-host/signals";
import {
  asExecutionWorkspaceId,
  asHostSessionId,
} from "@/lib/execution-host/types";

// ADR-166 T3.1: an in-memory `ExecutionHostTransport` with the host's
// observable semantics and programmable faults, for ledger/deliverer/driver
// tests that must not spawn a supervisor. It mirrors the real host rule by
// rule — the fence order (host_mismatch → run_mismatch → assignment_fenced →
// assignment_mismatch), lower-epoch eviction on advance, receipts (verbatim
// replay, in-flight join, `turn_lost` after a restart), the handle store
// (unknown vs released; a released path re-adopts as a NEW handle), and every
// route's own refusal (404 unknown session, 503 for an input to an unknown
// session, 410 for an unknown request id). Errors are shaped exactly as the
// local-direct wire maps them (`details.httpStatus` + reason tokens), so a
// caller cannot tell the difference; `host-parity.integration.test.ts` pins
// that equivalence against a real supervisor child.

// The production transport has no synchronous prompt operation after B4. This
// fake-only helper remains so older scripted-turn tests can model a terminal
// ACP turn without exposing that wire capability to domain code.
export type FakeCanonicalEvent =
  | SupervisorEvent
  | {
      type: "session.created";
      createdByCommandId: string;
      sessionId: string;
      monotonicId: number;
      sessionName: string;
      acpSessionId: string;
    };

export type FakeTransport = ExecutionHostTransport & {
  sendPrompt(
    sessionId: string,
    envelope: CommandEnvelope<SendPromptInput>,
    opts?: CommandCallOptions & { signal?: AbortSignal },
  ): Promise<PromptResult>;
};

export type TransportMethod = keyof FakeTransport;

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
  // The rest of the `GET /sessions` projection — optional so a suite can
  // inject a minimal record with `fake.sessions.set(...)`.
  assignmentId?: string;
  projectSlug?: string;
  nodeAttemptId?: string;
  sessionName?: string;
  adapter?: string;
  startedAt?: string;
  exitedAt?: string;
  exitCode?: number | null;
  // Set when a command with a HIGHER assignment epoch evicted this session:
  // its pending prompt answers 409 FENCED (X-EH-19).
  fencedByEpoch?: number;
  // Permission request ids the host holds a deferred for. A transport-created
  // session tracks the ids streamed on its stream (an unknown id is 410
  // HITL_TIMEOUT, like the host); an INJECTED record leaves it undefined —
  // its pending set is unknown, so any id is accepted while it is live.
  pending?: Set<string>;
  runtimeOutputObjectIds?: string[];
};

export type PromptContext = {
  sessionId: string;
  envelope: CommandEnvelope<SendPromptInput>;
  // Move the receipt through its phases from inside a scripted turn. The
  // `inflight` flag is ORed with the live in-flight map at read time.
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
  transport: FakeTransport;
  identity: { hostKey: string; bootId: string; protocolVersion: 1 };
  calls: FakeCall[];
  callsOf(method: TransportMethod): FakeCall[];
  sessions: Map<string, FakeSession>;
  workspaces: Map<string, WorkspaceRecord & { path: string }>;
  receipts: Map<string, CommandReceipt>;
  // Per-run epoch high-water (the host's `run_fences`). A suite may seed it.
  fences: Map<string, number>;
  failOnce(method: TransportMethod, error: unknown): void;
  // The host executes the next call of `method` (its receipt is written) but
  // the response is lost: the same-id retry then meets a replay. For
  // `sendPrompt` the response is lost right after acceptance while the turn
  // keeps running in flight (the retry JOINS it). Not applicable to
  // `streamSession`.
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
  setCanonicalEventSink(
    sink: (input: {
      envelope: CommandEnvelope<unknown>;
      sessionId: string;
      event: FakeCanonicalEvent;
      eventId: string;
    }) => Promise<void>,
  ): void;
  /** Publish a canonical host event exactly as the fake's own transport does.
   * A suite that REPLACES a transport method still owes the event plane the
   * lifecycle events that method would have produced. */
  publishCanonical(
    envelope: CommandEnvelope<unknown>,
    sessionId: string,
    event: FakeCanonicalEvent,
  ): Promise<void>;
  waitForCanonicalEvents(): Promise<void>;
  publishPromptReceipt(receipt: CommandReceipt): void;
  sealPromptJson(runId: string, value: unknown): ImmutableObjectReference;
  writeRuntimeOutput(objectId: string, bytes: Uint8Array): void;
  // A host restart: new bootId, every live session is gone (the registry is
  // empty), fences + receipts + handles survive, an in-flight turn is lost
  // (its receipt stays `accepted` with `inflight:false`).
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

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isSafeSegment(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    SAFE_PATH_SEGMENT.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

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

export function fencedError(
  runId: string,
  commandEpoch: number,
  hostEpoch?: number,
): MaisterError {
  return new MaisterError("CONFLICT", "fake: assignment fenced", {
    details: {
      reason: "assignment_fenced",
      runId,
      commandEpoch,
      ...(hostEpoch !== undefined ? { hostEpoch } : {}),
      httpStatus: 409,
    },
  });
}

export function unknownWorkspaceError(): MaisterError {
  return new MaisterError("PRECONDITION", "fake: unknown execution workspace", {
    details: { reason: "unknown_workspace", httpStatus: 409 },
  });
}

export function workspaceReleasedError(runId: string): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "fake: execution workspace has been released",
    { details: { reason: "workspace_released", runId, httpStatus: 409 } },
  );
}

function precondition(
  message: string,
  details: Record<string, unknown>,
): MaisterError {
  return new MaisterError("PRECONDITION", `fake: ${message}`, {
    details: { ...details, httpStatus: 409 },
  });
}

// `POST /sessions/:id/{prompt,cancel,checkpoint}` on an unknown session.
function unknownSessionError(sessionId: string): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    `fake: unknown session ${sessionId}`,
    {
      details: { httpStatus: 404 },
    },
  );
}

// `POST /sessions/:id/input` on an unknown session: the host classifies it
// as a restart (retryable, definitive — no unknown-outcome marker).
function inputUnknownSessionError(sessionId: string): MaisterError {
  return new MaisterError(
    "EXECUTOR_UNAVAILABLE",
    `fake: unknown session ${sessionId} — supervisor may have restarted`,
    { details: { httpStatus: 503 } },
  );
}

function hitlTimeoutError(): MaisterError {
  return new MaisterError(
    "HITL_TIMEOUT",
    "fake: no pending permission with that requestId",
    { details: { httpStatus: 410 } },
  );
}

function httpStatusOf(err: unknown): number | null {
  const status =
    err instanceof MaisterError ? err.details?.httpStatus : undefined;

  return typeof status === "number" ? status : null;
}

// The wire body a refusal is stored under in the receipt (what the real
// host's `errorBody` writes).
function errorBodyOf(err: MaisterError): Record<string, unknown> {
  const details: Record<string, unknown> = { ...(err.details ?? {}) };

  delete details.httpStatus;
  const code =
    err.code === "CONFLICT" && details.reason === "assignment_fenced"
      ? "FENCED"
      : err.code;

  return {
    code,
    message: err.message,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

const KNOWN_WIRE_CODES: ReadonlySet<string> = new Set([
  "PRECONDITION",
  "SPAWN",
  "NEEDS_INPUT",
  "EXECUTOR_UNAVAILABLE",
  "ACP_PROTOCOL",
  "CHECKPOINT",
  "CRASH",
]);

// Mirrors `supervisorErrorToMaister` + the per-endpoint status rules of the
// local-direct wire for a replayed error receipt.
function wireError(
  method: TransportMethod,
  status: number,
  body: Record<string, unknown>,
): MaisterError {
  const wireCode = typeof body.code === "string" ? body.code : null;
  const details =
    body.details && typeof body.details === "object"
      ? (body.details as Record<string, unknown>)
      : {};
  const message =
    typeof body.message === "string" ? body.message : `supervisor ${status}`;

  if (wireCode === "FENCED") {
    return new MaisterError("CONFLICT", message, {
      details: { ...details, reason: "assignment_fenced", httpStatus: status },
    });
  }
  if (method === "deliverInput" && (status === 410 || status === 404)) {
    return new MaisterError("HITL_TIMEOUT", message, {
      details: { ...details, httpStatus: status },
    });
  }
  if (status >= 500) {
    return new MaisterError("EXECUTOR_UNAVAILABLE", message, {
      details: { ...details, httpStatus: status },
    });
  }

  return new MaisterError(
    (wireCode && KNOWN_WIRE_CODES.has(wireCode)
      ? wireCode
      : "ACP_PROTOCOL") as MaisterErrorCode,
    message,
    { details: { ...details, httpStatus: status } },
  );
}

type Outcome<T> = { status: number; body: T };

// The wire surfaces the replay header only where its result carries a
// `replayed` flag (adopt, input); every other result is the body verbatim.
const REPLAY_FLAGGED: ReadonlySet<TransportMethod> = new Set([
  "adoptWorkspace",
  "deliverInput",
]);

function replayed<T>(method: TransportMethod, body: T): T {
  return REPLAY_FLAGGED.has(method)
    ? ({ ...(body as Record<string, unknown>), replayed: true } as T)
    : body;
}

type CanonicalStreamState = {
  bootId: string;
  streamId: string;
  nextSequence: bigint;
};

const canonicalStreamStates = new WeakMap<
  FakeExecutionHost,
  CanonicalStreamState
>();

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
  const publishedPromptReceipts = new Map<string, CommandReceipt>();
  const runtimeObjects = new Map<
    string,
    { metadata: RuntimeObjectMetadata; bytes: Uint8Array | null; runId: string }
  >();
  const runtimeOutputWrites = new Map<string, Uint8Array>();
  const fences = new Map<string, number>();
  // The assignment that owns each run's high-water (the host stores both).
  const fenceOwners = new Map<string, string>();
  const inflight = new Map<string, Promise<Outcome<unknown>>>();
  // In-flight prompt turns by session, settle-able from outside the turn
  // (eviction, checkpoint, delete, restart).
  const inflightPrompts = new Map<
    string,
    Set<{ reject: (err: MaisterError) => void }>
  >();
  const faults = new Map<TransportMethod, unknown[]>();
  const lostResponses = new Set<TransportMethod>();
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
  let canonicalEventSink:
    | ((input: {
        envelope: CommandEnvelope<unknown>;
        sessionId: string;
        event: FakeCanonicalEvent;
        eventId: string;
      }) => Promise<void>)
    | null = null;
  let canonicalEventTail = Promise.resolve();
  const activePromptEnvelopes = new Map<
    string,
    CommandEnvelope<SendPromptInput>
  >();
  const scriptedCanonicalSessions = new Set<string>();

  const publishCanonical = (
    envelope: CommandEnvelope<unknown>,
    sessionId: string,
    event: FakeCanonicalEvent,
  ): Promise<void> => {
    if (!canonicalEventSink) return Promise.resolve();

    const eventId = randomUUID();

    const published = canonicalEventTail.then(async () => {
      // The real host commits the terminal receipt and its event pointer before
      // exposing the event. A manager projector may read the receipt in the sink.
      if (event.type === "session.command" && event.phase === "completed") {
        const receipt = receipts.get(event.commandId);

        if (receipt && receipt.phase !== "accepted")
          receipts.set(event.commandId, { ...receipt, eventId });
      }
      await canonicalEventSink?.({
        envelope,
        sessionId,
        event: { ...event, sessionId },
        eventId,
      });
    });

    // The chain exists to preserve ORDER. A single rejected link must not
    // poison every later publish, so the tail swallows outcomes and only the
    // caller that published THIS event sees its failure.
    canonicalEventTail = published.then(
      () => undefined,
      () => undefined,
    );

    return published;
  };

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

  const settleInflightPrompts = (sessionId: string, err: MaisterError) => {
    for (const turn of inflightPrompts.get(sessionId) ?? []) turn.reject(err);
    inflightPrompts.delete(sessionId);
  };

  // ---- streams ------------------------------------------------------------

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
  // Every event reaches a session's stream through here: a permission request
  // is a deferred the host now holds for that session.
  const enqueue = (sessionId: string, event: SupervisorEvent) => {
    if (event.type === "session.permission_request") {
      const session = sessions.get(sessionId);

      if (session) (session.pending ??= new Set()).add(event.requestId);
    }
    streamQueueFor(sessionId).push(event);
  };
  const exitEvent = (
    sessionId: string,
    reason: "checkpoint" | "intentional" | "fenced",
  ): SupervisorEvent =>
    ({
      type: "session.exited",
      sessionId,
      monotonicId: ++monotonicId,
      exitCode: 143,
      reason,
    }) as SupervisorEvent;

  // ---- fence (D3): host key → run binding → epoch high-water → identity ---

  const applyFence = (
    envelope: CommandEnvelope<unknown>,
    expectedRunId?: string,
  ): { advanced: boolean } => {
    const { hostKey, runId, assignmentEpoch, assignmentId } = envelope.fence;

    if (hostKey !== identity.hostKey) {
      throw precondition("command fence names a different execution host", {
        reason: "host_mismatch",
        runId,
      });
    }
    if (expectedRunId !== undefined && runId !== expectedRunId) {
      throw precondition(
        "command fence names a different run than the target",
        {
          reason: "run_mismatch",
          runId,
        },
      );
    }
    const high = fences.get(runId);
    const owner = fenceOwners.get(runId);

    if (high !== undefined && assignmentEpoch < high) {
      throw fencedError(runId, assignmentEpoch, high);
    }
    if (
      high !== undefined &&
      assignmentEpoch === high &&
      owner !== undefined &&
      owner !== assignmentId
    ) {
      throw precondition(
        `command names assignment ${assignmentId} but the host high-water epoch ${high} belongs to ${owner}`,
        {
          reason: "assignment_mismatch",
          runId,
          commandEpoch: assignmentEpoch,
          hostEpoch: high,
        },
      );
    }
    if (high === undefined || assignmentEpoch > high) {
      fences.set(runId, assignmentEpoch);
      fenceOwners.set(runId, assignmentId);

      return { advanced: true };
    }
    // A seeded high-water (`fake.fences.set`) learns its owner on first use.
    if (owner === undefined) fenceOwners.set(runId, assignmentId);

    return { advanced: false };
  };

  // E-EH-04: a higher epoch evicts every live session of the run under a
  // lower one — its pending prompt answers FENCED, its stream ends `fenced`.
  const evictLowerEpochSessions = (runId: string, epoch: number) => {
    for (const session of sessions.values()) {
      if (session.runId !== runId || session.status !== "live") continue;
      if (session.assignmentEpoch >= epoch) continue;
      session.status = "exited";
      session.exitedAt = new Date().toISOString();
      session.exitCode = 143;
      session.fencedByEpoch = epoch;
      session.pending?.clear();
      settleInflightPrompts(
        session.sessionId,
        fencedError(runId, session.assignmentEpoch, epoch),
      );
      enqueue(session.sessionId, exitEvent(session.sessionId, "fenced"));
    }
  };

  // ---- receipts (D6) ------------------------------------------------------

  const writeReceipt = (
    envelope: CommandEnvelope<unknown>,
    phase: CommandReceipt["phase"],
    httpStatus: number,
    body: Record<string, unknown>,
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
      eventId: null,
      inflight: false,
    });
  };

  // ADR-166 D6 handler order for every enveloped route: receipt replay /
  // in-flight join → the route's own liveness guard → fence (persist the
  // high-water) → fresh execution (evict lower-epoch sessions, execute, write
  // the receipt).
  async function runCommand<T>(spec: {
    method: TransportMethod;
    envelope: CommandEnvelope<unknown>;
    args: unknown[];
    // Throws the route's own refusal; returns the run the fence must name.
    guard?: () => string | undefined;
    execute: () => Promise<Outcome<T>>;
    // The response can be lost right after acceptance (the long-lived prompt).
    lostAfterAcceptance?: boolean;
  }): Promise<T> {
    const { method, envelope } = spec;
    const commandId = envelope.command.id;

    await record(method, envelope, spec.args);

    const existing = receipts.get(commandId);

    if (existing && existing.phase !== "accepted") {
      if (existing.httpStatus >= 400) {
        throw wireError(method, existing.httpStatus, existing.body);
      }

      return replayed(method, existing.body as T);
    }
    const joined = inflight.get(commandId);

    if (joined) {
      const outcome = (await joined) as Outcome<T>;

      return replayed(method, outcome.body);
    }
    if (existing) {
      const turnLost = precondition(
        "the turn for this command id was lost in a host restart",
        { reason: "turn_lost", runId: envelope.fence.runId },
      );

      writeReceipt(envelope, "rejected", 409, errorBodyOf(turnLost));
      throw turnLost;
    }

    const expectedRunId = spec.guard?.();
    const { advanced } = applyFence(envelope, expectedRunId);
    const run = (async (): Promise<Outcome<T>> => {
      writeReceipt(envelope, "accepted", 202, {});
      if (advanced) {
        evictLowerEpochSessions(
          envelope.fence.runId,
          envelope.fence.assignmentEpoch,
        );
      }
      let outcome: Outcome<T>;

      try {
        outcome = await spec.execute();
      } catch (err) {
        // A wire-shaped refusal is the host's own answer (rejected receipt); a
        // bare/unknown-outcome throw is a scripted transport failure — the
        // receipt stays where the script left it.
        const status = httpStatusOf(err);

        if (status !== null && err instanceof MaisterError) {
          if (receipts.get(commandId)?.phase === "accepted") {
            writeReceipt(envelope, "rejected", status, errorBodyOf(err));
          }
        }
        throw err;
      }
      if (receipts.get(commandId)?.phase === "accepted") {
        writeReceipt(
          envelope,
          "completed",
          outcome.status,
          (outcome.body ?? {}) as Record<string, unknown>,
        );
      }

      return outcome;
    })();

    inflight.set(commandId, run as Promise<Outcome<unknown>>);
    void run.then(
      () => inflight.delete(commandId),
      () => inflight.delete(commandId),
    );

    if (spec.lostAfterAcceptance && lostResponses.delete(method)) {
      throw unknownOutcomeError(`response to ${method} lost after acceptance`);
    }
    const outcome = await run;

    if (lostResponses.delete(method)) {
      throw unknownOutcomeError(`response to ${method} lost`);
    }

    return outcome.body;
  }

  // Admin reads: the response can be lost too (no receipt involved).
  const loseAdminResponse = (method: TransportMethod) => {
    if (lostResponses.delete(method)) {
      throw unknownOutcomeError(`response to ${method} lost`);
    }
  };

  // ---- route guards -------------------------------------------------------

  const liveSessionForPrompt = (sessionId: string): FakeSession => {
    const session = sessions.get(sessionId);

    if (!session) throw unknownSessionError(sessionId);
    if (session.status !== "live") {
      throw new MaisterError("PRECONDITION", "fake: session not live", {
        details: { httpStatus: 409 },
      });
    }

    return session;
  };

  const validateMounts = (mounts: unknown) => {
    if (mounts === undefined) return;
    if (!Array.isArray(mounts) || mounts.length > 8) {
      throw precondition("contextMounts: invalid", {});
    }
    for (const mount of mounts as Array<Record<string, unknown>>) {
      const ok =
        mount &&
        typeof mount === "object" &&
        typeof mount.slug === "string" &&
        KEBAB.test(mount.slug) &&
        typeof mount.mountPath === "string" &&
        mount.mountPath.startsWith("/") &&
        !mount.mountPath.split("/").includes("..") &&
        typeof mount.committish === "string" &&
        mount.committish.length >= 7;

      if (!ok) throw precondition("contextMounts: invalid mount", {});
    }
  };

  const transport: FakeTransport = {
    async health(opts) {
      await record("health", null, [opts]);
      loseAdminResponse("health");

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
    async capabilities(opts) {
      await record("capabilities", null, [opts]);
      loseAdminResponse("capabilities");

      return {
        dataPlaneVersion: "execution-host-data-plane.v1",
        eventStream: false,
        asyncPrompt: false,
        runtimeObjects: false,
        limits: {
          maxEventBytes: 1_048_576,
          maxObjectBytes: 26_214_400,
          maxReplayBatch: 500,
        },
      };
    },
    async diagnostics(opts) {
      await record("diagnostics", null, [opts]);
      loseAdminResponse("diagnostics");

      return (
        diagnostics ?? {
          kind: "unavailable",
          reason: "network",
          message: "fake: no diagnostics scripted",
        }
      );
    },
    async platformStatus(opts) {
      await record("platformStatus", null, [opts]);
      loseAdminResponse("platformStatus");
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
    async resolveModelSuggestions(draft, opts) {
      await record("resolveModelSuggestions", null, [draft, opts]);
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "fake: no model catalog scripted",
      );
    },
    async probeMcp(req) {
      await record("probeMcp", null, [req]);
      throw new MaisterError("EXECUTOR_UNAVAILABLE", "fake: no probe scripted");
    },
    // The `GET /sessions` projection (`SessionListEntry`): no host-private
    // path ever leaves the host.
    async listSessions(): Promise<SupervisorSessionRecord[]> {
      await record("listSessions", null, []);
      loseAdminResponse("listSessions");

      return [...sessions.values()].map((s) => ({
        sessionId: s.sessionId,
        adapter: s.adapter ?? "claude",
        runId: s.runId,
        projectSlug:
          s.projectSlug ??
          workspaces.get(s.executionWorkspaceId)?.projectSlug ??
          "fake",
        stepId: s.stepId,
        nodeAttemptId: s.nodeAttemptId,
        sessionName: s.sessionName ?? "default",
        status: s.status,
        pid: 4242,
        startedAt: s.startedAt ?? new Date(0).toISOString(),
        exitedAt: s.exitedAt,
        exitCode: s.exitCode,
        signal: null,
        monotonicId,
        acpSessionId: s.acpSessionId,
        executionWorkspaceId: s.executionWorkspaceId,
        assignmentId: s.assignmentId,
        assignmentEpoch: s.assignmentEpoch,
        createdByCommandId: s.createdByCommandId,
      }));
    },
    // Per-session event queue: yields what `pushEvent` scripted (plus the
    // shared `setStreamEvents` script on the first stream of a session), ends
    // on `session.exited|crashed`, `endStream`, or the consumer's abort signal.
    async *streamSession(sessionId, opts) {
      await record("streamSession", null, [sessionId, opts?.lastEventId]);
      const queue = streamQueueFor(sessionId);

      if (scriptedEvents && !queue.scripted) {
        queue.scripted = true;
        for (const event of scriptedEvents) enqueue(sessionId, event);
        if (scriptedEnd) queue.close();
      }
      for (;;) {
        const event = await queue.next(opts?.signal);

        if (event === null) return;
        commandSignals.publishLegacy(event);
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
    async *streamRuntimeEvents(opts) {
      await record("streamRuntimeEvents", null, [opts?.afterSequence]);
      if (opts?.signal?.aborted) return;
    },
    async acknowledgeRuntimeEvents(input) {
      await record("acknowledgeRuntimeEvents", null, [input]);

      return {
        streamId: input.streamId,
        acknowledgedThrough: input.throughSequence,
      };
    },
    async getCommandReceipt(commandId) {
      await record("getCommandReceipt", null, [commandId]);
      loseAdminResponse("getCommandReceipt");
      const published = publishedPromptReceipts.get(commandId);

      if (published) return published;
      const stored = receipts.get(commandId);

      // A canonical terminal receipt is visible only with its event pointer.
      // The scripted ACP result may finish before the queued event publication.
      if (
        canonicalEventSink &&
        stored?.kind === "session.prompt" &&
        stored.phase !== "accepted" &&
        stored.eventId === null
      )
        return {
          ...stored,
          phase: "accepted",
          body: {},
          httpStatus: 202,
          completedAt: null,
          inflight: true,
        };

      return stored
        ? { ...stored, inflight: stored.inflight || inflight.has(commandId) }
        : null;
    },
    async getWorkspace(id) {
      await record("getWorkspace", null, [id]);
      loseAdminResponse("getWorkspace");
      const ws = workspaces.get(id);

      if (!ws) return null;
      const projection: Partial<typeof ws> = { ...ws };

      delete projection.path;

      return projection as WorkspaceRecord;
    },
    async getRuntimeObject(objectId) {
      await record("getRuntimeObject", null, [objectId]);
      loseAdminResponse("getRuntimeObject");

      return runtimeObjects.get(objectId)?.metadata ?? null;
    },
    async getRuntimeObjectContent(
      objectId,
      opts,
    ): Promise<RuntimeObjectContent> {
      await record("getRuntimeObjectContent", null, [objectId, opts]);
      const object = runtimeObjects.get(objectId);

      if (!object?.bytes || object.metadata.state !== "available") {
        throw precondition("fake: runtime object is missing", {
          reason: "runtime_object_missing",
        });
      }
      const start = opts?.range?.start ?? 0;
      const end = Math.min(
        opts?.range?.end ?? object.bytes.byteLength - 1,
        object.bytes.byteLength - 1,
      );

      if (start < 0 || end < start) {
        throw precondition("fake: runtime object range is invalid", {
          reason: "runtime_object_range_invalid",
        });
      }

      return {
        bytes: object.bytes.slice(start, end + 1),
        contentRange: opts?.range
          ? `bytes ${start}-${end}/${object.bytes.byteLength}`
          : null,
        contentDigest: object.metadata.sha256
          ? `sha-256=:${Buffer.from(object.metadata.sha256, "hex").toString("base64")}:`
          : null,
      };
    },
    async openRuntimeObjectContent(objectId, opts) {
      const content = await this.getRuntimeObjectContent(objectId, opts);

      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(content.bytes);
            controller.close();
          },
        }),
        contentLength: content.bytes.byteLength,
        contentRange: content.contentRange,
        contentDigest: content.contentDigest,
      };
    },
    reserveRuntimeObject(envelope, opts) {
      return runCommand<RuntimeObjectMetadata>({
        method: "reserveRuntimeObject",
        envelope,
        args: [opts],
        guard: () => envelope.fence.runId,
        execute: async () => {
          const current = runtimeObjects.get(envelope.payload.objectId);

          if (current) return { status: 201, body: current.metadata };
          const metadata: RuntimeObjectMetadata = {
            objectId: envelope.payload.objectId,
            kind: envelope.payload.kind,
            logicalName: envelope.payload.logicalName,
            mimeType: envelope.payload.mimeType,
            sizeBytes: null,
            sha256: null,
            generation: envelope.payload.generation,
            retentionClass: envelope.payload.retentionClass,
            state: "pending",
            createdAt: new Date().toISOString(),
            sealedAt: null,
            expiresAt: envelope.payload.expiresAt ?? null,
            deletedAt: null,
          };

          runtimeObjects.set(metadata.objectId, {
            metadata,
            bytes: null,
            runId: envelope.fence.runId,
          });

          return { status: 201, body: metadata };
        },
      });
    },
    uploadRuntimeObject(input) {
      return runCommand<RuntimeObjectMetadata>({
        method: "uploadRuntimeObject",
        envelope: input.envelope,
        args: [input.objectId, input.bytes],
        guard: () => runtimeObjects.get(input.objectId)?.runId,
        execute: async () => {
          const object = runtimeObjects.get(input.objectId);

          if (!object) {
            throw precondition("fake: runtime object is missing", {
              reason: "runtime_object_missing",
            });
          }
          const digest = createHash("sha256").update(input.bytes).digest("hex");

          if (
            digest !== input.envelope.payload.sha256 ||
            input.bytes.byteLength !== input.envelope.payload.sizeBytes ||
            input.envelope.payload.generation !== object.metadata.generation
          ) {
            throw precondition("fake: runtime object checksum is invalid", {
              reason: "runtime_object_integrity_mismatch",
            });
          }
          const metadata: RuntimeObjectMetadata = {
            ...object.metadata,
            sizeBytes: input.bytes.byteLength,
            sha256: digest,
            state: "available",
            sealedAt: new Date().toISOString(),
          };

          runtimeObjects.set(input.objectId, {
            ...object,
            metadata,
            bytes: input.bytes,
          });

          return { status: 200, body: metadata };
        },
      });
    },
    async deleteRuntimeObject(objectId, envelope, opts) {
      await runCommand<RuntimeObjectMetadata>({
        method: "deleteRuntimeObject",
        envelope,
        args: [objectId, opts],
        guard: () => runtimeObjects.get(objectId)?.runId,
        execute: async () => {
          const object = runtimeObjects.get(objectId);

          if (
            !object ||
            object.metadata.generation !== envelope.payload.generation
          ) {
            throw precondition("fake: runtime object is missing", {
              reason: "runtime_object_missing",
            });
          }
          const metadata: RuntimeObjectMetadata = {
            ...object.metadata,
            state: "deleted",
            deletedAt: new Date().toISOString(),
          };

          runtimeObjects.set(objectId, { ...object, metadata, bytes: null });

          return { status: 204, body: metadata };
        },
      });
    },
    // D7: the ONLY path-bearing route. Idempotent on `(runId, path)` while the
    // handle is live; a released handle's path re-adopts as a NEW handle.
    adoptWorkspace(envelope, opts) {
      return runCommand<AdoptWorkspaceResult>({
        method: "adoptWorkspace",
        envelope,
        args: [opts],
        guard: () => envelope.payload.runId,
        execute: async () => {
          const payload = envelope.payload;

          if (!isSafeSegment(payload.runId)) {
            throw precondition("runId must match /^[A-Za-z0-9._-]+$/", {});
          }
          if (
            typeof payload.projectSlug !== "string" ||
            !KEBAB.test(payload.projectSlug)
          ) {
            throw precondition("projectSlug must be kebab-case", {});
          }
          if (payload.kind === "directory" && payload.repoPath !== undefined) {
            throw precondition(
              "repoPath is forbidden for a directory workspace",
              {},
            );
          }
          if (payload.kind !== "directory" && payload.repoPath === undefined) {
            throw precondition(
              `repoPath is required for a ${payload.kind} workspace`,
              {},
            );
          }
          validateMounts(payload.contextMounts);
          for (const candidate of [payload.path, payload.repoPath]) {
            if (candidate === undefined) continue;
            if (!candidate.startsWith("/")) {
              throw precondition(
                `workspace path rejected: relative_path (${candidate})`,
                {
                  reason: "workspace_rejected",
                  rule: "relative_path",
                },
              );
            }
            if (candidate.split("/").includes("..")) {
              throw precondition(
                `workspace path rejected: parent_segment (${candidate})`,
                {
                  reason: "workspace_rejected",
                  rule: "parent_segment",
                },
              );
            }
          }
          const existing = [...workspaces.values()].find(
            (w) =>
              w.runId === payload.runId &&
              w.path === payload.path &&
              !w.releasedAt,
          );
          const id =
            existing?.executionWorkspaceId ??
            asExecutionWorkspaceId(`ws_${randomUUID().replace(/-/g, "")}`);

          if (!existing) {
            workspaces.set(id, {
              executionWorkspaceId: id,
              runId: payload.runId,
              projectSlug: payload.projectSlug,
              kind: payload.kind,
              adoptedAt: new Date().toISOString(),
              releasedAt: null,
              path: payload.path,
            });
          }

          return {
            status: 200,
            body: {
              executionWorkspaceId: id,
              kind: payload.kind,
              replayed: Boolean(existing),
            },
          };
        },
      });
    },
    async releaseWorkspace(id, envelope, opts) {
      const ws = workspaces.get(id);

      // Like the wire: an unknown handle's 404 is the `released:false` outcome.
      if (!ws) {
        await record("releaseWorkspace", envelope, [id, opts]);
        loseAdminResponse("releaseWorkspace");

        return { released: false };
      }

      return runCommand<{ released: boolean }>({
        method: "releaseWorkspace",
        envelope,
        args: [id, opts],
        guard: () => ws.runId,
        execute: async () => {
          const released = !ws.releasedAt;

          if (released) ws.releasedAt = new Date().toISOString();

          return { status: 200, body: { released } };
        },
      });
    },
    createSession(envelope: CommandEnvelope<CreateSessionPayload>, opts) {
      return runCommand<CreateSessionResult>({
        method: "createSession",
        envelope,
        args: [opts],
        guard: () => {
          const ws = workspaces.get(envelope.payload.executionWorkspaceId);

          if (!ws) throw unknownWorkspaceError();
          if (ws.releasedAt) throw workspaceReleasedError(ws.runId);

          return ws.runId;
        },
        execute: async () => {
          const payload = envelope.payload;

          for (const field of [
            "stepId",
            "nodeAttemptId",
            "sessionName",
            "resumeSessionId",
          ] as const) {
            const value = payload[field];

            if (value !== undefined && !isSafeSegment(value)) {
              throw precondition(`${field} must match /^[A-Za-z0-9._-]+$/`, {});
            }
          }
          const ws = workspaces.get(payload.executionWorkspaceId)!;

          if (payload.capabilityProfileObjectId) {
            const profile = runtimeObjects.get(
              payload.capabilityProfileObjectId,
            );

            if (
              !profile ||
              profile.runId !== envelope.fence.runId ||
              profile.metadata.state !== "available" ||
              profile.metadata.kind !== "capability_profile"
            ) {
              throw precondition("fake: capability profile is missing", {
                reason: "runtime_object_missing",
              });
            }
          }
          if (payload.capabilityInstructionsObjectId) {
            const instructions = runtimeObjects.get(
              payload.capabilityInstructionsObjectId,
            );

            if (
              !instructions ||
              instructions.runId !== envelope.fence.runId ||
              instructions.metadata.state !== "available" ||
              instructions.metadata.kind !== "capability_instructions"
            ) {
              throw precondition("fake: capability instructions are missing", {
                reason: "runtime_object_missing",
              });
            }
          }
          for (const output of payload.outputObjects ?? []) {
            const existing = runtimeObjects.get(output.objectId);

            if (existing) {
              const sameBinding =
                existing.runId === envelope.fence.runId &&
                existing.metadata.kind === output.kind &&
                existing.metadata.logicalName === output.logicalName &&
                existing.metadata.mimeType === output.mimeType &&
                existing.metadata.generation === output.generation &&
                existing.metadata.retentionClass === output.retentionClass;

              if (!sameBinding) {
                throw precondition("fake: runtime output binding conflicts", {
                  reason: "command_invariant_conflict",
                });
              }
              continue;
            }
            runtimeObjects.set(output.objectId, {
              runId: envelope.fence.runId,
              bytes: null,
              metadata: {
                objectId: output.objectId,
                kind: output.kind,
                logicalName: output.logicalName,
                mimeType: output.mimeType,
                sizeBytes: null,
                sha256: null,
                generation: output.generation,
                retentionClass: output.retentionClass,
                state: "pending",
                createdAt: new Date().toISOString(),
                sealedAt: null,
                expiresAt: output.expiresAt ?? null,
                deletedAt: null,
              },
            });
          }
          const session: FakeSession = {
            sessionId: randomUUID(),
            runId: envelope.fence.runId,
            projectSlug: ws.projectSlug,
            stepId: payload.stepId ?? "fake",
            nodeAttemptId: payload.nodeAttemptId,
            sessionName: payload.sessionName ?? "default",
            adapter: payload.runner?.adapter ?? payload.executor.agent,
            // Like the host: a resume restores the SAME ACP conversation.
            acpSessionId: payload.resumeSessionId ?? `acp-${randomUUID()}`,
            executionWorkspaceId: ws.executionWorkspaceId,
            assignmentId: envelope.fence.assignmentId,
            assignmentEpoch: envelope.fence.assignmentEpoch,
            createdByCommandId: envelope.command.id,
            status: "live",
            startedAt: new Date().toISOString(),
            pending: new Set(),
            runtimeOutputObjectIds: payload.outputObjects?.map(
              (output) => output.objectId,
            ),
          };

          sessions.set(session.sessionId, session);
          await publishCanonical(envelope, session.sessionId, {
            type: "session.created",
            createdByCommandId: envelope.command.id,
            sessionId: session.sessionId,
            monotonicId: ++monotonicId,
            sessionName: session.sessionName ?? "default",
            acpSessionId: session.acpSessionId,
          });

          return {
            status: 201,
            body: {
              sessionId: session.sessionId,
              pid: 4242,
              acpSessionId: session.acpSessionId,
            },
          };
        },
      });
    },
    sendPrompt(sessionId, envelope, opts) {
      return runCommand<PromptResult>({
        method: "sendPrompt",
        envelope,
        args: [sessionId, opts],
        lostAfterAcceptance: true,
        guard: () => {
          if (!isSafeSegment(envelope.payload.stepId)) {
            throw precondition("stepId must match /^[A-Za-z0-9._-]+$/", {});
          }

          return liveSessionForPrompt(sessionId).runId;
        },
        execute: async () => {
          const session = sessions.get(sessionId)!;

          session.stepId = envelope.payload.stepId;
          if (envelope.payload.nodeAttemptId) {
            session.nodeAttemptId = envelope.payload.nodeAttemptId;
          }
          const ctx: PromptContext = {
            sessionId,
            envelope,
            setReceipt: (phase, body, inflightFlag = false) => {
              writeReceipt(
                envelope,
                phase,
                phase === "rejected" ? 409 : phase === "accepted" ? 202 : 200,
                body,
              );
              if (inflightFlag) {
                receipts.get(envelope.command.id)!.inflight = true;
              }
            },
            emit: (phase, extra) => {
              monotonicId += 1;
              commandSignals.publishLegacy({
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
          const turn = { reject: (_err: MaisterError) => {} };
          const settled = new Promise<never>((_, reject) => {
            turn.reject = reject;
          });
          let turns = inflightPrompts.get(sessionId);

          if (!turns) {
            turns = new Set();
            inflightPrompts.set(sessionId, turns);
          }
          turns.add(turn);
          let result: PromptResult;

          try {
            result = await Promise.race([promptBehavior(ctx), settled]);
          } finally {
            turns.delete(turn);
            if (turns.size === 0) inflightPrompts.delete(sessionId);
          }
          // X-EH-19: a session evicted mid-turn answers FENCED, never a stop
          // reason — even when the scripted turn completed.
          if (session.fencedByEpoch !== undefined) {
            throw fencedError(
              session.runId,
              envelope.fence.assignmentEpoch,
              session.fencedByEpoch,
            );
          }

          const sealedRuntimeObjects = (
            session.runtimeOutputObjectIds ?? []
          ).map((objectId) => {
            const object = runtimeObjects.get(objectId);
            const bytes = runtimeOutputWrites.get(objectId);

            if (!object || !bytes) {
              throw precondition("fake: runtime output is missing", {
                reason: "runtime_object_missing",
              });
            }
            const sha256 = createHash("sha256").update(bytes).digest("hex");
            const metadata: RuntimeObjectMetadata = {
              ...object.metadata,
              sizeBytes: bytes.byteLength,
              sha256,
              state: "available",
              sealedAt: new Date().toISOString(),
            };

            runtimeObjects.set(objectId, {
              ...object,
              bytes,
              metadata,
            });

            return metadata;
          });

          return {
            status: 200,
            body:
              sealedRuntimeObjects.length > 0
                ? { ...result, runtimeObjects: sealedRuntimeObjects }
                : result,
          };
        },
      });
    },
    async startPrompt(sessionId, envelope, opts) {
      await record("startPrompt", envelope, [sessionId, opts]);
      liveSessionForPrompt(sessionId);
      await publishCanonical(envelope, sessionId, {
        type: "session.command",
        sessionId,
        monotonicId: ++monotonicId,
        commandId: envelope.command.id,
        kind: "session.prompt",
        phase: "accepted",
      });
      activePromptEnvelopes.set(sessionId, envelope);

      // Admission is the short HTTP phase. The scripted ACP turn starts only
      // after this promise settles, then publishes the same durable terminal
      // event path as the real host. Graph integration tests therefore exercise
      // the canonical manager ledger instead of a test-only synchronous prompt.
      setTimeout(() => {
        void transport
          .sendPrompt(sessionId, envelope, opts)
          .then(
            async (result) => {
              const scripted = scriptedCanonicalSessions.has(sessionId)
                ? []
                : (scriptedEvents ?? []);

              scriptedCanonicalSessions.add(sessionId);
              for (const event of scripted) {
                await publishCanonical(envelope, sessionId, event);
              }
              await publishCanonical(envelope, sessionId, {
                type: "session.command",
                sessionId,
                monotonicId: ++monotonicId,
                commandId: envelope.command.id,
                kind: "session.prompt",
                phase: "completed",
                status: "succeeded",
                result,
              });
            },
            async (error: unknown) => {
              const unknownOutcome =
                isMaisterError(error) &&
                error.details?.transport === UNKNOWN_OUTCOME_DETAIL;
              const observed = receipts.get(envelope.command.id);
              let terminalStatus: "succeeded" | "failed" | "fenced";
              let terminalResult: Record<string, unknown> | undefined;
              let terminalError: Record<string, unknown> | undefined;

              if (unknownOutcome && observed?.phase === "completed") {
                terminalStatus = "succeeded";
                terminalResult = observed.body;
              } else if (observed?.phase === "rejected") {
                terminalStatus =
                  observed.body.code === "FENCED" ? "fenced" : "failed";
                terminalError = observed.body;
              } else {
                const failure =
                  unknownOutcome && observed?.phase === "accepted"
                    ? precondition(
                        "the accepted prompt turn was lost before completion",
                        {
                          reason: "turn_lost",
                          runId: envelope.fence.runId,
                        },
                      )
                    : isMaisterError(error)
                      ? error
                      : new MaisterError(
                          "ACP_PROTOCOL",
                          error instanceof Error
                            ? error.message
                            : String(error),
                        );

                terminalError = errorBodyOf(failure);
                terminalStatus =
                  terminalError.code === "FENCED" ? "fenced" : "failed";
                writeReceipt(
                  envelope,
                  "rejected",
                  httpStatusOf(failure) ?? 500,
                  terminalError,
                );
              }

              await publishCanonical(envelope, sessionId, {
                type: "session.command",
                sessionId,
                monotonicId: ++monotonicId,
                commandId: envelope.command.id,
                kind: "session.prompt",
                phase: "completed",
                status: terminalStatus,
                ...(terminalResult ? { result: terminalResult } : {}),
                ...(terminalError
                  ? {
                      error: terminalError as {
                        code: string;
                        message: string;
                        details?: Record<string, unknown>;
                      },
                    }
                  : {}),
              });
            },
          )
          .finally(() => activePromptEnvelopes.delete(sessionId));
      }, 0);

      return { commandId: envelope.command.id, state: "accepted" as const };
    },
    deliverInput(sessionId, envelope, opts) {
      return runCommand<InputDeliveryResult>({
        method: "deliverInput",
        envelope,
        args: [sessionId, opts],
        guard: () => {
          const session = sessions.get(sessionId);

          if (!session) throw inputUnknownSessionError(sessionId);

          return session.runId;
        },
        execute: async () => {
          const session = sessions.get(sessionId)!;
          const { requestId } = envelope.payload;
          // A transport-created session knows its deferreds; an injected live
          // record accepts any id (its pending set is unknown to the fake).
          const ok =
            session.status === "live" &&
            (session.pending === undefined ||
              session.pending.delete(requestId));

          if (!ok) throw hitlTimeoutError();

          return { status: 200, body: { ok: true, replayed: false } };
        },
      });
    },
    cancelPrompt(sessionId, envelope, opts) {
      return runCommand<{ cancelled: boolean }>({
        method: "cancelPrompt",
        envelope,
        args: [sessionId, opts],
        guard: () => {
          const session = sessions.get(sessionId);

          if (!session) throw unknownSessionError(sessionId);

          return session.runId;
        },
        execute: async () => {
          const session = sessions.get(sessionId)!;

          if (session.status !== "live") {
            return { status: 200, body: { cancelled: false } };
          }
          session.pending?.clear();

          return { status: 200, body: { cancelled: true } };
        },
      });
    },
    checkpointSession(sessionId, envelope, opts) {
      return runCommand<CheckpointResult>({
        method: "checkpointSession",
        envelope,
        args: [sessionId, opts],
        guard: () => {
          const session = sessions.get(sessionId);

          if (!session) throw unknownSessionError(sessionId);

          return session.runId;
        },
        execute: async () => {
          const session = sessions.get(sessionId)!;

          if (session.status !== "live") {
            monotonicId += 1;

            return {
              status: 200,
              body: { alreadyCheckpointed: true, sessionId, monotonicId },
            };
          }
          // Cancel every open deferred (the adapter journals them for
          // resume), SIGTERM the adapter: its in-flight turn answers a closed
          // connection and its stream ends with reason "checkpoint".
          session.pending?.clear();
          session.status = "exited";
          session.exitedAt = new Date().toISOString();
          session.exitCode = 143;
          settleInflightPrompts(
            sessionId,
            new MaisterError(
              "ACP_PROTOCOL",
              "fake: ACP connection closed by checkpoint",
              { details: { httpStatus: 500 } },
            ),
          );
          const event = exitEvent(sessionId, "checkpoint");

          enqueue(sessionId, event);
          await publishCanonical(envelope, sessionId, event);
          monotonicId += 1;

          return {
            status: 200,
            body: { alreadyCheckpointed: false, sessionId, monotonicId },
          };
        },
      });
    },
    async deleteSession(sessionId, envelope, opts) {
      const session = sessions.get(sessionId);

      // Like the wire: the 404 of an unknown session is the `gone` outcome.
      if (!session) {
        await record("deleteSession", envelope, [sessionId, opts]);
        loseAdminResponse("deleteSession");

        return { outcome: "gone" };
      }

      return runCommand<{ outcome: DeleteSessionOutcome }>({
        method: "deleteSession",
        envelope,
        args: [sessionId, opts],
        guard: () => session.runId,
        execute: async () => {
          if (session.status === "live") {
            session.pending?.clear();
            session.status = "exited";
            session.exitedAt = new Date().toISOString();
            session.exitCode = 143;
            settleInflightPrompts(
              sessionId,
              new MaisterError(
                "ACP_PROTOCOL",
                "fake: ACP connection closed by delete",
                { details: { httpStatus: 500 } },
              ),
            );
            const event = exitEvent(sessionId, "intentional");

            enqueue(sessionId, event);
            await publishCanonical(envelope, sessionId, event);
          }

          return { status: 204, body: { outcome: "terminated" } };
        },
      });
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
      if (method === "streamSession") {
        throw new Error(
          "fake execution host: loseResponseOnce does not apply to streamSession",
        );
      }
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
    publishCanonical,
    setCanonicalEventSink(sink) {
      canonicalEventSink = sink;
    },
    async waitForCanonicalEvents() {
      for (;;) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const observedTail = canonicalEventTail;

        await observedTail;
        if (
          activePromptEnvelopes.size === 0 &&
          observedTail === canonicalEventTail
        ) {
          return;
        }
      }
    },
    publishPromptReceipt(receipt) {
      publishedPromptReceipts.set(receipt.commandId, receipt);
    },
    sealPromptJson(runId, value) {
      const bytes = Uint8Array.from(
        Buffer.from(canonicalCommandJson(value), "utf8"),
      );
      const reference = {
        objectId: randomUUID(),
        generation: 1,
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      const now = new Date().toISOString();

      runtimeObjects.set(reference.objectId, {
        runId,
        bytes,
        metadata: {
          ...reference,
          kind: "diagnostic",
          logicalName: "command-output.json",
          mimeType: "application/json",
          retentionClass: "run",
          state: "available",
          createdAt: now,
          sealedAt: now,
          expiresAt: null,
          deletedAt: null,
        },
      });

      return reference;
    },
    writeRuntimeOutput(objectId, bytes) {
      runtimeOutputWrites.set(objectId, Uint8Array.from(bytes));
    },
    restart() {
      identity.bootId = randomUUID();
      // Every in-flight turn dies with the process: the caller's request
      // breaks (unknown outcome), the receipt stays `accepted` and is no
      // longer in flight — the turn_lost signature.
      for (const sessionId of [...inflightPrompts.keys()]) {
        settleInflightPrompts(
          sessionId,
          unknownOutcomeError("fake: host restarted mid-turn"),
        );
      }
      inflight.clear();
      sessions.clear();
    },
    monotonic: () => monotonicId,
    pushEvent(sessionId, event) {
      enqueue(sessionId, event);
      const envelope = activePromptEnvelopes.get(sessionId);

      if (envelope) void publishCanonical(envelope, sessionId, event);
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
  const { ingestRuntimeEvent } = await import(
    "@/lib/execution-host/events/ingest"
  );
  const { projectCanonicalPromptCommands } = await import(
    "@/lib/execution-host/events/prompt-projector"
  );
  const { projectCanonicalSessionLifecycle } = await import(
    "@/lib/execution-host/events/lifecycle-projector"
  );
  const {
    RUNTIME_EVENT_PAYLOAD_SCHEMAS,
    RUNTIME_EVENT_TYPES,
    redactRuntimeEventPayload,
  } = await import("@/lib/execution-host/runtime-events");

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
  // The default fake deliberately advertises no host event stream so lazy
  // registration cannot start an unrelated background consumer in integration
  // suites. This helper supplies canonical events directly to the manager sink,
  // so persist the capabilities that its DB-backed execution boundary provides.
  await db
    .update(executionHosts)
    .set({
      capabilities: {
        protocolVersion: 1,
        supervisorVersion: "fake",
        adapters: [],
        dataPlane: {
          version: "execution-host-data-plane.v1",
          eventStream: true,
          asyncPrompt: true,
          runtimeObjects: true,
          limits: {
            maxEventBytes: 1_048_576,
            maxObjectBytes: 26_214_400,
            maxReplayBatch: 500,
          },
        },
      },
    })
    .where(eq(executionHosts.id, hostId));
  const [host] = await db
    .select()
    .from(executionHosts)
    .where(eq(executionHosts.id, hostId));

  primeResolverForTests(host);

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

  let canonicalStreamState = canonicalStreamStates.get(fake);

  if (!canonicalStreamState) {
    canonicalStreamState = {
      bootId: fake.identity.bootId,
      streamId: randomUUID(),
      nextSequence: 0n,
    };
    canonicalStreamStates.set(fake, canonicalStreamState);
  }
  const payloadSchemas = new Map(
    RUNTIME_EVENT_TYPES.map((eventType, index) => [
      eventType,
      RUNTIME_EVENT_PAYLOAD_SCHEMAS[index],
    ]),
  );

  const acceptedPrompts = new Map<
    string,
    { sequence: string; receivedAt: string }
  >();

  fake.setCanonicalEventSink(
    async ({ envelope, sessionId, event, eventId }) => {
      if (canonicalStreamState.bootId !== fake.identity.bootId) {
        canonicalStreamState.bootId = fake.identity.bootId;
        canonicalStreamState.streamId = randomUUID();
        canonicalStreamState.nextSequence = 0n;
      }
      const eventType = event.type;
      let payloadSchema = payloadSchemas.get(eventType);

      if (!payloadSchema) {
        throw new Error(
          `fake canonical event type is unsupported: ${eventType}`,
        );
      }
      const eventPayload = Object.fromEntries(
        Object.entries(event).filter(
          ([key]) => !["type", "sessionId", "monotonicId"].includes(key),
        ),
      );
      const session = fake.sessions.get(sessionId);
      const wireV2 = envelope.requestVersion === 2;
      let payload: Record<string, unknown> = wireV2
        ? {
            sourceMonotonicId: event.monotonicId,
            sourceCommandId: envelope.command.id,
            sessionName: session?.sessionName ?? "default",
            ...(session?.nodeAttemptId
              ? { nodeAttemptId: session.nodeAttemptId }
              : {}),
            ...eventPayload,
          }
        : redactRuntimeEventPayload({
            sourceMonotonicId: event.monotonicId,
            ...eventPayload,
          });
      const currentSequence = canonicalStreamState.nextSequence;

      canonicalStreamState.nextSequence += 1n;
      if (wireV2 && event.type === "session.command") {
        const request = storePromptRequest({
          envelope: envelope as CommandEnvelope<SendPromptInput>,
          targetSessionId: sessionId,
        });
        const position = {
          eventId,
          streamId: canonicalStreamState.streamId,
          sequence: currentSequence.toString(),
        };

        if (event.phase === "accepted")
          acceptedPrompts.set(envelope.command.id, {
            sequence: position.sequence,
            receivedAt: new Date().toISOString(),
          });
        const accepted = acceptedPrompts.get(envelope.command.id);

        if (!accepted) throw new Error("fake prompt has no accepted event");
        let terminal: CommandTerminalEvidenceV2 | null = null;

        if (event.phase === "completed") {
          let result: Record<string, unknown> | null = event.result ?? null;

          if (event.status === "succeeded" && result) {
            const response = fake.sealPromptJson(envelope.fence.runId, {
              schema: "maister.command-response.v2",
              commandId: envelope.command.id,
              hostSessionId: sessionId,
              requestSha256: request.requestSha256,
              response: result,
            });
            const manifest = {
              schema: "maister.command-output.v2",
              commandId: envelope.command.id,
              ...envelope.fence,
              hostSessionId: sessionId,
              requestSha256: request.requestSha256,
              streamId: position.streamId,
              acceptedSequence: accepted.sequence,
              terminalSequence: position.sequence,
              response,
            };
            const output = fake.sealPromptJson(envelope.fence.runId, manifest);

            result = {
              stopReason: result.stopReason,
              ...(result.runtimeObjects
                ? { runtimeObjects: result.runtimeObjects }
                : {}),
              output: {
                ...output,
                commandId: envelope.command.id,
                hostSessionId: sessionId,
                acceptedSequence: accepted.sequence,
                terminalSequence: position.sequence,
              },
            };
          }
          terminal = {
            outcomeVersion: 2,
            status: event.status ?? "failed",
            ...position,
            result,
            error: event.error ?? null,
          };
        }
        const receiptPhase = !terminal
          ? ("accepted" as const)
          : terminal.status === "succeeded"
            ? ("completed" as const)
            : ("rejected" as const);

        payloadSchema = "maister.session.command.v2";
        payload = {
          sourceMonotonicId: event.monotonicId,
          sessionName: session?.sessionName ?? "default",
          ...(session?.nodeAttemptId
            ? { nodeAttemptId: session.nodeAttemptId }
            : {}),
          commandId: envelope.command.id,
          kind: "session.prompt",
          // Receipt semantics, not the wire event's phase: the evidence parser
          // validates this field as the receipt phase, so a failed or fenced
          // terminal is `rejected` even though the host reports the event as a
          // completed command carrying a non-succeeded status.
          phase: receiptPhase,
          sourceCommandId: envelope.command.id,
          requestSchema: request.requestSchema,
          requestSha256: request.requestSha256,
          terminal,
        };
        fake.publishPromptReceipt(
          normalizeCommandReceiptV2({
            receiptVersion: 2,
            commandId: envelope.command.id,
            kind: "session.prompt",
            ...envelope.fence,
            hostSessionId: sessionId,
            requestSchema: request.requestSchema,
            requestSha256: request.requestSha256,
            phase: receiptPhase,
            httpStatus: !terminal
              ? 202
              : terminal.status === "succeeded"
                ? 200
                : 409,
            receivedAt: accepted.receivedAt,
            terminal,
          }),
        );
      }
      await ingestRuntimeEvent({
        db,
        executionHostId: hostId,
        envelope: {
          envelopeVersion: 1,
          eventId,
          hostKey: fake.identity.hostKey,
          hostBootId: fake.identity.bootId,
          streamId: canonicalStreamState.streamId,
          sequence: currentSequence.toString(),
          runId: envelope.fence.runId,
          assignmentId: envelope.fence.assignmentId,
          assignmentEpoch: envelope.fence.assignmentEpoch,
          hostSessionId: sessionId,
          eventType,
          occurredAt: new Date().toISOString(),
          payloadSchema,
          payload,
        },
      });
      await Promise.all([
        projectCanonicalPromptCommands({
          db,
          runId: envelope.fence.runId,
        }),
        projectCanonicalSessionLifecycle({
          db,
          runId: envelope.fence.runId,
        }),
      ]);
    },
  );

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
  const promptCompletions = new Map<string, Promise<PromptResult>>();
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
        // X-EH-11/X-EH-12: like the real client, re-adopt ONCE.
        if (!isReadoptableWorkspaceError(err)) throw err;

        return attempt(await client.ensureWorkspace({ force: true }));
      }
    },
    async createOwnedSession() {
      throw new MaisterError(
        "PRECONDITION",
        "durable create recovery requires the Postgres-backed execution client",
      );
    },
    async prompt(sessionId, input, opts) {
      const env = envelope("session.prompt", input);
      const completion = fake.transport.sendPrompt(sessionId, env, {
        signal: opts?.signal,
      });

      promptCompletions.set(env.command.id, completion);

      return {
        commandId: env.command.id,
      };
    },
    async waitForPrompt(handle) {
      const completion = promptCompletions.get(handle.commandId);

      if (!completion) {
        throw new MaisterError(
          "PRECONDITION",
          "prompt command is not available",
          {
            details: {
              reason: "prompt_command_missing",
              commandId: handle.commandId,
            },
          },
        );
      }

      return completion;
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
    async reattachPermissionInput() {
      throw new MaisterError(
        "PRECONDITION",
        "durable permission replay requires the Postgres-backed test client",
      );
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
    reserveRuntimeObject: (payload) =>
      fake.transport.reserveRuntimeObject(
        envelope("runtime_object.reserve", payload),
      ),
    uploadRuntimeObject: (input) =>
      fake.transport.uploadRuntimeObject({
        objectId: input.objectId,
        envelope: envelope("runtime_object.upload", {
          generation: input.generation,
          sizeBytes: input.bytes.byteLength,
          sha256: input.sha256,
        }),
        bytes: input.bytes,
      }),
    deleteRuntimeObject: (input) =>
      fake.transport.deleteRuntimeObject(
        input.objectId,
        envelope("runtime_object.delete", { generation: input.generation }),
      ),
  };

  return client;
}

export function memoryAdminClient(fake: FakeExecutionHost): HostAdminClient {
  return {
    health: (opts) => fake.transport.health(opts),
    diagnostics: (opts) => fake.transport.diagnostics(opts),
    platformStatus: (opts) => fake.transport.platformStatus(opts),
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
// touch Postgres (workbench lifecycle). One assignment per run, like the
// run's ACTIVE assignment: a second `forRun` of the same run binds the same
// generation instead of minting a competing one the fence would refuse.
export function memoryExecutionHosts(fake: FakeExecutionHost): ExecutionHosts {
  const host = memoryHost(fake);
  const assignments = new Map<string, ExecutionAssignment>();
  const admin = memoryAdminClient(fake);
  const forRun = async (runId: string) => {
    let assignment = assignments.get(runId);

    if (!assignment) {
      assignment = memoryAssignment({ runId, hostId: host.id });
      assignments.set(runId, assignment);
    }

    return memoryBoundClient({ fake, runId, assignment, host });
  };
  const forAssignment = async (
    assignment: ExecutionAssignment | { id: string },
  ) =>
    memoryBoundClient({
      fake,
      runId: (assignment as ExecutionAssignment).runId ?? "run-memory",
      assignment: assignment as ExecutionAssignment,
      host,
    });

  return {
    transport: fake.transport,
    forAssignment,
    forRun,
    async executionFor(runId, opts) {
      const client = opts?.assignmentId
        ? await forAssignment({ id: opts.assignmentId })
        : await forRun(runId);

      return { client, admin };
    },
    local: () => admin,
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
