/* eslint-disable no-console */
// M37 (ADR-098) — a REAL HTTP test supervisor that drives the orchestrator
// engine's full delegate→park→resume→complete loop through the REAL
// supervisor-client HTTP wire (lib/supervisor-client.ts). Unlike the unit
// integration tests that mock the supervisor seam, this server is hit over
// HTTP+SSE exactly as the production supervisor is, so the real
// supervisor-client serializer + the real SSE frame parser + the real
// runner/launch session consumers all execute.
//
// It SIMULATES the agent IN-PROCESS — no adapter subprocess, no ACP stdio:
//   • run_kind='flow' (an orchestrator node session), turn 0 (no resume): it
//     reads the maister facade token from the createSession `mcpServers`
//     payload and spawns N children (default 2) by invoking the SAME
//     delegation surface the agent's MCP facade would (the ext
//     /api/v1/ext/runs/delegate route, mode:"run"). It then emits
//     `session.exited {exitCode:0}` — the clean end_turn the graph runner
//     reads (with pending children → park on WaitingOnChildren).
//   • run_kind='flow' resume turn (createSession carried `resumeSessionId`):
//     the goal is met, so it emits `session.exited {exitCode:0}` immediately
//     with no new children → the orchestrator node completes → flow terminal.
//   • run_kind='agent' (a delegated CHILD): it emits `session.exited
//     {exitCode:0}` immediately → consumeAgentSession finalizes the child to
//     Done (workspace=none) → run.done domain event with parent_run_id set.
//
// run_kind is looked up by the createSession `runId` against the pg pool the
// caller wires in. A monotonic counter feeds the SSE `id:` + each event's
// `monotonicId`.
//
// It is a SUPERSET of stub-supervisor.ts: /health, /diagnostics,
// /model-catalog/resolve answer the same ready
// shapes, so an e2e suite can point MAISTER_SUPERVISOR_URL at this server for
// EVERY spec without breaking the ones that never spawn an agent.
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import type { AgentMcpServer } from "@/lib/capabilities/agent-map";

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";

import { E2E_EXECUTION_HOST_SLUG } from "./fixtures";
import {
  STUB_BOOT_ID,
  STUB_HOST_KEY,
  stubAdopt,
  stubEnvelope,
  stubExitSession,
  stubFence,
  stubFencedExitEvent,
  stubHandle,
  stubPayload,
  stubReceipt,
  stubRecord,
  stubRegisterSession,
  stubRelease,
  MISSING_ENVELOPE_BODY,
  stubReplay,
  stubResolveCreate,
  stubSessionListEntry,
  stubSessions,
} from "./stub-supervisor";

const STUB_RELEASE_BACKSTOP_MS = 15_000;
const STUB_RELEASE_POLL_MS = 150;
const STAGE_B_STREAM_ID = "9de93d52-7097-44df-977f-d912143f09e8";

const EVENT_PAYLOAD_SCHEMAS = {
  "session.created": "maister.session.created.v1",
  "session.line": "maister.session.line.v1",
  "session.update": "maister.session.update.v1",
  "session.permission_request": "maister.session.permission-request.v1",
  "session.hook_trip": "maister.session.hook-trip.v1",
  "session.command": "maister.session.command.v1",
  "session.chat_turn": "maister.session.chat-turn.v1",
  "session.exited": "maister.session.exited.v1",
  "session.crashed": "maister.session.crashed.v1",
  "usage.recorded": "maister.usage.recorded.v1",
  "runtime_object.available": "maister.runtime-object.available.v1",
  "runtime_object.state": "maister.runtime-object.state.v1",
} as const;

type StageBEventType = keyof typeof EVENT_PAYLOAD_SCHEMAS;
type StageBEnvelope = {
  envelopeVersion: 1;
  eventId: string;
  hostKey: string;
  hostBootId: string;
  streamId: string;
  sequence: string;
  runId: string;
  assignmentId: string;
  assignmentEpoch: number;
  hostSessionId: string | null;
  eventType: StageBEventType;
  occurredAt: string;
  payloadSchema: (typeof EVENT_PAYLOAD_SCHEMAS)[StageBEventType];
  payload: Record<string, unknown>;
};

type TestRuntimeObject = {
  runId: string;
  assignmentId: string;
  assignmentEpoch: number;
  metadata: {
    objectId: string;
    kind: string;
    logicalName: string;
    mimeType: string;
    sizeBytes: number | null;
    sha256: string | null;
    generation: number;
    retentionClass: string;
    state: "pending" | "available" | "deleted";
    createdAt: string;
    sealedAt: string | null;
    expiresAt: string | null;
    deletedAt: string | null;
  };
  bytes: Uint8Array | null;
};

// ADR-165 — the seeded RAH flow refs (e2e/_seed/seed-e2e.ts) this supervisor
// branches on to build a depth-2 tree.
const RAH_ROOT_FLOW_REF = "e2e-rah-root";
const RAH_RESEARCH_FLOW_REF = "e2e-rah-research";
const RAH_RESULT_PROFILE = "research";

// ---- the delegation hook (the node-test vs browser-e2e substitution) --------
//
// In the BROWSER e2e the agent's MCP facade would POST the ext delegate route
// over HTTP; Next IS served there, so the default hook does exactly that
// (real route, real auth, real launchAgentRun). In the NODE loop test the ext
// route is NOT served (vitest has no Next server), so the test injects a hook
// that invokes the delegation SERVICE the route calls directly (launchAgentRun
// with the parent/root linkage looked up from the DB). Either way the
// supervisor-client HTTP wire above stays REAL.
export type DelegateRequest = {
  // The orchestrator run whose session is spawning children.
  orchestratorRunId: string;
  // The maister facade token read from the createSession mcpServers payload.
  facadeToken: string | null;
  // The facade base URL read from the same payload (browser hook targets it).
  apiBaseUrl: string | null;
  // 0-based child index (a sub-task ordinal).
  index: number;
  prompt: string;
  // ADR-163 / ADR-165: resolves what THIS orchestrator delegates — the in-repo
  // delegated flow, an RAH research flow, or the default agent — plus the
  // `resultProfile` an RAH agent child is delegated under. A per-run lookup
  // rather than an env var, because every orchestrator spec shares one
  // supervisor process and a global switch would flip the others' children too.
  resolveDelegation?: () => Promise<DelegationTarget>;
};

/** What one delegation asks for: an agent or a flow, optionally under a profile. */
export type DelegationTarget = {
  target: { agentId?: string; flowId?: string };
  resultProfile?: string;
};

export type DelegateHook = (req: DelegateRequest) => Promise<void>;

type SessionRecord = {
  sessionId: string;
  acpSessionId: string;
  runId: string;
  runKind: "flow" | "scratch" | "agent" | "unknown";
  isResume: boolean;
  mcpServers: AgentMcpServer[];
  sessionName: string;
  nodeAttemptId?: string;
  // Set once the agent's turn is decided complete (on sendPrompt). The stream
  // handler flushes it as a `session.exited` frame the moment it is connected;
  // queuing here decouples the prompt POST from the stream GET race.
  exitPending: boolean;
  // ADR-165: agent text frames awaiting the same flush. Queued for the SAME
  // reason as the exit — a stream that connects after the prompt would drop a
  // directly-written sentinel, and a dropped sentinel reads as `result_missing`
  // rather than as a lost frame.
  pendingText: string[];
  exitCode: number;
  detached: boolean;
  // stub-compat: this session uses the hold-until-`.release` stream path
  // (a non-orchestrator run when stubCompat is enabled), not the auto-drive.
  stub: boolean;
  // The live SSE writer, set while a stream is connected.
  emit: ((event: Record<string, unknown>) => void) | null;
  // Events emitted before the stream connected — flushed on connect.
  queued: Array<Record<string, unknown>>;
  // ADR-166 (T6.2) permission scenario (the execution-host contract project):
  // the first prompt of every session parks on a permission request and its
  // HTTP response is HELD until `/input` answers it (end_turn) or a checkpoint
  // tears the session down (cancelled + session.exited{reason: checkpoint}).
  permission: boolean;
  pendingPrompt: {
    requestId: string;
    env: ReturnType<typeof stubEnvelope>;
    respond: (status: number, body: unknown) => void;
  } | null;
  // ADR-166: the create envelope's fence + handle.
  executionWorkspaceId?: string;
  assignmentId?: string;
  assignmentEpoch?: number;
  createdByCommandId?: string;
  // ADR-166: set when a command with a HIGHER assignment epoch evicted this
  // session (its held prompt answered 409 FENCED, its stream ended `fenced`).
  fencedByEpoch?: number;
};

