import type { ReceiptAdmission } from "./outbox-budget";
import type { FastifyInstance, FastifyReply } from "fastify";
import type * as acp from "@agentclientprotocol/sdk";
import type { Logger } from "pino";
import type {
  AppendRuntimeEventInput,
  HostRuntimeObjectRow,
  HostState,
} from "./host-state";
import type { SessionRegistry, RegistryEntry } from "./registry";
import type { WorkspaceResolution } from "./workspace-registry";

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import { z, ZodError, type ZodType, type ZodTypeDef } from "zod";

import { createAcpConnection, sendPromptOnConnection } from "./acp-client";
import { retainedOutputBudget } from "./bounded-acp-stream";
import {
  adapterSmokeCachePath,
  readAdapterSmokeCache,
  smokeDiagnosticForAdapter,
  type AdapterSmokeCacheRead,
} from "./adapter-smoke-cache";
import {
  listAdapterRuntimes,
  resolveAdapterBinary,
  type AdapterRuntime,
} from "./adapter-registry";
import {
  CommandReceipts,
  REPLAYED_HEADER,
  receiptToResponse,
  type CommandOutcome,
} from "./command-receipts";
import { takeContextMountPreamble } from "./context-mounts";
import { attachCost } from "./cost";
import {
  applyFence,
  evictLowerEpochSessions,
  waitForChildExit,
} from "./execution-fence";
import { attachHeartbeat } from "./heartbeat";
import { executionHostCapabilities } from "./data-plane-capabilities";
import {
  EXECUTION_HOST_PROTOCOL_VERSION,
  HostRuntimeEventError,
} from "./host-state";
import {
  modelCatalogCache,
  type ModelCatalogCache,
} from "./model-catalog/cache";
import { probeMcpServer } from "./mcp-probe";
import { ModelSourceRegistry } from "./model-catalog/registry";
import { resolveModelCatalog } from "./model-catalog/resolve";
import { ModelCatalogDraftSchema } from "./model-catalog/types";
import { pendingPermissions } from "./pending-permissions";
import { contentBlockUriViolation } from "./prompt-confinement";
import { resolvePromptRuntimeObjects } from "./prompt-runtime-objects";
import { SESSION_EVENT_CHANNEL } from "./registry";
import { RuntimeEventPublisher } from "./runtime-event-publisher";
import {
  MAX_RUNTIME_OBJECT_BYTES,
  RuntimeObjectRegistry,
  type RuntimeObjectPublicMetadata,
} from "./runtime-objects";
import {
  RuntimeEventAckSchema,
  RuntimeEventSequenceSchema,
} from "./runtime-events";
import { spawnSession } from "./spawn";
import {
  AdoptWorkspacePayloadSchema,
  CommandEnvelopeSchema,
  DeleteRuntimeObjectPayloadSchema,
  errorBody,
  httpStatusForCode,
  isEnvelopedBody,
  legacySessionPathField,
  isSupervisorError,
  parseGateChatHitlId,
  SendPromptRequestSchema,
  ReserveRuntimeObjectPayloadSchema,
  RuntimeObjectUploadHeadersSchema,
  SESSION_COMMAND_KINDS,
  StartSessionRequestSchema,
  SupervisorError,
  toSessionListEntry,
  type AdoptWorkspaceResponse,
  type CommandEnvelope,
  type CommandKind,
  type RuntimeObjectOutputBinding,
  type SessionEvent,
  type SessionStatus,
  type SupervisorDiagnosticsResponse,
  type SupervisorErrorBody,
  type SupervisorHealthResponse,
  type SendPromptRequest,
  type WorkspaceKind,
  type WorkspaceRecordResponse,
} from "./types";
import { WorkspaceRegistry } from "./workspace-registry";

// ADR-166: the `payload` of every enveloped teardown-class command
// (checkpoint, cancel, delete, workspace release) is `{}`. Strict, so callers
// cannot smuggle body-controlled fields onto those surfaces (D11
// identifier-table rule).
export const EmptyPayloadSchema = z.object({}).strict();

const InputBodySchema = z
  .object({
    kind: z.literal("permission"),
    action: z.enum(["select", "cancel"]),
    requestId: z.string().uuid(),
    optionId: z.string().min(1).optional(),
    reason: z.string().min(1).max(256).optional(),
  })
  .refine((b) => (b.action === "select" ? Boolean(b.optionId) : true), {
    message: "optionId is required when action='select'",
    path: ["optionId"],
  });

// ADR-129 (W-F): NAMES-only probe request. Values are resolved supervisor-side.
const McpProbeRequestSchema = z
  .object({
    transport: z.enum(["stdio", "sse", "http"]),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    envKeys: z.array(z.string()).optional(),
    url: z.string().url().optional(),
    headerKeys: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.transport === "stdio" && !r.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["command"],
        message: "stdio probe requires `command`",
      });
    }
    if ((r.transport === "sse" || r.transport === "http") && !r.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: `${r.transport} probe requires \`url\``,
      });
    }
  });

export type CheckpointResponse = {
  alreadyCheckpointed: boolean;
  sessionId: string;
  monotonicId: number;
};

export type InputBody = z.infer<typeof InputBodySchema>;

const DEFAULT_KILL_GRACE_MS = 5_000;
const MAX_RUNTIME_EVENT_SSE_PENDING = 500;
const SUPERVISOR_STARTED_AT_MS = Date.now();
const SUPERVISOR_VERSION = process.env.npm_package_version ?? "0.0.1";
const DIAGNOSTIC_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DIAGNOSTIC_ENV_REFS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "DASHSCOPE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
  "OPENAI_API_KEY",
  "ZAI_API_KEY",
];
const SESSION_STATUSES: readonly SessionStatus[] = [
  "live",
  "exited",
  "crashed",
];

export type SpawnOverrides = {
  binary?: string;
  preArgs?: string[];
};

export type RegisterRoutesOptions = {
  app: FastifyInstance;
  registry: SessionRegistry;
  logger: Logger;
  runtimeRoot: string;
  killGraceMs?: number;
  spawnOverrides?: SpawnOverrides;
  // ADR-076 model-catalog resolver. Injected so tests can stub the source set
  // and the cache; main.ts wires the real registry (with Phase-2 sources) and
  // the shared cache singleton.
  modelCatalog?: {
    registry: ModelSourceRegistry;
    cache?: ModelCatalogCache;
  };
  // ADR-166: the execution-host state store (identity, fences, receipts,
  // handles) and the realpath'd adoption roots — both derived once, in
  // main.ts (tests build their own).
  hostState: HostState;
  workspaceRoots: string[];
};

type SessionIdParams = { Params: { id: string } };
type CommandIdParams = { Params: { commandId: string } };

type ParsedCommand<T> = {
  envelope: CommandEnvelope;
  payload: T;
};

type SessionCommandKind = (typeof SESSION_COMMAND_KINDS)[number];

const SESSION_COMMAND_KIND_SET: ReadonlySet<string> = new Set(
  SESSION_COMMAND_KINDS,
);

function isSessionCommandKind(kind: CommandKind): kind is SessionCommandKind {
  return SESSION_COMMAND_KIND_SET.has(kind);
}

function countSessionsByStatus(
  records: ReadonlyArray<{ status: SessionStatus }>,
): SupervisorHealthResponse["sessions"] {
  const counts: SupervisorHealthResponse["sessions"] = {
    live: 0,
    exited: 0,
    crashed: 0,
  };

  for (const record of records) {
    if (SESSION_STATUSES.includes(record.status)) {
      counts[record.status] += 1;
    }
  }

  return counts;
}

function runtimeEventSupervisorError(error: unknown): SupervisorError {
  if (error instanceof HostRuntimeEventError) {
    const reason =
      error.reason === "replay_floor_exceeded"
        ? "replay_floor_lost"
        : error.reason === "event_outbox_soft_limit" ||
            error.reason === "event_outbox_hard_limit" ||
            error.reason === "event_outbox_terminal_reserve_exhausted"
          ? "event_outbox_backpressure"
          : error.reason;

    if (
      reason === "command_in_progress" ||
      reason === "command_invariant_conflict" ||
      reason === "stream_identity_conflict" ||
      reason === "replay_floor_lost" ||
      reason === "ack_not_contiguous" ||
      reason === "ack_beyond_emitted" ||
      reason === "event_outbox_backpressure"
    ) {
      return new SupervisorError("PRECONDITION", error.message, {
        details: { reason },
      });
    }
  }

  return new SupervisorError(
    "ACP_PROTOCOL",
    error instanceof Error ? error.message : String(error),
  );
}

function parseRuntimeEventCursor(
  header: string | string[] | undefined,
): string | null {
  if (header === undefined) return null;
  if (Array.isArray(header)) {
    throw new SupervisorError(
      "PRECONDITION",
      "Last-Event-ID must be one canonical decimal cursor",
      { details: { reason: "invalid_event_sequence" } },
    );
  }
  const parsed = RuntimeEventSequenceSchema.safeParse(header);

  if (!parsed.success) {
    throw new SupervisorError(
      "PRECONDITION",
      "Last-Event-ID must be a canonical signed-BIGINT decimal cursor",
      { details: { reason: "invalid_event_sequence" } },
    );
  }

  return parsed.data;
}