export interface TestSupervisorOptions {
  // The pg pool used to look up runs.run_kind by the createSession runId.
  pool: Pool;
  // How many children each orchestrator turn-0 spawns. Default 2.
  childCount?: number;
  // The delegation hook (see DelegateHook). Default = HTTP POST to the ext
  // delegate route at the facade base URL (browser-e2e mode).
  delegate?: DelegateHook;
  // Optional: a fixed prompt per child (default "sub-task <n>").
  childPrompt?: (index: number) => string;
  // Optional: bind a fixed port (the browser e2e pins a stable URL). Default 0
  // (an ephemeral port the node loop test reads back from the handle).
  portHint?: number;
  // Optional: stub-supervisor compatibility for the BROWSER e2e. When set, a
  // non-orchestrator session (run_kind != "flow" — e.g. a platform-agents
  // `agent` run) behaves EXACTLY like e2e/_seed/stub-supervisor.ts: it writes a
  // `<sessionId>.json` record (the platform-agents spec inspects readOnlySession
  // + prompts) and its SSE stream HOLDS until the spec drops a
  // `<sessionId>.release` marker (or the backstop fires), then emits
  // session.exited{0}. Only orchestrator FLOW sessions drive the delegate→park
  // loop. Unset (the node loop test) ⇒ every session auto-drives by run_kind.
  stubCompat?: { sessionsDir: string };
}

export interface TestSupervisorHandle {
  server: Server;
  port: number;
  url: string;
  // Diagnostics for assertions: every createSession the web sent, in order.
  createdSessions: () => ReadonlyArray<{
    runId: string;
    runKind: string;
    isResume: boolean;
    mcpServers: AgentMcpServer[];
  }>;
  // Children the supervisor's orchestrator turn requested to spawn, in order.
  delegations: () => ReadonlyArray<DelegateRequest>;
  stop: () => Promise<void>;
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function readBinaryBody(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];

    req.on("data", (chunk: Buffer | string) => {
      chunks.push(
        typeof chunk === "string"
          ? new TextEncoder().encode(chunk)
          : Uint8Array.from(chunk),
      );
    });
    req.on("end", () => {
      const bytes = new Uint8Array(
        chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
      );
      let offset = 0;

      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve(bytes);
    });
    req.on("error", reject);
  });
}

// Pull the maister facade token + base url out of the createSession mcpServers
// payload, exactly where agentFacadeMcpServer (lib/agents/launch.ts) puts them.
function readFacade(mcpServers: AgentMcpServer[]): {
  token: string | null;
  apiBaseUrl: string | null;
} {
  const maister = mcpServers.find((s) => s.name === "maister");
  const env = (maister as { env?: Record<string, string> } | undefined)?.env;

  return {
    token: env?.MAISTER_PROJECT_TOKEN ?? null,
    apiBaseUrl: env?.MAISTER_API_BASE_URL ?? null,
  };
}