async function findExecutablePath(binary: string): Promise<string | null> {
  const pathEntries = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0);

  for (const entry of pathEntries) {
    const candidate = join(entry, binary);

    try {
      await access(candidate, fsConstants.X_OK);

      return candidate;
    } catch {
      /* keep scanning PATH */
    }
  }

  return null;
}

function diagnosticEnvRefs(): SupervisorDiagnosticsResponse["envRefs"] {
  const configured = (process.env.MAISTER_DIAGNOSTIC_ENV_REFS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => DIAGNOSTIC_ENV_NAME_RE.test(name));
  const names = Array.from(new Set([...DIAGNOSTIC_ENV_REFS, ...configured]));

  return names
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      present: Boolean(process.env[name]),
    }));
}

function versionProbeArgs(runtime: AdapterRuntime): readonly string[] | null {
  if (
    runtime.id === "gemini" ||
    runtime.id === "opencode" ||
    runtime.id === "mimo"
  ) {
    return ["--version"];
  }

  return null;
}

async function probeAdapterVersion(
  runtime: AdapterRuntime,
  binary: string,
): Promise<{ version: string | null; error: string | null }> {
  const args = versionProbeArgs(runtime);

  if (!args) return { version: null, error: null };

  return new Promise((resolveP) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout>;
    const child = spawn(binary, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const settle = (result: {
      version: string | null;
      error: string | null;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP(result);
    };

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ version: null, error: "version probe timed out" });
    }, 1_000);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (err) => {
      settle({ version: null, error: err.message });
    });
    child.once("close", (code) => {
      if (code !== 0) {
        settle({
          version: null,
          error: `version probe exited ${code}: ${stderr.trim()}`,
        });

        return;
      }

      const version = (stdout || stderr).split("\n")[0]?.trim() || null;

      settle({ version, error: null });
    });
  });
}

async function diagnoseAdapterBinary(
  runtime: AdapterRuntime,
  smokeCache: AdapterSmokeCacheRead,
  logger: Logger,
): Promise<SupervisorDiagnosticsResponse["adapters"][number]> {
  const resolution = resolveAdapterBinary({ adapter: runtime.id });
  const smoke = smokeDiagnosticForAdapter(runtime.id, smokeCache);

  if (resolution.source === "override") {
    try {
      await access(resolution.binary, fsConstants.X_OK);
      const versionProbe = await probeAdapterVersion(
        runtime,
        resolution.binary,
      );
      const available = !versionProbe.error && smoke.status !== "error";
      const error =
        versionProbe.error ?? (smoke.status === "error" ? smoke.reason : null);

      const diagnostic = {
        id: runtime.id,
        binary: resolution.binary,
        source: "override" as const,
        path: resolution.binary,
        available,
        version: versionProbe.version,
        error,
        smoke,
      };

      logger.debug(
        { adapter: runtime.id, source: "override", available },
        "[FIX] adapter diagnostics computed",
      );

      return diagnostic;
    } catch (err) {
      return {
        id: runtime.id,
        binary: resolution.binary,
        source: "override",
        path: resolution.binary,
        available: false,
        version: null,
        error: `adapter override is not executable: ${
          err instanceof Error ? err.message : String(err)
        }`,
        smoke,
      };
    }
  }

  const executablePath = await findExecutablePath(resolution.binary);
  const versionProbe = executablePath
    ? await probeAdapterVersion(runtime, executablePath)
    : { version: null, error: null };
  const available =
    executablePath !== null && !versionProbe.error && smoke.status !== "error";
  const error =
    executablePath === null
      ? `adapter binary not found on PATH: ${resolution.binary}`
      : (versionProbe.error ??
        (smoke.status === "error" ? smoke.reason : null));
  const diagnostic = {
    id: runtime.id,
    binary: resolution.binary,
    source: "path" as const,
    path: executablePath,
    available,
    version: versionProbe.version,
    error,
    smoke,
  };

  logger.debug(
    { adapter: runtime.id, source: "path", available },
    "[FIX] adapter diagnostics computed",
  );

  return diagnostic;
}

export function registerRoutes(opts: RegisterRoutesOptions): void {
  const { app, registry, logger, runtimeRoot } = opts;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const mcRegistry = opts.modelCatalog?.registry ?? new ModelSourceRegistry();
  const mcCache = opts.modelCatalog?.cache ?? modelCatalogCache;
  const { hostState } = opts;

  if (!hostState) {
    throw new Error("registerRoutes requires an execution-host state store");
  }

  app.addContentTypeParser("application/octet-stream", (_request, body, done) =>
    done(null, body),
  );

  const receipts = new CommandReceipts(hostState, logger);
  const recoveredPromptReceipts = receipts.recoverAcceptedPrompts();

  if (recoveredPromptReceipts > 0) {
    logger.warn(
      { recoveredPromptReceipts },
      "supervisor-startup-recovered-accepted-prompts",
    );
  }
  const runtimeObjects = new RuntimeObjectRegistry(
    hostState,
    join(hostState.stateDirReal ?? runtimeRoot, "runtime-objects"),
  );
  const runtimeEvents = new RuntimeEventPublisher(
    hostState,
    logger,
    undefined,
    runtimeObjects,
  );
  const workspaces = new WorkspaceRegistry({
    state: hostState,
    roots: opts.workspaceRoots,
    runtimeRoot,
    logger,
  });
  const fenceLog = logger.child({ component: "execution-fence" });

  // ADR-166 D4/D10 (strict): every host-bound command is a `CommandEnvelope`
  // whose `payload` is the route's body. A bare body is refused by name
  // (`missing_envelope`) before anything else is read; `guard` lets a route
  // refuse a payload shape by name too (the create route's `legacy_field`).
  function parseCommandBody<T>(
    body: unknown,
    kind: CommandKind,
    payloadSchema: ZodType<T, ZodTypeDef, unknown>,
    options: { route: string; guard?: (payload: unknown) => void },
  ): ParsedCommand<T> {
    if (!isEnvelopedBody(body)) {
      throw new SupervisorError(
        "PRECONDITION",
        `${options.route} requires a command envelope`,
        { details: { reason: "missing_envelope" } },
      );
    }

    const envelope = CommandEnvelopeSchema.parse(body);

    if (envelope.command.kind !== kind) {
      throw new SupervisorError(
        "PRECONDITION",
        `command.kind ${envelope.command.kind} does not match route kind ${kind}`,
      );
    }

    options.guard?.(envelope.payload);

    return { envelope, payload: payloadSchema.parse(envelope.payload) };
  }

  // ADR-166 D5: the durable completion signal that is NOT the long-lived HTTP
  // response. The host outbox records post-terminal completion independently
  // of the ACP session's lifecycle.
  type SessionCommandEvent = Extract<SessionEvent, { type: "session.command" }>;

  function createCommandEvent(
    entry: RegistryEntry,
    event: Omit<SessionCommandEvent, "sessionId" | "monotonicId">,
  ): SessionCommandEvent {
    entry.record.monotonicId += 1;

    return {
      ...event,
      sessionId: entry.record.sessionId,
      monotonicId: entry.record.monotonicId,
    };
  }

  function emitCommandEvent(
    entry: RegistryEntry,
    event: SessionCommandEvent,
    canonicallyPersisted: boolean,
  ): void {
    if (canonicallyPersisted) {
      registry.emitCanonicallyPersisted(entry.record.sessionId, event);
    } else {
      entry.emitter.emit(SESSION_EVENT_CHANNEL, event);
    }
  }

  function commandStatus(
    outcome: CommandOutcome,
  ): "succeeded" | "failed" | "fenced" {
    if (outcome.status < 400) return "succeeded";

    const body = outcome.body as SupervisorErrorBody | null;

    return body?.code === "FENCED" ? "fenced" : "failed";
  }

  // ADR-166 D6 handler order for every enveloped route: parse → fence (persist
  // the high-water) → receipt lookup / in-flight join → execute → write
  // receipt → respond (+ `session.command` events). The lower-epoch eviction
  // a fence advance triggers runs INSIDE the in-flight execution, so a
  // concurrent duplicate of the same command id joins the eviction instead of
  // executing beside it (E-EH-04).
  async function runCommand(args: {
    reply: FastifyReply;
    parsed: ParsedCommand<unknown>;
    kind: CommandKind;
    expectedRunId?: string;
    entry?: RegistryEntry;
    runtimeEvent?: (transition: {
      phase: "accepted" | "completed" | "rejected";
      outcome: CommandOutcome;
    }) => AppendRuntimeEventInput | null;
    execute: () => Promise<CommandOutcome>;
  }): Promise<void> {
    const { reply, parsed, kind, entry } = args;
    const envelope = parsed.envelope;
    const sessionKind = isSessionCommandKind(kind) ? kind : null;
    const admission: ReceiptAdmission | undefined =
      kind === "session.create"
        ? {
            kind: "producer",
            outputBindingCount:
              StartSessionRequestSchema.parse(parsed.payload).outputObjects
                ?.length ?? 0,
          }
        : entry?.record.status === "live" &&
            ["session.cancel", "session.checkpoint", "session.delete"].includes(
              kind,
            )
          ? { kind: "teardown", walletId: entry.record.createdByCommandId }
          : undefined;
    const commandEvents = new Map<
      "accepted" | "completed" | "rejected",
      SessionCommandEvent
    >();
    const fence = applyFence({
      state: hostState,
      fence: envelope.fence,
      expectedRunId: args.expectedRunId,
      logger: fenceLog,
    });

    const outcome = await receipts.execute({
      envelope,
      hostSessionId: entry?.record.sessionId,
      persistReceipt: args.runtimeEvent
        ? (transition) => {
            const event = args.runtimeEvent?.(transition);

            if (event)
              hostState.putReceiptWithRuntimeEvent(
                transition.row,
                event,
                transition.admission,
              );
            else hostState.putReceipt(transition.row, transition.admission);
          }
        : entry && sessionKind
          ? (transition) => {
              const status = commandStatus(transition.outcome);
              const event = createCommandEvent(entry, {
                type: "session.command",
                commandId: envelope.command.id,
                kind: sessionKind,
                phase:
                  transition.phase === "accepted" ? "accepted" : "completed",
                ...(transition.phase === "accepted"
                  ? {}
                  : status === "succeeded"
                    ? {
                        status,
                        result: (transition.outcome.body ?? {}) as Record<
                          string,
                          unknown
                        >,
                      }
                    : {
                        status,
                        error: transition.outcome.body as SupervisorErrorBody,
                      }),
              });

              hostState.putReceiptWithRuntimeEvent(
                transition.row,
                runtimeEvents.sessionEventInput(entry.record, event),
                transition.admission,
              );
              commandEvents.set(transition.phase, event);
            }
          : undefined,
      afterReceipt:
        entry && sessionKind
          ? (transition) => {
              const event = commandEvents.get(transition.phase);

              if (!event) {
                throw new Error(
                  `canonical command event was not persisted for ${envelope.command.id}`,
                );
              }
              emitCommandEvent(entry, event, true);
            }
          : undefined,
      admission,
      run: async () => {
        if (fence.advanced) {
          await evictLowerEpochSessions({
            registry,
            runId: envelope.fence.runId,
            epoch: envelope.fence.assignmentEpoch,
            killGraceMs,
            logger: fenceLog,
          });
        }

        return args.execute();
      },
    });

    if (outcome.replayed) reply.header(REPLAYED_HEADER, "true");

    if (outcome.status === 204) {
      reply.status(204).send();

      return;
    }

    reply.status(outcome.status).send(outcome.body);
  }

  async function runRestartableUploadCommand(args: {
    reply: FastifyReply;
    parsed: ParsedCommand<unknown>;
    expectedRunId: string;
    runtimeEvent: (transition: {
      phase: "accepted" | "completed" | "rejected";
      outcome: CommandOutcome;
    }) => AppendRuntimeEventInput | null;
    execute: () => Promise<CommandOutcome>;
  }): Promise<void> {
    const fence = applyFence({
      state: hostState,
      fence: args.parsed.envelope.fence,
      expectedRunId: args.expectedRunId,
      logger: fenceLog,
    });
    const outcome = await receipts.executeRestartableUpload({
      envelope: args.parsed.envelope,
      hostSessionId:
        args.parsed.envelope.payload &&
        typeof args.parsed.envelope.payload === "object" &&
        "objectId" in args.parsed.envelope.payload
          ? String(args.parsed.envelope.payload.objectId)
          : undefined,
      persistReceipt: (transition) => {
        const event = args.runtimeEvent(transition);

        if (event)
          hostState.putReceiptWithRuntimeEvent(
            transition.row,
            event,
            transition.admission,
          );
        else hostState.putReceipt(transition.row, transition.admission);
      },
      run: async () => {
        if (fence.advanced) {
          await evictLowerEpochSessions({
            registry,
            runId: args.parsed.envelope.fence.runId,
            epoch: args.parsed.envelope.fence.assignmentEpoch,
            killGraceMs,
            logger: fenceLog,
          });
        }

        return args.execute();
      },
    });

    if (outcome.replayed) args.reply.header(REPLAYED_HEADER, "true");
    args.reply.status(outcome.status).send(outcome.body);
  }

  function assertRuntimeObjectDeleteFence(
    object: HostRuntimeObjectRow,
    envelope: CommandEnvelope,
  ): void {
    const fence = envelope.fence;

    if (fence.hostKey !== hostState.hostKey) {
      throw new SupervisorError(
        "PRECONDITION",
        "runtime object deletion names a different execution host",
        { details: { reason: "host_mismatch", runId: fence.runId } },
      );
    }
    if (fence.runId !== object.runId) {
      throw new SupervisorError(
        "PRECONDITION",
        "runtime object deletion names a different run",
        { details: { reason: "run_mismatch", runId: fence.runId } },
      );
    }
    if (
      fence.assignmentId !== object.assignmentId ||
      fence.assignmentEpoch !== object.assignmentEpoch
    ) {
      throw new SupervisorError(
        "FENCED",
        "runtime object deletion does not match the object's immutable assignment",
        { details: { reason: "assignment_fenced", runId: fence.runId } },
      );
    }
  }

  async function runRuntimeObjectDeleteCommand(args: {
    reply: FastifyReply;
    parsed: ParsedCommand<unknown>;
    object: HostRuntimeObjectRow;
    runtimeEvent: (transition: {
      phase: "accepted" | "completed" | "rejected";
      outcome: CommandOutcome;
    }) => AppendRuntimeEventInput | null;
    execute: () => Promise<CommandOutcome>;
  }): Promise<void> {
    assertRuntimeObjectDeleteFence(args.object, args.parsed.envelope);
    const outcome = await receipts.execute({
      envelope: args.parsed.envelope,
      hostSessionId: args.object.id,
      persistReceipt: (transition) => {
        const event = args.runtimeEvent(transition);

        if (event)
          hostState.putReceiptWithRuntimeEvent(
            transition.row,
            event,
            transition.admission,
          );
        else hostState.putReceipt(transition.row, transition.admission);
      },
      run: args.execute,
    });

    if (outcome.replayed) args.reply.header(REPLAYED_HEADER, "true");
    if (outcome.status === 204) {
      args.reply.status(204).send();

      return;
    }
    args.reply.status(outcome.status).send(outcome.body);
  }

  async function runAsyncPromptCommand(args: {
    reply: FastifyReply;
    parsed: ParsedCommand<unknown>;
    entry: RegistryEntry;
    execute: () => Promise<CommandOutcome>;
  }): Promise<void> {
    const { reply, parsed, entry } = args;
    const envelope = parsed.envelope;
    const commandEvents = new Map<
      "accepted" | "completed" | "rejected",
      SessionCommandEvent
    >();
    const fence = applyFence({
      state: hostState,
      fence: envelope.fence,
      expectedRunId: entry.record.runId,
      logger: fenceLog,
    });
    const outcome = await receipts.executeAsync({
      envelope,
      hostSessionId: entry.record.sessionId,
      persistReceipt: (transition) => {
        const status = commandStatus(transition.outcome);
        const event = createCommandEvent(entry, {
          type: "session.command",
          commandId: envelope.command.id,
          kind: "session.prompt",
          phase: transition.phase === "accepted" ? "accepted" : "completed",
          ...(transition.phase === "accepted"
            ? {}
            : status === "succeeded"
              ? {
                  status,
                  result: (transition.outcome.body ?? {}) as Record<
                    string,
                    unknown
                  >,
                }
              : {
                  status,
                  error: transition.outcome.body as SupervisorErrorBody,
                }),
        });

        hostState.putReceiptWithRuntimeEvent(
          transition.row,
          runtimeEvents.sessionEventInput(entry.record, event),
          transition.admission,
        );
        commandEvents.set(transition.phase, event);
      },
      afterReceipt: (transition) => {
        const event = commandEvents.get(transition.phase);

        if (!event) {
          throw new Error(
            `canonical command event was not persisted for ${envelope.command.id}`,
          );
        }
        emitCommandEvent(entry, event, true);
      },
      run: async () => {
        if (fence.advanced) {
          await evictLowerEpochSessions({
            registry,
            runId: envelope.fence.runId,
            epoch: envelope.fence.assignmentEpoch,
            killGraceMs,
            logger: fenceLog,
          });
        }

        try {
          return await args.execute();
        } finally {
          if (
            entry.record.outputTeardownStarted ||
            entry.child.exitCode !== null ||
            entry.child.signalCode !== null
          ) {
            await entry.record.outputDrained;
          }
        }
      },
    });

    if (outcome.replayed) reply.header(REPLAYED_HEADER, "true");
    reply.status(outcome.status).send(outcome.body);
  }

  async function executePromptTurn(input: {
    entry: RegistryEntry;
    sessionId: string;
    parsed: ParsedCommand<SendPromptRequest>;
  }): Promise<CommandOutcome> {
    const { entry, sessionId, parsed } = input;
    const body = parsed.payload;

    if (
      entry.record.status !== "live" ||
      entry.child.exitCode !== null ||
      entry.child.signalCode !== null
    ) {
      throw new SupervisorError("PRECONDITION", "session not live");
    }
    if (!entry.connection || !entry.acpSessionId) {
      throw new SupervisorError(
        "PRECONDITION",
        "session has no ACP connection",
      );
    }
    const uriViolation = contentBlockUriViolation(body.contentBlocks, {
      worktreePath: entry.record.worktreePath,
      repoPath: entry.record.repoPath,
      runDir: dirname(entry.record.logPath),
      confineRoot: entry.record.confineRoot,
    });

    if (uriViolation) {
      logger.warn(
        { sessionId, status: 409, message: uriViolation },
        "prompt route: content-block URI confinement violation",
      );
      throw new SupervisorError("PRECONDITION", uriViolation);
    }
    const contentBlocks = await resolvePromptRuntimeObjects({
      blocks: body.contentBlocks,
      resolver: runtimeObjects,
      runId: entry.record.runId,
      assignmentId: parsed.envelope.fence.assignmentId,
      assignmentEpoch: parsed.envelope.fence.assignmentEpoch,
    });

    entry.record.stepId = body.stepId;
    entry.record.activePromptCommandId = parsed.envelope.command.id;
    if (body.nodeAttemptId) entry.record.nodeAttemptId = body.nodeAttemptId;
    else delete entry.record.nodeAttemptId;

    const chatHitlId = parseGateChatHitlId(body.stepId);
    let chatBuf = "";
    const chatBudget = retainedOutputBudget();
    const chatListener = (event: SessionEvent): void => {
      if (event.type !== "session.update") return;
      const update = event.update as {
        sessionUpdate?: string;
        content?: { type?: string; text?: string };
      } | null;

      if (
        update?.sessionUpdate === "agent_message_chunk" &&
        update.content?.type === "text" &&
        typeof update.content.text === "string"
      ) {
        chatBudget.reserve(update.content.text.length * 2);
        chatBuf += update.content.text;
      }
    };

    if (chatHitlId) entry.emitter.on(SESSION_EVENT_CHANNEL, chatListener);
    entry.record.readOnlyTurn = body.readOnlyTurn === true;
    const mountPreamble = takeContextMountPreamble(entry.record);

    if (mountPreamble) {
      logger.info(
        {
          sessionId,
          mounts: entry.record.contextMounts?.map((mount) => mount.slug),
        },
        "context-mount preamble prepended",
      );
    }

    let response: Awaited<ReturnType<typeof sendPromptOnConnection>>;

    try {
      response = await sendPromptOnConnection(
        entry.connection,
        {
          adapter: entry.record.adapter,
          acpSessionId: entry.acpSessionId,
          stepId: body.stepId,
          prompt: body.prompt,
          contentBlocks,
          preamble: mountPreamble ?? undefined,
          isUserCancel: () => entry.record.cancelRequested === true,
        },
        logger,
      );
    } catch (error) {
      chatBudget.release();
      throwIfFenced(entry, parsed.envelope);
      if (entry.record.outputFailure) {
        throw new SupervisorError(
          entry.record.outputFailure.code,
          entry.record.outputFailure.message,
          { details: entry.record.outputFailure.details },
        );
      }
      throw error;
    } finally {
      entry.record.readOnlyTurn = false;
      entry.record.cancelRequested = false;
      if (chatHitlId) entry.emitter.off(SESSION_EVENT_CHANNEL, chatListener);
    }
    try {
      throwIfFenced(entry, parsed.envelope);
      if (entry.record.outputFailure) {
        throw new SupervisorError(
          entry.record.outputFailure.code,
          entry.record.outputFailure.message,
          { details: entry.record.outputFailure.details },
        );
      }
      if (chatHitlId) {
        entry.record.monotonicId += 1;
        entry.emitter.emit(SESSION_EVENT_CHANNEL, {
          type: "session.chat_turn",
          sessionId,
          monotonicId: entry.record.monotonicId,
          hitlRequestId: chatHitlId,
          role: "agent",
          body: chatBuf,
        } satisfies SessionEvent);
      }
    } finally {
      chatBuf = "";
      chatBudget.release();
    }
    logger.info(
      {
        sessionId,
        stepId: body.stepId,
        stopReason: response.stopReason,
        readOnlyTurn: body.readOnlyTurn === true,
        commandId: parsed.envelope.command.id,
      },
      "prompt-turn-completed",
    );
    const sealedRuntimeObjects: RuntimeObjectPublicMetadata[] = [];

    for (const objectId of entry.record.runtimeOutputObjectIds ?? []) {
      const metadata = await runtimeObjects.sealOutput({
        objectId,
        hostSessionId: sessionId,
      });

      hostState.appendRuntimeEvent(
        runtimeEvents.runtimeObjectInput({
          runId: entry.record.runId,
          assignmentId: entry.record.assignmentId,
          assignmentEpoch: entry.record.assignmentEpoch,
          metadata,
          walletId: entry.record.createdByCommandId,
        }),
      );
      sealedRuntimeObjects.push(metadata);
    }
    if (entry.record.reapOnEndTurn && response.stopReason === "end_turn") {
      entry.intentionalShutdown = true;
      entry.child.kill("SIGTERM");
    }

    return {
      status: 200,
      body: {
        stopReason: response.stopReason,
        ...(response._meta === undefined ? {} : { meta: response._meta }),
        ...(sealedRuntimeObjects.length > 0
          ? { runtimeObjects: sealedRuntimeObjects }
          : {}),
      },
    };
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HostRuntimeEventError) {
      const failure = runtimeEventSupervisorError(err);

      reply.status(httpStatusForCode(failure.code)).send(errorBody(failure));

      return;
    }
    if (isSupervisorError(err)) {
      const status =
        err.details?.reason === "runtime_object_range_invalid"
          ? 416
          : err.details?.reason === "runtime_object_too_large"
            ? 413
            : httpStatusForCode(err.code);

      reply.status(status).send(errorBody(err));

      return;
    }

    if (err instanceof ZodError) {
      const message = err.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");

      reply.status(409).send({ code: "PRECONDITION", message });

      return;
    }

    const message = err instanceof Error ? err.message : String(err);

    logger.error({ err: message }, "unhandled-error");
    reply.status(500).send({ code: "ACP_PROTOCOL", message });
  });

  app.get("/health", async (_req, reply) => {
    const body: SupervisorHealthResponse = {
      status: "ready",
      host: {
        hostKey: hostState.hostKey,
        bootId: hostState.bootId,
        protocolVersion: EXECUTION_HOST_PROTOCOL_VERSION,
      },
      version: SUPERVISOR_VERSION,
      uptimeMs: Math.max(0, Date.now() - SUPERVISOR_STARTED_AT_MS),
      checkedAt: new Date().toISOString(),
      sessions: countSessionsByStatus(registry.list()),
    };

    reply.status(200).send(body);
  });

  app.get("/capabilities", async (_req, reply) => {
    const capabilities = executionHostCapabilities();

    logger.info(
      {
        eventStream: capabilities.eventStream,
        asyncPrompt: capabilities.asyncPrompt,
        runtimeObjects: capabilities.runtimeObjects,
      },
      "execution-host-capabilities-read",
    );
    reply.status(200).send(capabilities);
  });

  function runtimeObjectEvent(
    fence: CommandEnvelope["fence"],
    outcome: CommandOutcome,
  ): AppendRuntimeEventInput | null {
    if (outcome.status >= 400) return null;
    const body = outcome.body as Partial<RuntimeObjectPublicMetadata> | null;

    if (
      !body ||
      typeof body.objectId !== "string" ||
      typeof body.kind !== "string" ||
      typeof body.logicalName !== "string" ||
      typeof body.mimeType !== "string" ||
      typeof body.generation !== "number" ||
      typeof body.retentionClass !== "string" ||
      typeof body.state !== "string" ||
      typeof body.createdAt !== "string"
    ) {
      throw new Error(
        "runtime object command completed without typed metadata",
      );
    }

    return runtimeEvents.runtimeObjectInput({
      runId: fence.runId,
      assignmentId: fence.assignmentId,
      assignmentEpoch: fence.assignmentEpoch,
      metadata: body as RuntimeObjectPublicMetadata,
    });
  }

  app.post("/runtime-objects", async (req, reply) => {
    const parsed = parseCommandBody(
      req.body,
      "runtime_object.reserve",
      ReserveRuntimeObjectPayloadSchema,
      { route: "POST /runtime-objects" },
    );

    await runCommand({
      reply,
      parsed,
      kind: "runtime_object.reserve",
      expectedRunId: parsed.envelope.fence.runId,
      runtimeEvent: (transition) =>
        transition.phase === "accepted"
          ? null
          : runtimeObjectEvent(parsed.envelope.fence, transition.outcome),
      execute: async () => ({
        status: 201,
        body: await runtimeObjects.reserve({
          runId: parsed.envelope.fence.runId,
          assignmentId: parsed.envelope.fence.assignmentId,
          assignmentEpoch: parsed.envelope.fence.assignmentEpoch,
          payload: parsed.payload,
        }),
      }),
    });
  });

  app.get("/runtime-objects/:id", async (req, reply) => {
    const parsed = z
      .string()
      .uuid()
      .safeParse((req.params as { id?: unknown }).id);

    if (!parsed.success) {
      throw new SupervisorError(
        "PRECONDITION",
        "runtime object id is invalid",
        {
          details: { reason: "runtime_object_missing" },
        },
      );
    }
    const metadata = runtimeObjects.metadata(parsed.data);

    if (metadata.sha256) {
      reply.header("ETag", `\"${metadata.sha256}\"`);
    }
    reply.status(200).send(metadata);
  });

  app.put("/runtime-objects/:id/content", async (req, reply) => {
    const objectId = z
      .string()
      .uuid()
      .safeParse((req.params as { id?: unknown }).id);

    if (!objectId.success) {
      throw new SupervisorError(
        "PRECONDITION",
        "runtime object id is invalid",
        {
          details: { reason: "runtime_object_missing" },
        },
      );
    }
    const rawContentLength = req.headers["content-length"];
    const contentLength =
      typeof rawContentLength === "string" ? Number(rawContentLength) : NaN;

    if (
      Number.isSafeInteger(contentLength) &&
      contentLength > MAX_RUNTIME_OBJECT_BYTES
    ) {
      throw new SupervisorError(
        "PRECONDITION",
        `runtime object upload exceeds ${MAX_RUNTIME_OBJECT_BYTES} bytes`,
        { details: { reason: "runtime_object_too_large" } },
      );
    }
    const headers = RuntimeObjectUploadHeadersSchema.safeParse({
      commandId: req.headers["x-maister-command-id"],
      commandIssuedAt: req.headers["x-maister-command-issued-at"],
      assignmentId: req.headers["x-maister-assignment-id"],
      assignmentEpoch: req.headers["x-maister-assignment-epoch"],
      generation: req.headers["x-maister-object-generation"],
      sizeBytes: req.headers["content-length"],
      sha256: req.headers["x-maister-sha256"],
      contentDigest: req.headers["content-digest"],
    });

    if (!headers.success) {
      throw new SupervisorError(
        "PRECONDITION",
        "runtime object upload headers are invalid",
        {
          details: { reason: "runtime_object_integrity_mismatch" },
        },
      );
    }
    const object = hostState.getRuntimeObject(objectId.data);

    if (!object) {
      throw new SupervisorError("PRECONDITION", "runtime object is missing", {
        details: { reason: "runtime_object_missing" },
      });
    }
    const expectedDigest = `sha-256=:${Buffer.from(headers.data.sha256, "hex").toString("base64")}:`;

    if (headers.data.contentDigest !== expectedDigest) {
      throw new SupervisorError(
        "PRECONDITION",
        "Content-Digest does not match x-maister-sha256",
        {
          details: { reason: "runtime_object_integrity_mismatch" },
        },
      );
    }
    const uploadStream = req.body;

    if (
      !uploadStream ||
      typeof uploadStream !== "object" ||
      !(Symbol.asyncIterator in uploadStream)
    ) {
      throw new SupervisorError(
        "PRECONDITION",
        "runtime object upload must be binary",
        {
          details: { reason: "runtime_object_integrity_mismatch" },
        },
      );
    }
    const envelope: CommandEnvelope = {
      command: {
        id: headers.data.commandId,
        kind: "runtime_object.upload",
        issuedAt: headers.data.commandIssuedAt,
      },
      fence: {
        hostKey: hostState.hostKey,
        assignmentId: headers.data.assignmentId,
        assignmentEpoch: headers.data.assignmentEpoch,
        runId: object.runId,
      },
      payload: {
        objectId: objectId.data,
        generation: headers.data.generation,
        sizeBytes: headers.data.sizeBytes,
        sha256: headers.data.sha256,
      },
    };

    await runRestartableUploadCommand({
      reply,
      parsed: { envelope, payload: envelope.payload },
      expectedRunId: object.runId,
      runtimeEvent: (transition) =>
        transition.phase === "accepted"
          ? null
          : runtimeObjectEvent(envelope.fence, transition.outcome),
      execute: async () => ({
        status: 200,
        body: await runtimeObjects.upload({
          objectId: objectId.data,
          assignmentId: headers.data.assignmentId,
          assignmentEpoch: headers.data.assignmentEpoch,
          generation: headers.data.generation,
          sizeBytes: headers.data.sizeBytes,
          sha256: headers.data.sha256,
          chunks: uploadStream as AsyncIterable<Uint8Array>,
        }),
      }),
    });
  });

  app.get("/runtime-objects/:id/content", async (req, reply) => {
    const objectId = z
      .string()
      .uuid()
      .safeParse((req.params as { id?: unknown }).id);

    if (!objectId.success) {
      throw new SupervisorError(
        "PRECONDITION",
        "runtime object id is invalid",
        {
          details: { reason: "runtime_object_missing" },
        },
      );
    }
    const content = await runtimeObjects.read(objectId.data);
    const total = content.metadata.sizeBytes;

    if (total === null) throw new Error("available runtime object has no size");
    const maxRangeBytes = 8 * 1024 * 1024;
    const range = req.headers.range;

    if (range && Array.isArray(range)) {
      throw new SupervisorError(
        "PRECONDITION",
        "runtime object range is invalid",
        {
          details: { reason: "runtime_object_range_invalid" },
        },
      );
    }
    const match = range?.match(/^bytes=(\d+)-(\d*)$/);

    if (range && !match) {
      throw new SupervisorError(
        "PRECONDITION",
        "runtime object range is invalid",
        {
          details: { reason: "runtime_object_range_invalid" },
        },
      );
    }
    if (!match) {
      if (total > maxRangeBytes) {
        throw new SupervisorError(
          "PRECONDITION",
          "a runtime object larger than 8 MiB requires an explicit byte range",
          { details: { reason: "runtime_object_range_invalid" } },
        );
      }
      reply
        .header("Accept-Ranges", "bytes")
        .header("Content-Type", content.metadata.mimeType)
        .header("Content-Length", String(total))
        .header("ETag", `\"${content.metadata.sha256}\"`)
        .header(
          "Content-Digest",
          `sha-256=:${Buffer.from(content.metadata.sha256 ?? "", "hex").toString("base64")}:`,
        );

      return reply.status(200).send(createReadStream(content.path));
    }
    const start = Number(match[1]);
    const requestedEnd = match[2] ? Number(match[2]) : total - 1;
    const requestedLength = requestedEnd - start + 1;

    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(requestedEnd) ||
      start >= total ||
      requestedEnd < start ||
      requestedEnd >= total ||
      requestedLength > maxRangeBytes
    ) {
      throw new SupervisorError(
        "PRECONDITION",
        "runtime object range is invalid",
        {
          details: { reason: "runtime_object_range_invalid" },
        },
      );
    }
    reply
      .header("Accept-Ranges", "bytes")
      .header("Content-Type", content.metadata.mimeType)
      .header("Content-Length", String(requestedLength))
      .header("ETag", `\"${content.metadata.sha256}\"`)
      .header(
        "Content-Digest",
        `sha-256=:${Buffer.from(content.metadata.sha256 ?? "", "hex").toString("base64")}:`,
      );

    return reply
      .header("Content-Range", `bytes ${start}-${requestedEnd}/${total}`)
      .status(206)
      .send(createReadStream(content.path, { start, end: requestedEnd }));
  });

  app.delete("/runtime-objects/:id", async (req, reply) => {
    const objectId = z
      .string()
      .uuid()
      .safeParse((req.params as { id?: unknown }).id);

    if (!objectId.success) {
      throw new SupervisorError(
        "PRECONDITION",
        "runtime object id is invalid",
        {
          details: { reason: "runtime_object_missing" },
        },
      );
    }
    const object = hostState.getRuntimeObject(objectId.data);

    if (!object) {
      throw new SupervisorError("PRECONDITION", "runtime object is missing", {
        details: { reason: "runtime_object_missing" },
      });
    }
    const parsed = parseCommandBody(
      req.body,
      "runtime_object.delete",
      DeleteRuntimeObjectPayloadSchema,
      { route: "DELETE /runtime-objects/:id" },
    );

    await runRuntimeObjectDeleteCommand({
      reply,
      parsed,
      object,
      runtimeEvent: (transition) =>
        transition.phase === "accepted"
          ? null
          : runtimeObjectEvent(parsed.envelope.fence, transition.outcome),
      execute: async () => ({
        status: 204,
        body: await runtimeObjects.remove({
          objectId: objectId.data,
          assignmentId: parsed.envelope.fence.assignmentId,
          assignmentEpoch: parsed.envelope.fence.assignmentEpoch,
          generation: parsed.payload.generation,
        }),
      }),
    });
  });

  // Stage B host-global outbox transport. `Last-Event-ID` is an exclusive
  // decimal sequence cursor; reconnect first replays durable SQLite rows, then
  // receives only committed appends. A slow socket is closed rather than
  // buffering payloads: reconnect resumes from the same durable cursor.
  app.get("/runtime-events", (req, reply) => {
    const afterSequence = parseRuntimeEventCursor(req.headers["last-event-id"]);
    const streamId = hostState.getRuntimeEventStreamId();
    let replay: ReturnType<typeof hostState.runtimeEventsAfter>;

    try {
      replay = hostState.runtimeEventsAfter(streamId, afterSequence, 500);
    } catch (error) {
      throw runtimeEventSupervisorError(error);
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.flushHeaders();

    let closed = false;
    let replaying = true;
    let highestSequence = afterSequence;
    const pending: ReturnType<typeof hostState.runtimeEventsAfter> = [];
    const send = (
      event: ReturnType<typeof hostState.runtimeEventsAfter>[number],
    ): void => {
      if (closed) return;
      if (
        highestSequence !== null &&
        BigInt(event.sequence) <= BigInt(highestSequence)
      ) {
        return;
      }

      const frame = `id: ${event.sequence}\nevent: ${String(event.envelope.eventType)}\ndata: ${JSON.stringify(event.envelope)}\n\n`;

      highestSequence = event.sequence;
      if (!reply.raw.write(frame)) {
        close("slow_client");
      }
    };
    const close = (
      reason: "disconnect" | "slow_client" | "replay_page",
    ): void => {
      if (closed) return;
      closed = true;
      unsubscribe();
      logger.info(
        {
          streamId,
          afterSequence,
          highestSequence,
          reason,
          pending: pending.length,
        },
        "runtime-event-stream-closed",
      );
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    const unsubscribe = hostState.subscribeRuntimeEvents((event) => {
      if (event.streamId !== streamId || closed) return;

      if (replaying) {
        if (pending.length >= MAX_RUNTIME_EVENT_SSE_PENDING) {
          close("slow_client");

          return;
        }
        pending.push(event);

        return;
      }
      send(event);
    });

    req.raw.once("close", () => close("disconnect"));
    logger.info(
      { streamId, afterSequence, replayCount: replay.length },
      "runtime-event-stream-opened",
    );

    for (const event of replay) send(event);
    if (
      !closed &&
      highestSequence !== null &&
      hostState.hasRuntimeEventsAfter(streamId, highestSequence)
    ) {
      close("replay_page");
    }
    replaying = false;
    pending
      .sort((left, right) =>
        BigInt(left.sequence) < BigInt(right.sequence) ? -1 : 1,
      )
      .forEach(send);
  });

  app.post("/runtime-events/ack", async (req, reply) => {
    const parsed = RuntimeEventAckSchema.safeParse(req.body);

    if (!parsed.success) {
      throw new SupervisorError(
        "PRECONDITION",
        "runtime event acknowledgement has an invalid stream or sequence",
        { details: { reason: "invalid_event_sequence" } },
      );
    }
    const currentStreamId = hostState.getRuntimeEventStreamId();

    if (parsed.data.streamId !== currentStreamId) {
      throw new SupervisorError(
        "PRECONDITION",
        "runtime event acknowledgement names a different host stream",
        { details: { reason: "stream_identity_conflict" } },
      );
    }

    try {
      const acknowledgedThrough = hostState.ackRuntimeEvents(
        parsed.data.streamId,
        parsed.data.throughSequence,
      );

      logger.info(
        {
          streamId: parsed.data.streamId,
          throughSequence: parsed.data.throughSequence,
          acknowledgedThrough,
          queueDepth: hostState.runtimeEventOutboxStats().unacknowledgedCount,
        },
        "runtime-event-acknowledged",
      );
      reply.status(200).send({
        streamId: parsed.data.streamId,
        acknowledgedThrough,
      });
    } catch (error) {
      throw runtimeEventSupervisorError(error);
    }
  });

  app.get("/diagnostics", async (_req, reply) => {
    const smokeCache = await readAdapterSmokeCache(
      adapterSmokeCachePath(runtimeRoot),
    );
    const body: SupervisorDiagnosticsResponse = {
      status: "ready",
      version: SUPERVISOR_VERSION,
      checkedAt: new Date().toISOString(),
      adapters: await Promise.all(
        listAdapterRuntimes().map((runtime) =>
          diagnoseAdapterBinary(runtime, smokeCache, logger),
        ),
      ),
      envRefs: diagnosticEnvRefs(),
    };

    reply.status(200).send(body);
  });

  // ADR-166 D7: the ONLY path-bearing route. Registers a host-local path for a
  // run as an opaque handle; every later route derives its paths from it.
  app.post("/workspaces/adopt", async (req, reply) => {
    const parsed = parseCommandBody(
      req.body,
      "workspace.adopt",
      AdoptWorkspacePayloadSchema,
      { route: "POST /workspaces/adopt" },
    );

    await runCommand({
      reply,
      parsed,
      kind: "workspace.adopt",
      expectedRunId: parsed.payload.runId,
      execute: async () => {
        const { handle, replayed } = await workspaces.adopt(parsed.payload);
        const body: AdoptWorkspaceResponse = {
          executionWorkspaceId: handle.id,
          kind: handle.kind as WorkspaceKind,
          replayed,
        };

        logger.info(
          {
            executionWorkspaceId: handle.id,
            runId: handle.runId,
            kind: handle.kind,
            replayed,
            status: 200,
          },
          "http POST /workspaces/adopt",
        );

        return { status: 200, body };
      },
    });
  });

  app.get<SessionIdParams>("/workspaces/:id", async (req, reply) => {
    const handle = workspaces.get(req.params.id);

    if (!handle) {
      reply.status(404).send({
        code: "PRECONDITION",
        message: "unknown execution workspace",
        details: { reason: "unknown_workspace" },
      });

      return;
    }

    const body: WorkspaceRecordResponse = {
      executionWorkspaceId: handle.id,
      runId: handle.runId,
      projectSlug: handle.projectSlug,
      kind: handle.kind as WorkspaceKind,
      adoptedAt: handle.adoptedAt,
      releasedAt: handle.releasedAt,
    };

    reply.status(200).send(body);
  });

  app.delete<SessionIdParams>("/workspaces/:id", async (req, reply) => {
    const handle = workspaces.get(req.params.id);

    if (!handle) {
      reply.status(404).send({
        code: "PRECONDITION",
        message: "unknown execution workspace",
        details: { reason: "unknown_workspace" },
      });

      return;
    }

    const parsed = parseCommandBody(
      req.body,
      "workspace.release",
      EmptyPayloadSchema,
      { route: "DELETE /workspaces/:id" },
    );

    await runCommand({
      reply,
      parsed,
      kind: "workspace.release",
      expectedRunId: handle.runId,
      execute: async () => {
        const released = workspaces.release(handle.id);

        logger.info(
          { executionWorkspaceId: handle.id, released, status: 200 },
          "http DELETE /workspaces/:id",
        );

        return { status: 200, body: { released } };
      },
    });
  });

  app.get<CommandIdParams>("/commands/:commandId", async (req, reply) => {
    const receipt = receipts.lookup(req.params.commandId);

    if (!receipt) {
      reply
        .status(404)
        .send({ code: "PRECONDITION", message: "unknown command" });

      return;
    }

    reply
      .status(200)
      .send(
        receiptToResponse(receipt, receipts.hasInflight(req.params.commandId)),
      );
  });

  app.post("/sessions", async (req, reply) => {
    const parsed = parseCommandBody(
      req.body,
      "session.create",
      StartSessionRequestSchema,
      {
        route: "POST /sessions",
        guard: (payload) => {
          const field = legacySessionPathField(payload);

          if (field) {
            throw new SupervisorError(
              "PRECONDITION",
              `${field} is a legacy path field; adopt the workspace and send executionWorkspaceId`,
              { details: { reason: "legacy_field", field } },
            );
          }
        },
      },
    );
    const request = parsed.payload;
    // The handle's run binds the fence (`run_mismatch`) before execution; its
    // validity (`unknown_workspace` / `workspace_released`) is judged inside
    // the receipt-guarded execution, so a duplicate id replays its stored
    // outcome even after the handle was released.
    const handle = workspaces.get(request.executionWorkspaceId);

    await runCommand({
      reply,
      parsed,
      kind: "session.create",
      expectedRunId: handle?.runId,
      execute: async () => {
        // ADR-166 D7: cwd, confinement roots, run dir, and mounts all derive
        // from the adopted handle (server state) — the single path-derivation
        // site.
        const workspace: WorkspaceResolution = workspaces.resolveForSession(
          request.executionWorkspaceId,
          { stepId: request.stepId },
        );
        const sessionId = randomUUID();
        const outputPaths: Partial<
          Record<RuntimeObjectOutputBinding["envName"], string>
        > = {};
        const outputObjectIds = new Set<string>();
        const outputEnvironmentNames = new Set<string>();

        for (const binding of request.outputObjects ?? []) {
          if (
            outputObjectIds.has(binding.objectId) ||
            outputEnvironmentNames.has(binding.envName)
          ) {
            throw new SupervisorError(
              "PRECONDITION",
              "runtime output bindings must use unique object IDs and environment names",
              { details: { reason: "command_invariant_conflict" } },
            );
          }
          outputObjectIds.add(binding.objectId);
          outputEnvironmentNames.add(binding.envName);
        }
        let spawned: Awaited<ReturnType<typeof spawnSession>>;

        try {
          for (const binding of request.outputObjects ?? []) {
            const allocated = await runtimeObjects.allocateOutput({
              runId: parsed.envelope.fence.runId,
              assignmentId: parsed.envelope.fence.assignmentId,
              assignmentEpoch: parsed.envelope.fence.assignmentEpoch,
              hostSessionId: sessionId,
              binding,
            });

            outputPaths[binding.envName] = allocated.path;
          }
          const capabilityProfile = request.capabilityProfileObjectId
            ? await runtimeObjects.resolvePromptReference({
                objectId: request.capabilityProfileObjectId,
                runId: parsed.envelope.fence.runId,
                assignmentId: parsed.envelope.fence.assignmentId,
                assignmentEpoch: parsed.envelope.fence.assignmentEpoch,
                expectedKind: "capability_profile",
              })
            : null;
          const capabilityInstructions = request.capabilityInstructionsObjectId
            ? await runtimeObjects.resolvePromptReference({
                objectId: request.capabilityInstructionsObjectId,
                runId: parsed.envelope.fence.runId,
                assignmentId: parsed.envelope.fence.assignmentId,
                assignmentEpoch: parsed.envelope.fence.assignmentEpoch,
                expectedKind: "capability_instructions",
              })
            : null;

          spawned = await spawnSession({
            sessionId,
            hostState,
            runtimeEventPublisher: runtimeEvents,
            request,
            workspace,
            createdBy: {
              commandId: parsed.envelope.command.id,
              assignmentId: parsed.envelope.fence.assignmentId,
              assignmentEpoch: parsed.envelope.fence.assignmentEpoch,
            },
            logger,
            binaryOverride: opts.spawnOverrides?.binary,
            preArgs: opts.spawnOverrides?.preArgs,
            runtimeObjectEnv: {
              capabilityProfilePath: capabilityProfile?.path,
              capabilityInstructionsPath: capabilityInstructions?.path,
              outputPaths,
              outputObjectIds: [...outputObjectIds],
            },
          });
        } catch (error) {
          await runtimeObjects.discardPendingOutputs({
            objectIds: [...outputObjectIds],
            hostSessionId: sessionId,
          });
          throw error;
        }
        const { child, emitter, record, acpStdoutTap } = spawned;

        // M34 lifecycle: propagate the reap-on-end-turn flag onto the record so
        // the prompt handler can reap a one-shot agent session when its turn ends.
        record.reapOnEndTurn = request.reapOnEndTurn === true;
        registry.register(record, child, emitter, {
          runtimeEventPublisher: runtimeEvents,
        });
        attachHeartbeat({ sessionId, child, registry, logger });
        await attachCost({
          sessionId,
          sessionName: record.sessionName,
          projectSlug: workspace.projectSlug,
          runId: workspace.runId,
          stepId: request.stepId,
          nodeAttemptId: request.nodeAttemptId,
          getContext: () => {
            const latest = registry.get(sessionId)?.record;

            return {
              stepId: latest?.stepId,
              nodeAttemptId: latest?.nodeAttemptId,
            };
          },
          emitter,
          logger,
          resumed: Boolean(request.resumeSessionId),
          onRecorded: (cost) => {
            const latest = registry.get(sessionId)?.record;

            if (!latest) {
              throw new Error(
                `cannot publish canonical usage for removed session ${sessionId}`,
              );
            }
            runtimeEvents.publishUsage(latest, cost);
          },
        });

        if (!child.stdin) {
          throw new SupervisorError("SPAWN", "child has no stdin for ACP");
        }

        let connection: acp.ClientSideConnection;
        let acpSessionId: string;

        try {
          const result = await createAcpConnection({
            stdin: child.stdin,
            stdoutSource: acpStdoutTap,
            sessionId,
            worktreePath: workspace.cwd,
            record,
            emitter,
            logger,
            adapter: request.runner?.adapter ?? request.executor.agent,
            mcpServers: request.mcpServers,
            resumeSessionId: request.resumeSessionId,
            runner: request.runner,
          });

          connection = result.connection;
          acpSessionId = result.acpSessionId;
        } catch (err) {
          const entry = registry.get(sessionId);
          const message = err instanceof Error ? err.message : String(err);

          logger.warn({ sessionId, err: message }, "acp handshake failed");
          registry.markIntentionalShutdown(sessionId, "intentional");
          child.kill("SIGTERM");

          if (entry) {
            const exited = await waitForChildExit(entry, killGraceMs);

            if (!exited) {
              logger.warn(
                { sessionId, killGraceMs },
                "acp-handshake-failed-sigterm-grace-expired-sigkill",
              );
              child.kill("SIGKILL");
            }
          }

          registry.remove(sessionId, "acp-handshake-failed");
          throw err;
        }

        registry.attachAcp(sessionId, connection, acpSessionId);
        runtimeEvents.publishSessionCreated(record);

        logger.info(
          {
            sessionId,
            runId: workspace.runId,
            executionWorkspaceId: workspace.executionWorkspaceId,
            assignmentId: record.assignmentId,
            assignmentEpoch: record.assignmentEpoch,
            commandId: record.createdByCommandId,
            pid: record.pid,
            acpSessionId,
            status: 201,
          },
          "http POST /sessions",
        );

        return {
          status: 201,
          body: { sessionId, pid: record.pid, acpSessionId },
        };
      },
    });
  });

  // Prompt admission is short-lived. Its durable receipt is the authoritative
  // completion seam; the asynchronous turn itself publishes canonical events.
  app.post<SessionIdParams>("/sessions/:id/prompts", async (req, reply) => {
    const entry = registry.get(req.params.id);

    if (!entry) {
      reply
        .status(404)
        .send({ code: "PRECONDITION", message: "unknown session" });

      return;
    }
    const parsed = parseCommandBody(
      req.body,
      "session.prompt",
      SendPromptRequestSchema,
      { route: "POST /sessions/:id/prompts" },
    );

    await runAsyncPromptCommand({
      reply,
      parsed,
      entry,
      execute: () =>
        executePromptTurn({ entry, sessionId: req.params.id, parsed }),
    });
  });

  // Interrupt the in-flight prompt turn WITHOUT tearing the session down: a
  // protocol-level `session/cancel` notification (adapter-agnostic — claude,
  // codex, gemini, opencode all honour it). The asynchronous prompt command
  // terminalizes with the `cancelled` stop reason; the cancelRequested flag
  // makes sendPromptOnConnection treat that as a clean turn end (session stays
  // live, dialog returns to WaitingForUser) rather than a crash. Idempotent: a
  // non-live or connectionless session acks with cancelled:false.
  app.post<SessionIdParams>("/sessions/:id/cancel", async (req, reply) => {
    const sessionId = req.params.id;
    const entry = registry.get(sessionId);

    if (!entry) {
      reply
        .status(404)
        .send({ code: "PRECONDITION", message: "unknown session" });

      return;
    }

    const parsed = parseCommandBody(
      req.body,
      "session.cancel",
      EmptyPayloadSchema,
      { route: "POST /sessions/:id/cancel" },
    );

    await runCommand({
      reply,
      parsed,
      kind: "session.cancel",
      expectedRunId: entry.record.runId,
      entry,
      execute: async () => {
        if (
          entry.record.status !== "live" ||
          !entry.connection ||
          !entry.acpSessionId
        ) {
          logger.info(
            { sessionId, status: entry.record.status },
            "cancel endpoint idempotent ack (no live turn)",
          );

          return { status: 200, body: { cancelled: false, sessionId } };
        }

        entry.record.cancelRequested = true;

        // A turn blocked on a permission HITL must unblock too: resolve every
        // open deferred with the cancelled outcome (ACP requires the client to
        // answer a pending requestPermission with Cancelled when it cancels the
        // turn).
        for (const requestId of pendingPermissions.requestIds(sessionId)) {
          pendingPermissions.cancel(sessionId, requestId, "user-cancel");
        }

        await entry.connection.cancel({ sessionId: entry.acpSessionId });

        logger.info({ sessionId }, "http POST /sessions/:id/cancel");

        return { status: 200, body: { cancelled: true, sessionId } };
      },
    });
  });

  app.delete<SessionIdParams>("/sessions/:id", async (req, reply) => {
    const entry = registry.get(req.params.id);

    if (!entry) {
      reply
        .status(404)
        .send({ code: "PRECONDITION", message: "unknown session" });

      return;
    }

    const parsed = parseCommandBody(
      req.body,
      "session.delete",
      EmptyPayloadSchema,
      { route: "DELETE /sessions/:id" },
    );

    await runCommand({
      reply,
      parsed,
      kind: "session.delete",
      expectedRunId: entry.record.runId,
      entry,
      execute: async () => {
        registry.markIntentionalShutdown(req.params.id, "intentional");
        entry.record.stopOutputForTeardown?.();
        entry.child.kill("SIGTERM");
        const exited = await waitForChildExit(entry, killGraceMs);

        if (!exited) {
          logger.warn(
            { sessionId: req.params.id, killGraceMs },
            "sigterm-grace-expired-sigkill",
          );
          entry.child.kill("SIGKILL");
        }

        logger.info(
          { sessionId: req.params.id, status: 204 },
          "http DELETE /sessions/:id",
        );

        return { status: 204, body: {} };
      },
    });
  });

  app.get("/sessions", async (_req, reply) => {
    reply.send(registry.list().map(toSessionListEntry));
  });

  app.get<SessionIdParams>("/sessions/:id/stream", (req, reply) => {
    const sessionId = req.params.id;
    const entry = registry.get(sessionId);

    if (!entry) {
      reply
        .status(404)
        .send({ code: "PRECONDITION", message: "unknown session" });

      return;
    }

    const lastEventId = Number(req.headers["last-event-id"] ?? 0);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.flushHeaders();

    logger.debug({ sessionId, lastEventId }, "sse-connect");

    let highestSent = lastEventId;
    let terminalSent = false;
    const send = (event: SessionEvent) => {
      if (terminalSent) return;
      if (event.monotonicId <= highestSent) return;

      highestSent = event.monotonicId;
      const payload = `id: ${event.monotonicId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

      reply.raw.write(payload);

      if (event.type === "session.exited" || event.type === "session.crashed") {
        terminalSent = true;
        reply.raw.end();
      }
    };

    const unsubscribe = registry.subscribe(sessionId, send);

    req.raw.on("close", () => {
      unsubscribe();
      logger.debug(
        { sessionId, reason: "client-disconnect" },
        "sse-disconnect",
      );
    });

    for (const buffered of registry.snapshotEvents(sessionId)) {
      send(buffered);
    }

    if (!terminalSent && entry.record.status === "exited") {
      send({
        type: "session.exited",
        sessionId,
        monotonicId: entry.record.monotonicId,
        exitCode: entry.record.exitCode ?? 0,
      });
    } else if (!terminalSent && entry.record.status === "crashed") {
      send({
        type: "session.crashed",
        sessionId,
        monotonicId: entry.record.monotonicId,
        exitCode: entry.record.exitCode ?? null,
        signal: entry.record.signal ?? null,
      });
    }
  });

  // M8 T4: real graceful checkpoint. Cancels every open permission
  // deferred for the session with reason="checkpoint" (so the agent
  // records "replay on resume" markers in its session journal),
  // then SIGTERMs the child with a configurable grace window. On
  // SIGKILL escalation we return 503 EXECUTOR_UNAVAILABLE — the web
  // sweeper treats this as retryable; the next tick re-attempts.
  // Idempotent on already-exited sessions: returns 200 with
  // `alreadyCheckpointed: true` and the most recent monotonicId.
  // Identifier table (D11):
  //   sessionId  → URL path     (`url-param`)
  //   body       → request body (empty — Zod strict reject unknown)
  // NO body fields. NO cross-resource ids.
  app.post<SessionIdParams>("/sessions/:id/checkpoint", async (req, reply) => {
    const sessionId = req.params.id;
    const startedAt = Date.now();
    // Body validation precedes the session lookup (D11: unknown keys are
    // rejected before any server-state read).
    const parsed = parseCommandBody(
      req.body,
      "session.checkpoint",
      EmptyPayloadSchema,
      { route: "POST /sessions/:id/checkpoint" },
    );
    const entry = registry.get(sessionId);

    if (!entry) {
      reply
        .status(404)
        .send({ code: "PRECONDITION", message: "unknown session" });

      return;
    }

    await runCommand({
      reply,
      parsed,
      kind: "session.checkpoint",
      expectedRunId: entry.record.runId,
      entry,
      execute: async () => {
        const checkpointLog = logger.child({ name: "supervisor-checkpoint" });

        // Idempotency: if the child is already gone, return 200 with the
        // current state. The sweeper may hit this branch when the
        // supervisor restarted between two ticks.
        if (
          entry.record.status === "exited" ||
          entry.record.status === "crashed"
        ) {
          checkpointLog.info(
            {
              sessionId,
              status: entry.record.status,
              alreadyCheckpointed: true,
            },
            "checkpoint endpoint idempotent ack",
          );

          return {
            status: 200,
            body: {
              alreadyCheckpointed: true,
              sessionId,
              monotonicId: entry.record.monotonicId,
            },
          };
        }

        const requestIds = pendingPermissions.requestIds(sessionId);

        checkpointLog.info(
          {
            sessionId,
            pendingPermissionCount: requestIds.length,
          },
          "checkpoint requested",
        );

        for (const requestId of requestIds) {
          pendingPermissions.cancel(sessionId, requestId, "checkpoint");
        }

        registry.markIntentionalShutdown(sessionId, "checkpoint");
        entry.record.stopOutputForTeardown?.();
        entry.child.kill("SIGTERM");

        const exited = await waitForChildExit(entry, killGraceMs);

        if (!exited) {
          checkpointLog.warn(
            { sessionId, killGraceMs },
            "checkpoint sigterm-grace-expired-sigkill",
          );
          entry.child.kill("SIGKILL");

          throw new SupervisorError(
            "EXECUTOR_UNAVAILABLE",
            `checkpoint timed out — SIGKILL escalation after ${killGraceMs}ms`,
          );
        }

        const latencyMs = Date.now() - startedAt;

        checkpointLog.info(
          {
            sessionId,
            latencyMs,
            pendingPermissionCount: requestIds.length,
            alreadyCheckpointed: false,
          },
          "checkpoint complete",
        );

        return {
          status: 200,
          body: {
            alreadyCheckpointed: false,
            sessionId,
            monotonicId: entry.record.monotonicId,
          },
        };
      },
    });
  });

  app.post<SessionIdParams>("/sessions/:id/input", async (req, reply) => {
    const sessionId = req.params.id;
    const startedAt = Date.now();
    const parsed = parseCommandBody(
      req.body,
      "session.input",
      InputBodySchema,
      { route: "POST /sessions/:id/input" },
    );
    const body = parsed.payload;
    const entry = registry.get(sessionId);

    if (!entry) {
      // Distinct from "unknown requestId": an unknown session typically
      // means the supervisor restarted (or the session crashed) AFTER
      // the deferred was minted. The user's reply is still valid; the
      // recovery path is "retry once the supervisor has reconciled".
      // We classify as EXECUTOR_UNAVAILABLE (retryable) so the web tier
      // does NOT mark the run Failed.
      logger.warn(
        { sessionId, action: body.action, requestId: body.requestId },
        "input route: unknown session — likely supervisor restart",
      );
      reply.status(503).send({
        code: "EXECUTOR_UNAVAILABLE",
        message: "unknown session — supervisor may have restarted",
      });

      return;
    }

    await runCommand({
      reply,
      parsed,
      kind: "session.input",
      expectedRunId: entry.record.runId,
      entry,
      execute: async () => {
        let ok: boolean;

        if (body.action === "select") {
          ok = pendingPermissions.resolve(
            sessionId,
            body.requestId,
            body.optionId as string,
          );
        } else {
          ok = pendingPermissions.cancel(
            sessionId,
            body.requestId,
            body.reason ?? "client-cancelled",
          );
        }

        const outcome: "ok" | "missing" = ok ? "ok" : "missing";
        const latencyMs = Date.now() - startedAt;

        logger.info(
          {
            sessionId,
            action: body.action,
            requestId: body.requestId,
            latencyMs,
            outcome,
          },
          "http POST /sessions/:id/input",
        );

        if (!ok) {
          // Distinct from "unknown session": the session is alive but the
          // requested deferred is missing — almost always means the
          // MAISTER_KEEPALIVE_MINUTES timeout already fired (or another
          // request resolved/cancelled the same deferred). Classify as
          // HITL_TIMEOUT so the web tier treats it as terminal.
          throw new SupervisorError(
            "HITL_TIMEOUT",
            "no pending permission with that requestId",
          );
        }

        return { status: 200, body: { ok: true } };
      },
    });
  });

  // ADR-076 model discovery. Body = runner draft with BARE env-ref names; an
  // env:-prefixed or raw secret is rejected by RunnerProviderSchema → ZodError →
  // 409 PRECONDITION via setErrorHandler. A per-source failure NEVER fails the
  // resolve — it surfaces as that source's status inside a 200. `force` bypasses
  // the in-memory cache. Secrets resolve supervisor-side and are never returned.
  app.post("/model-catalog/resolve", async (req, reply) => {
    const draft = ModelCatalogDraftSchema.parse(req.body);

    if (!draft.force) {
      const hit = mcCache.get(draft);

      if (hit) {
        logger.info(
          {
            adapter: draft.adapter,
            provider: draft.provider.kind,
            cache: "hit",
            status: 200,
          },
          "http POST /model-catalog/resolve",
        );
        reply.status(200).send(hit);

        return;
      }
    }

    const result = await resolveModelCatalog(draft, mcRegistry, { logger });

    mcCache.set(draft, result);
    logger.info(
      {
        adapter: draft.adapter,
        provider: draft.provider.kind,
        cache: draft.force ? "force" : "miss",
        models: result.models.length,
        sources: result.sources.map((s) => `${s.kind}:${s.status}`),
        status: 200,
      },
      "http POST /model-catalog/resolve",
    );
    reply.status(200).send(result);
  });

  // ADR-129 (W-F): real MCP `initialize` handshake against a target server. The
  // body carries NAMES only; the supervisor resolves values from process.env.
  // The web probe proxy is the only caller: it is admin-gated and refuses an
  // untrusted-source PLATFORM stdio probe before reaching here (D4). A
  // package/project stdio probe is an explicit admin "test connection" spawn (no
  // exec-trust axis at probe time — that gates RUN materialization, not this
  // one-shot handshake). Deferred-release teardown lives in probeMcpServer.
  app.post("/mcp-probe", async (req, reply) => {
    const probe = McpProbeRequestSchema.parse(req.body);
    const result = await probeMcpServer(probe);

    logger.info(
      {
        transport: probe.transport,
        ok: result.ok,
        latencyMs: result.latencyMs,
      },
      "http POST /mcp-probe",
    );
    reply.status(200).send(result);
  });
}

// ADR-166 X-EH-19: an evicted session's pending prompt answers 409 FENCED.
function throwIfFenced(entry: RegistryEntry, envelope: CommandEnvelope): void {
  const hostEpoch = entry.record.fencedByEpoch;

  if (hostEpoch === undefined) return;

  throw new SupervisorError(
    "FENCED",
    `session ${entry.record.sessionId} was evicted by assignment epoch ${hostEpoch}`,
    {
      details: {
        reason: "assignment_fenced",
        runId: entry.record.runId,
        commandEpoch: envelope.fence.assignmentEpoch,
        hostEpoch,
      },
    },
  );
}