// Default delegation hook (browser-e2e): the agent's facade would POST the ext
// delegate route; replicate that over real HTTP. A non-2xx throws so the test
// supervisor surfaces it as a crash (loud failure).
const httpDelegateHook: DelegateHook = async (req) => {
  if (!req.facadeToken || !req.apiBaseUrl) {
    throw new Error(
      `test-supervisor: orchestrator session missing facade token/baseUrl ` +
        `(token=${!!req.facadeToken}, baseUrl=${req.apiBaseUrl})`,
    );
  }

  // The delegation target is decided PER RUN (see resolveDelegation).
  const resolved = (await req.resolveDelegation?.()) ?? {
    target: { agentId: process.env.MAISTER_TEST_CHILD_AGENT_ID },
  };
  const res = await fetch(`${req.apiBaseUrl}/api/v1/ext/runs/delegate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${req.facadeToken}`,
    },
    body: JSON.stringify({
      target: resolved.target,
      mode: "run",
      prompt: req.prompt,
      ...(resolved.resultProfile
        ? { resultProfile: resolved.resultProfile }
        : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");

    throw new Error(
      `test-supervisor: delegate route returned ${res.status}: ${text}`,
    );
  }
};

export async function startTestSupervisor(
  opts: TestSupervisorOptions,
): Promise<TestSupervisorHandle> {
  const childCount = opts.childCount ?? 2;
  const delegate = opts.delegate ?? httpDelegateHook;
  const childPrompt = opts.childPrompt ?? ((i: number) => `sub-task ${i}`);

  const sessions = new Map<string, SessionRecord>();
  const created: Array<{
    runId: string;
    runKind: string;
    isResume: boolean;
    mcpServers: AgentMcpServer[];
  }> = [];
  const delegations: DelegateRequest[] = [];
  // Orchestrator runs whose turn-0 fan-out has already happened. `driveTurn`
  // runs on EVERY `POST /sessions/:id/prompt`, so a second prompt on the same
  // session — a retry, or a wake that re-prompts without a `resumeSessionId` —
  // would spawn the sub-tasks a SECOND time and silently double the tree. A
  // real coordinator does not re-delegate the same sub-tasks because it was
  // prompted again; this keyed set is that behaviour, and it is what makes the
  // simulated fan-out deterministic under parallel load.
  const delegatedRuns = new Set<string>();
  let monotonic = 0;
  let runtimeSequence = -1n;
  let acknowledgedThrough = -1n;
  const runtimeOutbox: StageBEnvelope[] = [];
  const runtimeSubscribers = new Set<ServerResponse>();
  const runtimeObjects = new Map<string, TestRuntimeObject>();
  const promptReceipts = new Map<
    string,
    {
      runId: string;
      assignmentEpoch: number;
      phase: "accepted" | "completed";
      httpStatus: number;
      body: Record<string, unknown>;
      receivedAt: string;
      completedAt: string | null;
      eventId: string | null;
    }
  >();

  const nextId = (): number => {
    monotonic += 1;

    return monotonic;
  };

  const writeRuntimeEnvelope = (
    response: ServerResponse,
    envelope: StageBEnvelope,
  ): void => {
    response.write(`id: ${envelope.sequence}\n`);
    response.write(`data: ${JSON.stringify(envelope)}\n\n`);
  };

  const appendRuntimeEvent = (input: {
    runId: string;
    assignmentId: string;
    assignmentEpoch: number;
    hostSessionId: string | null;
    eventType: StageBEventType;
    payload: Record<string, unknown>;
  }): StageBEnvelope => {
    runtimeSequence += 1n;
    const envelope: StageBEnvelope = {
      envelopeVersion: 1,
      eventId: randomUUID(),
      hostKey: STUB_HOST_KEY,
      hostBootId: STUB_BOOT_ID,
      streamId: STAGE_B_STREAM_ID,
      sequence: runtimeSequence.toString(),
      runId: input.runId,
      assignmentId: input.assignmentId,
      assignmentEpoch: input.assignmentEpoch,
      hostSessionId: input.hostSessionId,
      eventType: input.eventType,
      occurredAt: new Date().toISOString(),
      payloadSchema: EVENT_PAYLOAD_SCHEMAS[input.eventType],
      payload: input.payload,
    };

    runtimeOutbox.push(envelope);
    for (const response of runtimeSubscribers) {
      try {
        writeRuntimeEnvelope(response, envelope);
      } catch {
        runtimeSubscribers.delete(response);
      }
    }

    return envelope;
  };

  const publishSessionEvent = (
    rec: SessionRecord,
    event: Record<string, unknown>,
  ): StageBEnvelope => {
    const eventType = event.type;

    if (
      typeof eventType !== "string" ||
      !(eventType in EVENT_PAYLOAD_SCHEMAS) ||
      !rec.assignmentId ||
      rec.assignmentEpoch === undefined
    ) {
      throw new Error(
        "test-supervisor: canonical event lacks a known type or assignment fence",
      );
    }
    const payload = Object.fromEntries(
      Object.entries(event).filter(
        ([key]) => !["type", "sessionId", "monotonicId"].includes(key),
      ),
    );

    return appendRuntimeEvent({
      runId: rec.runId,
      assignmentId: rec.assignmentId,
      assignmentEpoch: rec.assignmentEpoch,
      hostSessionId: rec.sessionId,
      eventType: eventType as StageBEventType,
      payload: {
        ...(typeof event.monotonicId === "number"
          ? { sourceMonotonicId: event.monotonicId }
          : {}),
        sessionName: rec.sessionName,
        ...(rec.nodeAttemptId ? { nodeAttemptId: rec.nodeAttemptId } : {}),
        ...payload,
      },
    });
  };

  // Flush queued text, then a queued clean exit, onto a connected stream
  // (idempotent). Text always precedes the exit: the consumers read the
  // completing turn's accumulated text at the exit frame.
  const flushExit = (rec: SessionRecord): void => {
    for (const text of rec.pendingText.splice(0)) {
      emitOrQueue(rec, {
        type: "session.update",
        sessionId: rec.sessionId,
        monotonicId: nextId(),
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      });
    }
    if (!rec.exitPending) return;
    rec.exitPending = false;
    emitOrQueue(rec, {
      type: "session.exited",
      sessionId: rec.sessionId,
      monotonicId: nextId(),
      exitCode: rec.exitCode,
    });
  };

  async function lookupProjectSlug(runId: string): Promise<string | null> {
    const r = await opts.pool.query(
      `SELECT p."slug" FROM "runs" r JOIN "projects" p ON p."id" = r."project_id"
        WHERE r."id" = $1`,
      [runId],
    );

    return (r.rows[0]?.slug as string | undefined) ?? null;
  }

  // Emit onto a connected stream, or queue until one connects.
  const emitOrQueue = (
    rec: SessionRecord,
    event: Record<string, unknown>,
  ): StageBEnvelope => {
    const envelope = publishSessionEvent(rec, event);

    if (rec.emit) rec.emit(event);
    else rec.queued.push(event);

    return envelope;
  };

  // Answer the held prompt of the permission scenario (idempotent).
  const resolvePendingPrompt = (
    rec: SessionRecord,
    stopReason: "end_turn" | "cancelled",
  ): boolean => {
    const pending = rec.pendingPrompt;

    if (!pending) return false;
    rec.pendingPrompt = null;
    const out = { stopReason };

    if (pending.env) {
      const event = emitOrQueue(rec, {
        type: "session.command",
        sessionId: rec.sessionId,
        monotonicId: nextId(),
        commandId: pending.env.command.id,
        kind: "session.prompt",
        phase: "completed",
        status: "succeeded",
        result: out,
      });

      pending.respond(200, { ...out, eventId: event.eventId });
    } else {
      pending.respond(200, out);
    }

    return true;
  };

  async function lookupRunKind(
    runId: string,
  ): Promise<SessionRecord["runKind"]> {
    const r = await opts.pool.query(
      `SELECT "run_kind" FROM "runs" WHERE "id" = $1`,
      [runId],
    );
    const kind = r.rows[0]?.run_kind as string | undefined;

    if (kind === "flow" || kind === "scratch" || kind === "agent") return kind;

    return "unknown";
  }

  // --- stub-supervisor compatibility (browser e2e) ----------------------------
  // Mirror e2e/_seed/stub-supervisor.ts for non-orchestrator sessions: write a
  // `<sessionId>.json` record (readOnly flag + prompts) and hold the stream
  // until `<sessionId>.release` (or the backstop), then session.exited{0}.
  const stubFile = (sessionId: string): string =>
    path.join(opts.stubCompat!.sessionsDir, `${sessionId}.json`);

  const stubWriteRecord = (
    sessionId: string,
    acpSessionId: string,
    request: Record<string, unknown>,
  ): void => {
    if (!opts.stubCompat) return;
    mkdirSync(opts.stubCompat.sessionsDir, { recursive: true });
    writeFileSync(
      stubFile(sessionId),
      JSON.stringify(
        { sessionId, acpSessionId, request, prompts: [] },
        null,
        2,
      ),
    );
  };

  const stubAppendPrompt = (
    sessionId: string,
    body: Record<string, unknown>,
  ): void => {
    if (!opts.stubCompat) return;
    try {
      const record = JSON.parse(readFileSync(stubFile(sessionId), "utf8"));

      record.prompts.push(body);
      writeFileSync(stubFile(sessionId), JSON.stringify(record, null, 2));
    } catch {
      // Unknown session — the spec asserts on the file, still answers.
    }
  };

  const stubHoldStream = (
    rec: SessionRecord,
    res: import("node:http").ServerResponse,
  ): void => {
    const releasePath = path.join(
      opts.stubCompat!.sessionsDir,
      `${rec.sessionId}.release`,
    );
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const released = existsSync(releasePath);
      const expired = Date.now() - startedAt > STUB_RELEASE_BACKSTOP_MS;

      if (!released && !expired) return;
      clearInterval(timer);
      res.write(
        `data: ${JSON.stringify({
          type: "session.exited",
          sessionId: rec.sessionId,
          monotonicId: nextId(),
          exitCode: 0,
        })}\n\n`,
      );
      res.end();
    }, STUB_RELEASE_POLL_MS);

    res.on("close", () => clearInterval(timer));
  };

  // ---- ADR-165: the public-result plane --------------------------------------
  //
  // A run that owes a result emits it as a ```json maister:output``` block in
  // the text of its COMPLETING turn — the same sentinel transport the real
  // adapters carry, read by the same extractor. Simulating the transport rather
  // than writing `run_results` directly is the point: the e2e proves the parse,
  // the validation and the publish, not just the row.
  const emitText = (rec: SessionRecord, text: string): void => {
    rec.pendingText.push(text);
  };

  const sentinel = (value: unknown): string =>
    ["```json maister:output", JSON.stringify(value), "```"].join("\n");

  /** The flow ref a run is pinned to, or null (an agent run has none). */
  async function flowRefOf(runId: string): Promise<string | null> {
    const rows = await opts.pool.query(
      `SELECT fr.flow_ref_id
         FROM runs r JOIN flow_revisions fr ON fr.id = r.flow_revision_id
        WHERE r.id = $1`,
      [runId],
    );

    return (rows.rows[0]?.flow_ref_id as string | undefined) ?? null;
  }

  /** True when the run carries a result contract (an RAH agent grandchild). */
  async function hasResultContract(runId: string): Promise<boolean> {
    const rows = await opts.pool.query(
      `SELECT result_contract IS NOT NULL AS has FROM runs WHERE id = $1`,
      [runId],
    );

    return rows.rows[0]?.has === true;
  }

  /**
   * The coordinator's REDUCE step: call the REAL collect route through the
   * facade token, and report the child run ids whose result came back `valid`.
   *
   * This is the whole point of the resume turn — a coordinator that fabricated
   * ids would produce a result the Lab's `consumed_results_ratio` marks down,
   * so the e2e drives the honest path and asserts the row it produces.
   */
  async function collectValidChildren(rec: SessionRecord): Promise<string[]> {
    const { token, apiBaseUrl } = readFacade(rec.mcpServers);

    if (!token || !apiBaseUrl) return [];
    const res = await fetch(`${apiBaseUrl}/api/v1/ext/runs/collect`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ all: true }),
    });

    if (!res.ok) {
      throw new Error(
        `test-supervisor: collect returned ${res.status}: ${await res
          .text()
          .catch(() => "<no body>")}`,
      );
    }
    const items = (await res.json()) as {
      childRunId: string;
      resultStatus?: string;
    }[];

    return items
      .filter((item) => item.resultStatus === "valid")
      .map((item) => item.childRunId);
  }

  // Decide + run the agent's turn for a session. Called on sendPrompt. For an
  // orchestrator turn 0 it spawns children first (awaited) so countPendingChildren
  // sees them when the runner makes the park decision after the prompt returns.
  async function driveTurn(rec: SessionRecord): Promise<void> {
    if (
      rec.runKind === "flow" &&
      !rec.isResume &&
      !delegatedRuns.has(rec.runId)
    ) {
      delegatedRuns.add(rec.runId);
      const { token, apiBaseUrl } = readFacade(rec.mcpServers);

      for (let i = 0; i < childCount; i += 1) {
        const req: DelegateRequest = {
          orchestratorRunId: rec.runId,
          facadeToken: token,
          apiBaseUrl,
          index: i,
          prompt: childPrompt(i),
          resolveDelegation: () => resolveDelegationFor(rec.runId),
        };

        delegations.push(req);
        await delegate(req);
      }
    }

    // ADR-165: the completing turn publishes the run's result.
    //   • a flow RESUME turn is the coordinator reducing — it collects first and
    //     reports the ids it actually consumed;
    //   • an agent child with a contract answers its research profile.
    if (rec.runKind === "flow" && rec.isResume) {
      const flowRef = await flowRefOf(rec.runId);

      if (flowRef === RAH_ROOT_FLOW_REF) {
        emitText(
          rec,
          sentinel({
            summary: "reduced the research findings",
            outcome: "completed",
            consumedChildRunIds: await collectValidChildren(rec),
          }),
        );
      } else if (flowRef === RAH_RESEARCH_FLOW_REF) {
        // The research coordinator collects its own agents, then exports.
        await collectValidChildren(rec);
        emitText(
          rec,
          sentinel({
            summary: "researched the change surface",
            outcome: "completed",
          }),
        );
      }
    } else if (
      rec.runKind === "agent" &&
      (await hasResultContract(rec.runId))
    ) {
      emitText(
        rec,
        sentinel({ summary: "one researcher's finding", outcome: "completed" }),
      );
    }

    // Every turn (orchestrator turn-0, orchestrator resume, child) ends with a
    // clean end_turn. The caller publishes the durable command completion
    // before flushing this exit, matching the production lifecycle ordering.
    rec.exitPending = true;
    rec.exitCode = 0;
  }

  /**
   * What a given orchestrator run delegates. One lookup, one place: the RAH
   * root fans out RESEARCH FLOW children, an RAH research coordinator fans out
   * AGENT grandchildren under the `research` profile, a project carrying the
   * ADR-163 delegated flow gets a flow child, and everything else keeps the
   * default agent target unchanged.
   */
  async function resolveDelegationFor(
    runId: string,
  ): Promise<DelegationTarget> {
    const flowRef = await flowRefOf(runId);

    if (flowRef === RAH_ROOT_FLOW_REF) {
      return { target: { flowId: RAH_RESEARCH_FLOW_REF } };
    }
    if (flowRef === RAH_RESEARCH_FLOW_REF) {
      return {
        target: { agentId: process.env.MAISTER_TEST_CHILD_AGENT_ID },
        resultProfile: RAH_RESULT_PROFILE,
      };
    }

    const rows = await opts.pool.query(
      `SELECT f.flow_ref_id
         FROM runs r
         JOIN flows f ON f.project_id = r.project_id
        WHERE r.id = $1 AND f.flow_ref_id = 'e2e-delegated-flow'`,
      [runId],
    );
    const delegatedFlow = rows.rows[0]?.flow_ref_id as string | undefined;

    return delegatedFlow
      ? { target: { flowId: delegatedFlow } }
      : { target: { agentId: process.env.MAISTER_TEST_CHILD_AGENT_ID } };
  }

  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    // ---- stub-supervisor superset: readiness surfaces --------------------
    if (method === "GET" && url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ready",
          host: {
            hostKey: STUB_HOST_KEY,
            bootId: STUB_BOOT_ID,
            protocolVersion: 1,
          },
          version: "e2e-test-supervisor",
          uptimeMs: 0,
          checkedAt: new Date().toISOString(),
          sessions: { live: 0, exited: 0, crashed: 0 },
        }),
      );

      return;
    }

    if (method === "GET" && url === "/capabilities") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          dataPlaneVersion: "execution-host-data-plane.v1",
          eventStream: true,
          asyncPrompt: true,
          runtimeObjects: true,
          limits: {
            maxEventBytes: 1_048_576,
            maxObjectBytes: 26_214_400,
            maxReplayBatch: 500,
          },
        }),
      );

      return;
    }

    if (method === "GET" && url === "/runtime-events") {
      const cursor = req.headers["last-event-id"];

      if (
        cursor !== undefined &&
        (Array.isArray(cursor) || !/^(0|[1-9][0-9]{0,18})$/.test(cursor))
      ) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            code: "PRECONDITION",
            message: "invalid runtime event sequence",
            details: { reason: "invalid_event_sequence" },
          }),
        );

        return;
      }
      const after = cursor === undefined ? -1n : BigInt(cursor);

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const envelope of runtimeOutbox) {
        if (BigInt(envelope.sequence) > after) {
          writeRuntimeEnvelope(res, envelope);
        }
      }
      runtimeSubscribers.add(res);
      req.on("close", () => runtimeSubscribers.delete(res));

      return;
    }

    if (method === "POST" && url === "/runtime-events/ack") {
      void readJsonBody(req).then((body) => {
        const streamId = body.streamId;
        const throughSequence = body.throughSequence;

        if (
          streamId !== STAGE_B_STREAM_ID ||
          typeof throughSequence !== "string" ||
          !/^(0|[1-9][0-9]{0,18})$/.test(throughSequence) ||
          BigInt(throughSequence) > runtimeSequence
        ) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              code: "PRECONDITION",
              message: "runtime event acknowledgement is invalid",
              details: { reason: "ack_beyond_emitted" },
            }),
          );

          return;
        }
        const through = BigInt(throughSequence);

        if (through > acknowledgedThrough) acknowledgedThrough = through;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            streamId: STAGE_B_STREAM_ID,
            acknowledgedThrough: acknowledgedThrough.toString(),
          }),
        );
      });

      return;
    }

    if (method === "GET" && url === "/diagnostics") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ready",
          version: "e2e-test-supervisor",
          checkedAt: new Date().toISOString(),
          adapters: [
            { id: "claude", binary: "claude-agent-acp", available: true },
            { id: "codex", binary: "codex-acp", available: true },
          ],
          envRefs: [{ name: "ZAI_API_KEY", present: false }],
        }),
      );

      return;
    }

    if (method === "POST" && url === "/model-catalog/resolve") {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          models: [
            { id: "glm-5.1", displayName: "GLM-5.1", origins: ["acp_probe"] },
            { id: "glm-5", displayName: "GLM-5", origins: ["curated"] },
          ],
          sources: [
            { kind: "acp_probe", status: "ok", count: 1 },
            { kind: "curated", status: "ok", count: 1 },
          ],
          resolvedAt: new Date().toISOString(),
          ttlSeconds: 3600,
        }),
      );

      return;
    }

    // ---- ADR-166 workspace adoption + receipts (transitional, in-memory) --
    const sendJson = (status: number, body: unknown, replayed = false) => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };

      if (replayed) headers["x-maister-command-replayed"] = "true";
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };

    if (method === "POST" && url === "/runtime-objects") {
      void readJsonBody(req).then((body) => {
        const env = stubEnvelope(body);

        if (!env) {
          sendJson(409, MISSING_ENVELOPE_BODY);

          return;
        }
        const replay = stubReplay(env);

        if (replay) {
          sendJson(replay.status, replay.body, true);

          return;
        }
        const refused = stubFence(env);

        if (refused) {
          stubRecord(env, refused.status, refused.body);
          sendJson(refused.status, refused.body);

          return;
        }
        const objectId = env.payload.objectId;

        if (typeof objectId !== "string") {
          sendJson(409, {
            code: "PRECONDITION",
            message: "runtime object id is required",
          });

          return;
        }
        const existing = runtimeObjects.get(objectId);

        if (existing) {
          stubRecord(env, 201, existing.metadata);
          sendJson(201, existing.metadata);

          return;
        }
        const createdAt = new Date().toISOString();
        const object: TestRuntimeObject = {
          runId: env.fence.runId,
          assignmentId: env.fence.assignmentId,
          assignmentEpoch: env.fence.assignmentEpoch,
          metadata: {
            objectId,
            kind: String(env.payload.kind),
            logicalName: String(env.payload.logicalName),
            mimeType: String(env.payload.mimeType),
            sizeBytes: Number(env.payload.sizeBytes),
            sha256: String(env.payload.sha256),
            generation: Number(env.payload.generation),
            retentionClass: String(env.payload.retentionClass),
            state: "pending",
            createdAt,
            sealedAt: null,
            expiresAt:
              typeof env.payload.expiresAt === "string"
                ? env.payload.expiresAt
                : null,
            deletedAt: null,
          },
          bytes: null,
        };

        runtimeObjects.set(objectId, object);
        stubRecord(env, 201, object.metadata);
        sendJson(201, object.metadata);
      });

      return;
    }

    const runtimeObjectMatch = url.match(
      /^\/runtime-objects\/([0-9a-f-]+)(\/content)?$/,
    );

    if (method === "GET" && runtimeObjectMatch && !runtimeObjectMatch[2]) {
      const object = runtimeObjects.get(runtimeObjectMatch[1]);

      if (!object) {
        sendJson(404, {
          code: "PRECONDITION",
          message: "runtime object is missing",
          details: { reason: "runtime_object_missing" },
        });

        return;
      }
      sendJson(200, object.metadata);

      return;
    }

    if (method === "PUT" && runtimeObjectMatch?.[2]) {
      const object = runtimeObjects.get(runtimeObjectMatch[1]);

      if (!object) {
        req.resume();
        sendJson(404, {
          code: "PRECONDITION",
          message: "runtime object is missing",
          details: { reason: "runtime_object_missing" },
        });

        return;
      }
      void readBinaryBody(req).then((bytes) => {
        const commandId = req.headers["x-maister-command-id"];
        const assignmentId = req.headers["x-maister-assignment-id"];
        const assignmentEpoch = Number(
          req.headers["x-maister-assignment-epoch"],
        );
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const expectedSha256 = req.headers["x-maister-sha256"];

        if (
          typeof commandId !== "string" ||
          assignmentId !== object.assignmentId ||
          assignmentEpoch !== object.assignmentEpoch ||
          expectedSha256 !== object.metadata.sha256 ||
          sha256 !== object.metadata.sha256 ||
          bytes.byteLength !== object.metadata.sizeBytes
        ) {
          sendJson(409, {
            code: "PRECONDITION",
            message: "runtime object upload failed integrity validation",
            details: { reason: "runtime_object_integrity_mismatch" },
          });

          return;
        }
        const now = new Date().toISOString();

        object.bytes = bytes;
        object.metadata = {
          ...object.metadata,
          state: "available",
          sealedAt: now,
        };
        const uploadEnvelope = stubEnvelope({
          command: { id: commandId, kind: "runtime_object.upload" },
          fence: {
            hostKey: STUB_HOST_KEY,
            assignmentId: object.assignmentId,
            assignmentEpoch: object.assignmentEpoch,
            runId: object.runId,
          },
          payload: {
            generation: object.metadata.generation,
            sizeBytes: bytes.byteLength,
            sha256,
          },
        });

        stubRecord(uploadEnvelope, 200, object.metadata);
        appendRuntimeEvent({
          runId: object.runId,
          assignmentId: object.assignmentId,
          assignmentEpoch: object.assignmentEpoch,
          hostSessionId: null,
          eventType: "runtime_object.available",
          payload: {
            objectId: object.metadata.objectId,
            kind: object.metadata.kind,
            logicalName: object.metadata.logicalName,
            mimeType: object.metadata.mimeType,
            sizeBytes: object.metadata.sizeBytes,
            sha256: object.metadata.sha256,
            generation: object.metadata.generation,
            retentionClass: object.metadata.retentionClass,
            state: object.metadata.state,
            sealedAt: object.metadata.sealedAt,
            expiresAt: object.metadata.expiresAt,
          },
        });
        sendJson(200, object.metadata);
      });

      return;
    }

    if (method === "GET" && runtimeObjectMatch?.[2]) {
      const object = runtimeObjects.get(runtimeObjectMatch[1]);

      if (!object?.bytes || object.metadata.state !== "available") {
        sendJson(410, {
          code: "PRECONDITION",
          message: "runtime object content is missing",
          details: { reason: "runtime_object_missing" },
        });

        return;
      }
      const requested = req.headers.range;
      const match = requested?.match(/^bytes=(\d+)-(\d*)$/);

      if (requested && !match) {
        res.writeHead(416);
        res.end();

        return;
      }
      const start = match ? Number(match[1]) : 0;
      const requestedEnd = match?.[2]
        ? Number(match[2])
        : object.bytes.length - 1;
      const end = Math.min(requestedEnd, object.bytes.length - 1);

      if (start < 0 || start > end || start >= object.bytes.length) {
        res.writeHead(416);
        res.end();

        return;
      }
      const bytes = object.bytes.subarray(start, end + 1);
      const checksum = object.metadata.sha256;

      if (!checksum) {
        sendJson(409, {
          code: "PRECONDITION",
          message: "runtime object checksum is missing",
          details: { reason: "runtime_object_unsealed" },
        });

        return;
      }
      const digest = `sha-256=:${Buffer.from(checksum, "hex").toString("base64")}:`;

      res.writeHead(match ? 206 : 200, {
        "content-type": object.metadata.mimeType,
        "content-length": String(bytes.length),
        "content-digest": digest,
        "accept-ranges": "bytes",
        ...(match
          ? { "content-range": `bytes ${start}-${end}/${object.bytes.length}` }
          : {}),
      });
      res.end(bytes);

      return;
    }

    if (method === "DELETE" && runtimeObjectMatch && !runtimeObjectMatch[2]) {
      void readJsonBody(req).then((body) => {
        const env = stubEnvelope(body);
        const object = runtimeObjects.get(runtimeObjectMatch[1]);

        if (!env || !object) {
          sendJson(404, {
            code: "PRECONDITION",
            message: "runtime object is missing",
            details: { reason: "runtime_object_missing" },
          });

          return;
        }
        const replay = stubReplay(env);

        if (replay) {
          res.writeHead(replay.status, {
            "x-maister-command-replayed": "true",
          });
          res.end();

          return;
        }
        const refused = stubFence(env, object.runId);

        if (refused) {
          stubRecord(env, refused.status, refused.body);
          sendJson(refused.status, refused.body);

          return;
        }
        const deletedAt = new Date().toISOString();

        object.bytes = null;
        object.metadata = {
          ...object.metadata,
          state: "deleted",
          deletedAt,
        };
        stubRecord(env, 204, {});
        appendRuntimeEvent({
          runId: object.runId,
          assignmentId: object.assignmentId,
          assignmentEpoch: object.assignmentEpoch,
          hostSessionId: null,
          eventType: "runtime_object.state",
          payload: {
            objectId: object.metadata.objectId,
            generation: object.metadata.generation,
            state: "deleted",
            deletedAt,
          },
        });
        res.writeHead(204);
        res.end();
      });

      return;
    }

    if (method === "POST" && url === "/workspaces/adopt") {
      void readJsonBody(req).then((body) => {
        const env = stubEnvelope(body);

        if (!env) {
          sendJson(409, {
            code: "PRECONDITION",
            message: "missing envelope",
            details: { reason: "missing_envelope" },
          });

          return;
        }
        const replay = stubReplay(env);

        if (replay) {
          sendJson(replay.status, replay.body, true);

          return;
        }
        const refused = stubFence(env, String(env.payload.runId ?? ""));

        if (refused) {
          stubRecord(env, refused.status, refused.body);
          sendJson(refused.status, refused.body);

          return;
        }
        const outcome = stubAdopt(env.payload);

        stubRecord(env, outcome.status, outcome.body);
        sendJson(outcome.status, outcome.body);
      });

      return;
    }

    const workspaceMatch = url.match(/^\/workspaces\/(ws_[0-9a-f]{32})$/);

    if (method === "GET" && workspaceMatch) {
      const h = stubHandle(workspaceMatch[1]);

      if (!h) {
        sendJson(404, {
          code: "PRECONDITION",
          message: "unknown execution workspace",
          details: { reason: "unknown_workspace" },
        });

        return;
      }
      sendJson(200, {
        executionWorkspaceId: workspaceMatch[1],
        runId: h.runId,
        projectSlug: h.projectSlug,
        kind: h.kind,
        adoptedAt: h.adoptedAt,
        releasedAt: h.releasedAt,
      });

      return;
    }

    if (method === "DELETE" && workspaceMatch) {
      void readJsonBody(req).then((body) => {
        const h = stubHandle(workspaceMatch[1]);

        if (!h) {
          sendJson(404, {
            code: "PRECONDITION",
            message: "unknown execution workspace",
            details: { reason: "unknown_workspace" },
          });

          return;
        }
        const env = stubEnvelope(body);
        const replay = stubReplay(env);

        if (replay) {
          sendJson(replay.status, replay.body, true);

          return;
        }
        const refused = stubFence(env, h.runId);

        if (refused) {
          stubRecord(env, refused.status, refused.body);
          sendJson(refused.status, refused.body);

          return;
        }
        const outcome = { released: stubRelease(workspaceMatch[1]) };

        stubRecord(env, 200, outcome);
        sendJson(200, outcome);
      });

      return;
    }

    const commandMatch = url.match(/^\/commands\/([0-9a-f-]+)$/);

    if (method === "GET" && commandMatch) {
      const promptReceipt = promptReceipts.get(commandMatch[1]);

      if (promptReceipt) {
        sendJson(200, {
          commandId: commandMatch[1],
          runId: promptReceipt.runId,
          kind: "session.prompt",
          assignmentEpoch: promptReceipt.assignmentEpoch,
          phase: promptReceipt.phase,
          httpStatus: promptReceipt.httpStatus,
          body: promptReceipt.body,
          receivedAt: promptReceipt.receivedAt,
          completedAt: promptReceipt.completedAt,
          eventId: promptReceipt.eventId,
          inflight: promptReceipt.phase === "accepted",
        });

        return;
      }
      const receipt = stubReceipt(commandMatch[1]);

      if (!receipt) {
        sendJson(404, { code: "PRECONDITION", message: "unknown command" });

        return;
      }
      sendJson(200, receipt);

      return;
    }

    // ---- GET /sessions — reconcile/keepalive/parkOrchestratorSession view --
    if (method === "GET" && url === "/sessions") {
      // The real `SessionListEntry` projection over the shared registry; a
      // checkpointed (detached) or evicted session is no longer listed live.
      const records = [...sessions.values()]
        .filter((s) => !s.detached)
        .map((s) => {
          const entry = stubSessions.get(s.sessionId);

          return {
            ...stubSessionListEntry(
              entry ?? {
                sessionId: s.sessionId,
                adapter: "claude",
                runId: s.runId,
                projectSlug: "test",
                stepId: "coordinate",
                sessionName: "default",
                status: "live",
                pid: 4242,
                startedAt: new Date().toISOString(),
                acpSessionId: s.acpSessionId,
                executionWorkspaceId: s.executionWorkspaceId,
                assignmentId: s.assignmentId,
                assignmentEpoch: s.assignmentEpoch,
                createdByCommandId: s.createdByCommandId,
              },
            ),
            monotonicId: monotonic,
          };
        });

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(records));

      return;
    }

    // ---- POST /sessions — create + run_kind lookup -----------------------
    if (method === "POST" && url === "/sessions") {
      void readJsonBody(req).then(async (rawBody) => {
        const env = stubEnvelope(rawBody);

        if (!env) {
          sendJson(409, MISSING_ENVELOPE_BODY);

          return;
        }
        const replay = stubReplay(env);

        if (replay) {
          sendJson(replay.status, replay.body, true);

          return;
        }
        const resolved = stubResolveCreate(stubPayload(rawBody));

        if ("status" in resolved) {
          stubRecord(env, resolved.status, resolved.body);
          sendJson(resolved.status, resolved.body);

          return;
        }
        const refused = stubFence(env, resolved.runId);

        if (refused) {
          stubRecord(env, refused.status, refused.body);
          sendJson(refused.status, refused.body);

          return;
        }
        const body = resolved.request as Record<string, unknown>;
        const capabilityProfileObjectId = body.capabilityProfileObjectId;

        if (typeof capabilityProfileObjectId === "string") {
          const profile = runtimeObjects.get(capabilityProfileObjectId);

          if (
            !profile ||
            profile.runId !== resolved.runId ||
            profile.assignmentId !== env.fence.assignmentId ||
            profile.assignmentEpoch !== env.fence.assignmentEpoch ||
            profile.metadata.state !== "available" ||
            profile.metadata.kind !== "capability_profile"
          ) {
            sendJson(409, {
              code: "FENCED",
              message:
                "capability profile object does not belong to this assignment",
              details: { reason: "assignment_fenced" },
            });

            return;
          }
        }
        const capabilityInstructionsObjectId =
          body.capabilityInstructionsObjectId;

        if (typeof capabilityInstructionsObjectId === "string") {
          const instructions = runtimeObjects.get(
            capabilityInstructionsObjectId,
          );

          if (
            !instructions ||
            instructions.runId !== resolved.runId ||
            instructions.assignmentId !== env.fence.assignmentId ||
            instructions.assignmentEpoch !== env.fence.assignmentEpoch ||
            instructions.metadata.state !== "available" ||
            instructions.metadata.kind !== "capability_instructions"
          ) {
            sendJson(409, {
              code: "FENCED",
              message:
                "capability instructions object does not belong to this assignment",
              details: { reason: "assignment_fenced" },
            });

            return;
          }
        }
        const sessionId = randomUUID();
        const acpSessionId = (body.resumeSessionId as string) || randomUUID();
        const runId = resolved.runId;
        const mcpServers = (body.mcpServers as AgentMcpServer[]) ?? [];
        const runKind = await lookupRunKind(runId);
        const permission =
          runKind === "flow" &&
          (await lookupProjectSlug(runId)) === E2E_EXECUTION_HOST_SLUG;

        // stub-compat path for non-orchestrator sessions (e.g. a platform-agents
        // `agent` run); orchestrator FLOW sessions always auto-drive.
        //
        // ADR-165 carves out one case: an agent child carrying a
        // `result_contract` is a DELEGATED researcher whose coordinator is
        // parked waiting for it. The hold path exists so a spec can control a
        // standalone agent run's termination, and it emits only
        // `session.exited` — no text, so no sentinel, so the child would fail
        // `result_missing` and the tree would never reduce. Such a child
        // auto-drives instead. No pre-ADR-165 fixture sets the column, so no
        // existing spec changes behaviour.
        const stub =
          !!opts.stubCompat &&
          runKind !== "flow" &&
          !(runKind === "agent" && (await hasResultContract(runId)));

        const rec: SessionRecord = {
          sessionId,
          acpSessionId,
          runId,
          runKind,
          isResume: typeof body.resumeSessionId === "string",
          mcpServers,
          sessionName: String(body.sessionName ?? "default"),
          nodeAttemptId:
            typeof body.nodeAttemptId === "string"
              ? body.nodeAttemptId
              : undefined,
          exitPending: false,
          pendingText: [],
          exitCode: 0,
          detached: false,
          stub,
          emit: null,
          queued: [],
          permission,
          pendingPrompt: null,
          executionWorkspaceId:
            typeof body.executionWorkspaceId === "string"
              ? body.executionWorkspaceId
              : undefined,
          assignmentId: env?.fence.assignmentId,
          assignmentEpoch: env?.fence.assignmentEpoch,
          createdByCommandId: env?.command.id,
        };

        sessions.set(sessionId, rec);
        stubRegisterSession({
          sessionId,
          adapter: String(
            (body.runner as { adapter?: string } | undefined)?.adapter ??
              (body.executor as { agent?: string } | undefined)?.agent ??
              "claude",
          ),
          runId,
          projectSlug: (await lookupProjectSlug(runId)) ?? "test",
          stepId: String(body.stepId ?? "coordinate"),
          nodeAttemptId:
            typeof body.nodeAttemptId === "string"
              ? body.nodeAttemptId
              : undefined,
          sessionName: String(body.sessionName ?? "default"),
          acpSessionId,
          executionWorkspaceId: rec.executionWorkspaceId,
          assignmentId: rec.assignmentId,
          assignmentEpoch: rec.assignmentEpoch,
          createdByCommandId: rec.createdByCommandId,
          // E-EH-04 / X-EH-19: a higher-epoch command evicts this session —
          // its held prompt answers 409 FENCED and its stream ends `fenced`.
          onEvict: (hostEpoch) => {
            rec.fencedByEpoch = hostEpoch;
            const pending = rec.pendingPrompt;

            if (pending) {
              rec.pendingPrompt = null;
              pending.respond(409, {
                code: "FENCED",
                message: `session ${sessionId} was evicted by assignment epoch ${hostEpoch}`,
                details: {
                  reason: "assignment_fenced",
                  runId,
                  commandEpoch:
                    pending.env?.fence.assignmentEpoch ??
                    rec.assignmentEpoch ??
                    0,
                  hostEpoch,
                },
              });
            }
            rec.exitPending = false;
            emitOrQueue(rec, stubFencedExitEvent(sessionId, nextId()));
            rec.detached = true;
          },
        });
        const outputBindings = Array.isArray(body.outputObjects)
          ? (body.outputObjects as Array<Record<string, unknown>>)
          : [];

        for (const output of outputBindings) {
          const objectId = String(output.objectId);

          runtimeObjects.set(objectId, {
            runId,
            assignmentId: env.fence.assignmentId,
            assignmentEpoch: env.fence.assignmentEpoch,
            metadata: {
              objectId,
              kind: String(output.kind),
              logicalName: String(output.logicalName),
              mimeType: String(output.mimeType),
              sizeBytes: null,
              sha256: null,
              generation: Number(output.generation),
              retentionClass: String(output.retentionClass),
              state: "pending",
              createdAt: new Date().toISOString(),
              sealedAt: null,
              expiresAt:
                typeof output.expiresAt === "string" ? output.expiresAt : null,
              deletedAt: null,
            },
            bytes: null,
          });
        }
        created.push({
          runId,
          runKind,
          isResume: rec.isResume,
          mcpServers,
        });
        if (stub) stubWriteRecord(sessionId, acpSessionId, body);

        const out = { sessionId, pid: 4242, acpSessionId };

        stubRecord(env, 201, out);
        publishSessionEvent(rec, {
          type: "session.created",
          sessionId,
          monotonicId: nextId(),
          adapter: String(
            (body.runner as { adapter?: string } | undefined)?.adapter ??
              (body.executor as { agent?: string } | undefined)?.agent ??
              "claude",
          ),
          sessionName: rec.sessionName,
          acpSessionId,
        });
        sendJson(201, out);
      });

      return;
    }

    const promptMatch = url.match(/^\/sessions\/([0-9a-f-]+)\/prompts$/);

    if (method === "POST" && promptMatch) {
      const rec = sessions.get(promptMatch[1]);

      void readJsonBody(req).then(async (rawBody) => {
        const env = stubEnvelope(rawBody);

        if (!env || !rec) {
          sendJson(404, {
            code: "PRECONDITION",
            message: "session is missing",
          });

          return;
        }
        const existingPrompt = promptReceipts.get(env.command.id);

        if (existingPrompt) {
          sendJson(202, { commandId: env.command.id, state: "accepted" }, true);

          return;
        }
        const replay = stubReplay(env);

        if (replay) {
          sendJson(replay.status, replay.body, true);

          return;
        }
        const refused = stubFence(env, rec?.runId);

        if (refused) {
          stubRecord(env, refused.status, refused.body);
          sendJson(refused.status, refused.body);

          return;
        }
        const body = stubPayload(rawBody) as Record<string, unknown>;

        const receivedAt = new Date().toISOString();

        promptReceipts.set(env.command.id, {
          runId: rec.runId,
          assignmentEpoch: env.fence.assignmentEpoch,
          phase: "accepted",
          httpStatus: 202,
          body: { commandId: env.command.id, state: "accepted" },
          receivedAt,
          completedAt: null,
          eventId: null,
        });
        emitOrQueue(rec, {
          type: "session.command",
          sessionId: rec.sessionId,
          monotonicId: nextId(),
          commandId: env.command.id,
          kind: "session.prompt",
          phase: "accepted",
        });
        sendJson(202, { commandId: env.command.id, state: "accepted" });

        const complete = (out: Record<string, unknown>): void => {
          const terminal = emitOrQueue(rec, {
            type: "session.command",
            sessionId: rec.sessionId,
            monotonicId: nextId(),
            commandId: env.command.id,
            kind: "session.prompt",
            phase: "completed",
            status: "succeeded",
            result: out,
          });

          promptReceipts.set(env.command.id, {
            runId: rec.runId,
            assignmentEpoch: env.fence.assignmentEpoch,
            phase: "completed",
            httpStatus: 200,
            body: out,
            receivedAt,
            completedAt: new Date().toISOString(),
            eventId: terminal.eventId,
          });
        };

        // Permission scenario: admission is already durable. `/input` or
        // `/checkpoint` settles the prompt receipt and terminal event later.
        if (rec.permission) {
          const requestId = randomUUID();

          rec.pendingPrompt = {
            requestId,
            env,
            respond: (_status, result) => {
              const body = result as Record<string, unknown>;
              const eventId =
                typeof body.eventId === "string" ? body.eventId : null;
              const promptBody = { ...body };

              delete promptBody.eventId;

              promptReceipts.set(env.command.id, {
                runId: rec.runId,
                assignmentEpoch: env.fence.assignmentEpoch,
                phase: "completed",
                httpStatus: 200,
                body: promptBody,
                receivedAt,
                completedAt: new Date().toISOString(),
                eventId,
              });
            },
          };
          emitOrQueue(rec, {
            type: "session.permission_request",
            sessionId: rec.sessionId,
            monotonicId: nextId(),
            requestId,
            options: [
              { optionId: "allow", kind: "allow_once", name: "Allow" },
              { optionId: "reject", kind: "reject_once", name: "Reject" },
            ],
            toolCall: {
              toolCallId: "tc-e2e-1",
              title: "Write CONTRACT.md",
              kind: "edit",
            },
          });

          return;
        }
        // stub-compat: record the prompt; the stream stays held until release
        // (do NOT auto-drive — the spec controls termination).
        if (rec.stub) {
          stubAppendPrompt(promptMatch[1], body);
          const out = { stopReason: "end_turn" };

          complete(out);

          const releasePath = path.join(
            opts.stubCompat!.sessionsDir,
            `${rec.sessionId}.release`,
          );
          const startedAt = Date.now();
          const timer = setInterval(() => {
            if (
              !existsSync(releasePath) &&
              Date.now() - startedAt <= STUB_RELEASE_BACKSTOP_MS
            ) {
              return;
            }
            clearInterval(timer);
            stubExitSession(rec.sessionId);
            emitOrQueue(rec, {
              type: "session.exited",
              sessionId: rec.sessionId,
              monotonicId: nextId(),
              exitCode: 0,
            });
          }, STUB_RELEASE_POLL_MS);

          return;
        }
        // Drive the agent's turn (spawn children for orchestrator turn-0, then
        // queue the clean exit). Errors surface as a crash on the stream.
        void driveTurn(rec).then(
          () => {
            complete({ stopReason: "end_turn" });
            flushExit(rec);
          },
          (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);

            console.error(`test-supervisor: turn failed: ${message}`);
            rec.exitPending = false;
            const failure = {
              code: "ACP_PROTOCOL",
              message: "test supervisor turn failed",
            };
            const terminal = emitOrQueue(rec, {
              type: "session.command",
              sessionId: rec.sessionId,
              monotonicId: nextId(),
              commandId: env.command.id,
              kind: "session.prompt",
              phase: "completed",
              status: "failed",
              error: failure,
            });

            promptReceipts.set(env.command.id, {
              runId: rec.runId,
              assignmentEpoch: env.fence.assignmentEpoch,
              phase: "completed",
              httpStatus: 500,
              body: failure,
              receivedAt,
              completedAt: new Date().toISOString(),
              eventId: terminal.eventId,
            });
            emitOrQueue(rec, {
              type: "session.crashed",
              sessionId: rec.sessionId,
              monotonicId: nextId(),
              exitCode: 1,
              signal: null,
            });
          },
        );
      });

      return;
    }

    const streamMatch = url.match(/^\/sessions\/([0-9a-f-]+)\/stream$/);

    if (method === "GET" && streamMatch) {
      const rec = sessions.get(streamMatch[1]);

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      if (!rec) {
        res.end();

        return;
      }

      // stub-compat: emit one update, then HOLD until `<sessionId>.release`.
      if (rec.stub) {
        res.write(
          `data: ${JSON.stringify({
            type: "session.update",
            sessionId: rec.sessionId,
            monotonicId: nextId(),
            update: { kind: "stub" },
          })}\n\n`,
        );
        stubHoldStream(rec, res);

        return;
      }

      rec.emit = (event: Record<string, unknown>) => {
        res.write(`id: ${event.monotonicId}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (
          event.type === "session.exited" ||
          event.type === "session.crashed"
        ) {
          rec.emit = null;
          res.end();
        }
      };
      // A child run's stream may connect AFTER its prompt already queued the
      // exit (consumeAgentSession starts the stream in a microtask, then awaits
      // sendPrompt) — flush queued events, then any pending exit.
      for (const event of rec.queued.splice(0)) {
        if (rec.emit) rec.emit(event);
      }
      flushExit(rec);

      req.on("close", () => {
        if (rec.emit) rec.emit = null;
      });

      return;
    }

    // ---- POST /sessions/:id/checkpoint — park detach ---------------------
    const checkpointMatch = url.match(/^\/sessions\/([0-9a-f-]+)\/checkpoint$/);

    if (method === "POST" && checkpointMatch) {
      const rec = sessions.get(checkpointMatch[1]);

      void readJsonBody(req).then((body) => {
        const env = stubEnvelope(body);
        const replay = stubReplay(env);

        if (replay) {
          sendJson(replay.status, replay.body, true);

          return;
        }
        const refused = stubFence(env, rec?.runId);

        if (refused) {
          stubRecord(env, refused.status, refused.body);
          sendJson(refused.status, refused.body);

          return;
        }
        const alreadyCheckpointed =
          stubSessions.get(checkpointMatch[1])?.status === "exited";

        if (rec) rec.detached = true;
        stubExitSession(checkpointMatch[1]);
        const out = {
          alreadyCheckpointed,
          sessionId: checkpointMatch[1],
          monotonicId: nextId(),
        };

        stubRecord(env, 200, out);
        sendJson(200, out);
        // Permission scenario: the adapter journals the pending request and
        // exits with reason "checkpoint"; its held prompt answers cancelled.
        if (rec?.permission) {
          resolvePendingPrompt(rec, "cancelled");
          emitOrQueue(rec, {
            type: "session.exited",
            sessionId: rec.sessionId,
            monotonicId: nextId(),
            exitCode: 0,
            reason: "checkpoint",
          });
        }
      });

      return;
    }

    // ---- POST /sessions/:id/input|cancel — permission delivery / interrupt --
    const inputMatch = url.match(/^\/sessions\/([0-9a-f-]+)\/(input|cancel)$/);

    if (method === "POST" && inputMatch) {
      const rec = sessions.get(inputMatch[1]);

      void readJsonBody(req).then((body) => {
        const env = stubEnvelope(body);
        const replay = stubReplay(env);

        if (replay) {
          sendJson(replay.status, replay.body, true);

          return;
        }
        const refused = stubFence(env, rec?.runId);

        if (refused) {
          stubRecord(env, refused.status, refused.body);
          sendJson(refused.status, refused.body);

          return;
        }
        const out =
          inputMatch[2] === "cancel"
            ? { cancelled: true, sessionId: inputMatch[1] }
            : { ok: true };

        stubRecord(env, 200, out);
        sendJson(200, out);
        // Permission scenario: the delivered answer completes the held turn and
        // the session ends cleanly (the flow runner drives the graph on).
        const payload = stubPayload(body) as {
          requestId?: string;
          action?: string;
        };

        if (
          rec?.pendingPrompt &&
          inputMatch[2] === "input" &&
          payload.requestId === rec.pendingPrompt.requestId
        ) {
          resolvePendingPrompt(
            rec,
            payload.action === "cancel" ? "cancelled" : "end_turn",
          );
          rec.exitPending = true;
          rec.exitCode = 0;
          flushExit(rec);
        }
      });

      return;
    }

    // ---- DELETE /sessions/:id --------------------------------------------
    const deleteMatch = url.match(/^\/sessions\/([0-9a-f-]+)$/);

    if (method === "DELETE" && deleteMatch) {
      const rec = sessions.get(deleteMatch[1]);

      void readJsonBody(req).then((body) => {
        const env = stubEnvelope(body);
        const replay = stubReplay(env);

        if (replay) {
          sendJson(replay.status, replay.body, true);

          return;
        }
        const refused = stubFence(env, rec?.runId);

        if (refused) {
          stubRecord(env, refused.status, refused.body);
          sendJson(refused.status, refused.body);

          return;
        }
        if (rec) {
          resolvePendingPrompt(rec, "cancelled");
          if (rec.emit) rec.emit = null;
          sessions.delete(deleteMatch[1]);
        }
        stubExitSession(deleteMatch[1]);
        stubRecord(env, 204, {});
        res.writeHead(204);
        res.end();
      });

      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ code: "PRECONDITION", message: "not implemented" }),
    );
  });

  // Never reap idle sockets in a bounded test process (mirrors stub-supervisor:
  // undici socket reuse races Node's 5s keepAliveTimeout otherwise).
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.portHint ?? 0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
  const serverUrl = `http://127.0.0.1:${port}`;

  console.log(`test-supervisor: listening on ${serverUrl}`);

  return {
    server,
    port,
    url: serverUrl,
    createdSessions: () => created,
    delegations: () => delegations,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const response of runtimeSubscribers) response.end();
        runtimeSubscribers.clear();
        server.close(() => resolve());
      }),
  };
}
