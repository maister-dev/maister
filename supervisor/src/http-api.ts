import type { FastifyInstance, FastifyReply } from "fastify";
import type * as acp from "@agentclientprotocol/sdk";
import type { Logger } from "pino";
import type { HostState } from "./host-state";
import type { SessionRegistry, RegistryEntry } from "./registry";
import type { WorkspaceResolution } from "./workspace-registry";

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, appendFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import { z, ZodError, type ZodType, type ZodTypeDef } from "zod";

import { createAcpConnection, sendPromptOnConnection } from "./acp-client";
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
import { applyFence, evictLowerEpochSessions } from "./execution-fence";
import { attachHeartbeat } from "./heartbeat";
import { EXECUTION_HOST_PROTOCOL_VERSION, openHostState } from "./host-state";
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
import { SESSION_EVENT_CHANNEL } from "./registry";
import { spawnSession } from "./spawn";
import {
  AdoptWorkspacePayloadSchema,
  CommandEnvelopeSchema,
  errorBody,
  httpStatusForCode,
  isEnvelopedBody,
  isHandleForm,
  isSupervisorError,
  parseGateChatHitlId,
  SendPromptRequestSchema,
  StartSessionRequestSchema,
  SupervisorError,
  type AdoptWorkspaceResponse,
  type CommandEnvelope,
  type CommandKind,
  type SessionEvent,
  type SessionStatus,
  type SupervisorDiagnosticsResponse,
  type SupervisorErrorBody,
  type SupervisorHealthResponse,
  type WorkspaceKind,
  type WorkspaceRecordResponse,
} from "./types";
import { legacyResolution, WorkspaceRegistry } from "./workspace-registry";
import { parseWorkspaceRoots } from "./workspace-roots";

// ADR-164: the `payload` of every enveloped teardown-class command is `{}`.
const EmptyPayloadSchema = z.object({}).strict();

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

// M8 T4 + T5: empty-body Zod schema for POST /sessions/:id/checkpoint.
// Rejects unknown keys so callers cannot smuggle body-controlled fields
// onto the checkpoint surface (D11 identifier-table rule).
export const CheckpointBodySchema = z.object({}).strict();

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
  // ADR-164: the execution-host state store (identity, fences, receipts,
  // handles) and the adoption roots. A route-only boot (tests) gets an
  // in-memory store with a minted key.
  hostState?: HostState;
  workspaceRoots?: string[];
};

type SessionIdParams = { Params: { id: string } };
type CommandIdParams = { Params: { commandId: string } };

type ParsedCommand<T> = {
  envelope: CommandEnvelope | null;
  payload: T;
};

const SESSION_COMMAND_KIND_SET: ReadonlySet<string> = new Set([
  "session.prompt",
  "session.input",
  "session.cancel",
  "session.checkpoint",
  "session.delete",
]);

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
  const hostState = opts.hostState ?? openHostState({ inMemory: true, logger });
  const receipts = new CommandReceipts(hostState, logger);
  const workspaces = new WorkspaceRegistry({
    state: hostState,
    roots:
      opts.workspaceRoots ??
      parseWorkspaceRoots(process.env.MAISTER_WORKSPACE_ROOTS, runtimeRoot),
    runtimeRoot,
    logger,
  });
  const fenceLog = logger.child({ component: "execution-fence" });

  // ADR-164 D4/D10 (transitional): an enveloped body is parsed as
  // `CommandEnvelope` whose `payload` is the route's pre-ADR-164 body; a bare
  // body is the legacy form, accepted with a WARN until the strict flip.
  function parseCommandBody<T>(
    body: unknown,
    kind: CommandKind,
    payloadSchema: ZodType<T, ZodTypeDef, unknown>,
    options: { route: string; allowLegacy: boolean },
  ): ParsedCommand<T> {
    if (isEnvelopedBody(body)) {
      const envelope = CommandEnvelopeSchema.parse(body);

      if (envelope.command.kind !== kind) {
        throw new SupervisorError(
          "PRECONDITION",
          `command.kind ${envelope.command.kind} does not match route kind ${kind}`,
        );
      }

      return { envelope, payload: payloadSchema.parse(envelope.payload) };
    }

    if (!options.allowLegacy) {
      throw new SupervisorError(
        "PRECONDITION",
        `${options.route} requires a command envelope`,
        { details: { reason: "missing_envelope" } },
      );
    }

    logger.warn({ route: options.route, kind }, "legacy-unfenced-command");

    return { envelope: null, payload: payloadSchema.parse(body ?? {}) };
  }

  // ADR-164 D5: the durable completion signal that is NOT the long-lived HTTP
  // response. After a terminal `session.exited` the registry has closed the
  // per-run events log, so a post-terminal completion is appended directly.
  function emitCommandEvent(
    entry: RegistryEntry,
    event: Omit<
      Extract<SessionEvent, { type: "session.command" }>,
      "sessionId" | "monotonicId"
    >,
  ): void {
    entry.record.monotonicId += 1;
    const full: SessionEvent = {
      ...event,
      sessionId: entry.record.sessionId,
      monotonicId: entry.record.monotonicId,
    };

    entry.emitter.emit(SESSION_EVENT_CHANNEL, full);

    if (entry.eventsLog?.isClosed()) {
      const stamped = {
        ...full,
        sessionName: entry.record.sessionName,
        ...(entry.record.nodeAttemptId
          ? { nodeAttemptId: entry.record.nodeAttemptId }
          : {}),
      };

      void appendFile(
        entry.eventsLog.path(),
        `${JSON.stringify(stamped)}\n`,
      ).catch((err: unknown) => {
        logger.warn(
          {
            sessionId: entry.record.sessionId,
            commandId: event.commandId,
            err: err instanceof Error ? err.message : String(err),
          },
          "session-command-append-failed",
        );
      });
    }
  }

  function commandStatus(
    outcome: CommandOutcome,
  ): "succeeded" | "failed" | "fenced" {
    if (outcome.status < 400) return "succeeded";

    const body = outcome.body as SupervisorErrorBody | null;

    return body?.code === "FENCED" ? "fenced" : "failed";
  }

  // ADR-164 D6 handler order for every enveloped route: parse → fence (persist
  // the high-water, evict lower-epoch sessions) → receipt lookup / in-flight
  // join → execute → write receipt → respond (+ `session.command` events).
  async function runCommand(args: {
    reply: FastifyReply;
    parsed: ParsedCommand<unknown>;
    kind: CommandKind;
    expectedRunId?: string;
    entry?: RegistryEntry;
    execute: () => Promise<CommandOutcome>;
  }): Promise<void> {
    const { reply, parsed, kind, entry } = args;
    const envelope = parsed.envelope;
    const sessionKind = SESSION_COMMAND_KIND_SET.has(kind);
    let outcome: CommandOutcome & { replayed: boolean };

    if (envelope) {
      const fence = applyFence({
        state: hostState,
        fence: envelope.fence,
        expectedRunId: args.expectedRunId,
        logger: fenceLog,
      });

      if (fence.advanced) {
        await evictLowerEpochSessions({
          registry,
          runId: envelope.fence.runId,
          epoch: envelope.fence.assignmentEpoch,
          killGraceMs,
          logger: fenceLog,
        });
      }

      outcome = await receipts.execute({
        envelope,
        onAccepted:
          entry && kind === "session.prompt"
            ? () =>
                emitCommandEvent(entry, {
                  type: "session.command",
                  commandId: envelope.command.id,
                  kind,
                  phase: "accepted",
                })
            : undefined,
        run: args.execute,
      });
    } else {
      outcome = { ...(await args.execute()), replayed: false };
    }

    if (envelope && entry && sessionKind && !outcome.replayed) {
      const status = commandStatus(outcome);

      emitCommandEvent(entry, {
        type: "session.command",
        commandId: envelope.command.id,
        kind: kind as "session.prompt",
        phase: "completed",
        status,
        ...(status === "succeeded"
          ? { result: (outcome.body ?? {}) as Record<string, unknown> }
          : { error: outcome.body as SupervisorErrorBody }),
      });
    }

    if (outcome.replayed) reply.header(REPLAYED_HEADER, "true");

    if (outcome.status === 204) {
      reply.status(204).send();

      return;
    }

    reply.status(outcome.status).send(outcome.body);
  }

  app.setErrorHandler((err, _req, reply) => {
    if (isSupervisorError(err)) {
      const status = httpStatusForCode(err.code);

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

  // ADR-164 D7: the ONLY path-bearing route. Registers a host-local path for a
  // run as an opaque handle; every later route derives its paths from it.
  app.post("/workspaces/adopt", async (req, reply) => {
    const parsed = parseCommandBody(
      req.body,
      "workspace.adopt",
      AdoptWorkspacePayloadSchema,
      { route: "POST /workspaces/adopt", allowLegacy: false },
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
      { route: "DELETE /workspaces/:id", allowLegacy: false },
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
      { route: "POST /sessions", allowLegacy: true },
    );
    const request = parsed.payload;
    // ADR-164 D7: the handle form derives cwd, confinement roots, run dir, and
    // mounts from the adopted handle (server state); the legacy form reads
    // them off the request until the strict flip.
    const workspace: WorkspaceResolution = isHandleForm(request)
      ? workspaces.resolveForSession(request.executionWorkspaceId, {
          stepId: request.stepId,
          capabilityProfilePath: request.capabilityProfilePath,
        })
      : legacyResolution(
          request as Parameters<typeof legacyResolution>[0],
          runtimeRoot,
        );

    await runCommand({
      reply,
      parsed,
      kind: "session.create",
      expectedRunId: workspace.runId,
      execute: async () => {
        const sessionId = randomUUID();
        const { child, emitter, record, acpStdoutTap, eventsLog } =
          await spawnSession({
            sessionId,
            request,
            workspace,
            runtimeRoot,
            logger,
            binaryOverride: opts.spawnOverrides?.binary,
            preArgs: opts.spawnOverrides?.preArgs,
            ccrManager: opts.spawnOverrides?.ccrManager,
          });

        // M34 lifecycle: propagate the reap-on-end-turn flag onto the record so
        // the prompt handler can reap a one-shot agent session when its turn ends.
        record.reapOnEndTurn = request.reapOnEndTurn === true;
        if (parsed.envelope) {
          record.assignmentId = parsed.envelope.fence.assignmentId;
          record.assignmentEpoch = parsed.envelope.fence.assignmentEpoch;
          record.createdByCommandId = parsed.envelope.command.id;
        }
        registry.register(record, child, emitter, { eventsLog });
        attachHeartbeat({ sessionId, child, registry, logger });
        await attachCost({
          sessionId,
          sessionName: record.sessionName,
          runtimeRoot,
          costPath: workspace.costPath,
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
            const exited = await waitForExit(entry, killGraceMs);

            if (!exited) {
              logger.warn(
                { sessionId, killGraceMs },
                "acp-handshake-failed-sigterm-grace-expired-sigkill",
              );
              child.kill("SIGKILL");
            }
          }

          registry.remove(sessionId, "acp-handshake-failed");
          await eventsLog.close().catch((closeErr: unknown) => {
            logger.warn(
              {
                sessionId,
                err:
                  closeErr instanceof Error
                    ? closeErr.message
                    : String(closeErr),
              },
              "events-log close failed after acp handshake failure",
            );
          });
          throw err;
        }

        registry.attachAcp(sessionId, connection, acpSessionId);

        logger.info(
          {
            sessionId,
            runId: workspace.runId,
            executionWorkspaceId: workspace.executionWorkspaceId ?? null,
            assignmentId: record.assignmentId ?? null,
            assignmentEpoch: record.assignmentEpoch ?? null,
            commandId: record.createdByCommandId ?? null,
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

  app.post<SessionIdParams>("/sessions/:id/prompt", async (req, reply) => {
    const entry = registry.get(req.params.id);

    if (!entry) {
      reply
        .status(404)
        .send({ code: "PRECONDITION", message: "unknown session" });

      return;
    }
    if (entry.record.status !== "live") {
      reply
        .status(409)
        .send({ code: "PRECONDITION", message: "session not live" });

      return;
    }
    if (!entry.connection || !entry.acpSessionId) {
      reply.status(409).send({
        code: "PRECONDITION",
        message: "session has no ACP connection",
      });

      return;
    }

    const parsed = parseCommandBody(
      req.body,
      "session.prompt",
      SendPromptRequestSchema,
      { route: "POST /sessions/:id/prompt", allowLegacy: true },
    );
    const body = parsed.payload;
    const connection = entry.connection;
    const acpSessionId = entry.acpSessionId;

    await runCommand({
      reply,
      parsed,
      kind: "session.prompt",
      expectedRunId: entry.record.runId,
      entry,
      execute: async () => {
        // Defense-in-depth: independently confine every content-block file URI
        // to roots bound to THIS session at creation (worktree ∪ repo ∪ run dir)
        // before forwarding — the web tier confines too, but the supervisor must
        // not trust a direct caller. Remote schemes + sandbox escapes are
        // rejected, not forwarded.
        const uriViolation = contentBlockUriViolation(body.contentBlocks, {
          worktreePath: entry.record.worktreePath,
          repoPath: entry.record.repoPath,
          runDir: dirname(entry.record.logPath),
          confineRoot: entry.record.confineRoot,
        });

        if (uriViolation) {
          logger.warn(
            { sessionId: req.params.id, status: 409, message: uriViolation },
            "prompt route: content-block URI confinement violation",
          );
          throw new SupervisorError("PRECONDITION", uriViolation);
        }

        entry.record.stepId = body.stepId;
        if (body.nodeAttemptId) {
          entry.record.nodeAttemptId = body.nodeAttemptId;
        } else {
          delete entry.record.nodeAttemptId;
        }

        // M30 (ADR-078 DD4): a gate-chat prompt accumulates the agent's reply
        // text from this turn's session.update chunks and emits ONE
        // session.chat_turn at completion — the chat surface renders it without
        // polluting the flow timeline.
        const chatHitlId = parseGateChatHitlId(body.stepId);
        let chatBuf = "";
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
            chatBuf += update.content.text;
          }
        };

        if (chatHitlId) {
          entry.emitter.on(SESSION_EVENT_CHANNEL, chatListener);
        }
        // M30 (ADR-078 L2): arm the read-only auto-reject for the duration of
        // this prompt only.
        entry.record.readOnlyTurn = body.readOnlyTurn === true;

        // ADR-157: ground the agent in its read-only sibling-repo mounts on the
        // FIRST prompt of the session — MAISTER_CONTEXT_REPOS serves scripts,
        // this preamble is how the agent learns the mounts exist. A respawn
        // (resume) rebuilds the record, so a resumed session re-grounds once.
        const mountPreamble = takeContextMountPreamble(entry.record);

        if (mountPreamble) {
          logger.info(
            {
              sessionId: req.params.id,
              mounts: entry.record.contextMounts?.map((m) => m.slug),
            },
            "context-mount preamble prepended",
          );
        }

        let resp: Awaited<ReturnType<typeof sendPromptOnConnection>>;

        try {
          resp = await sendPromptOnConnection(
            connection,
            {
              adapter: entry.record.adapter,
              acpSessionId,
              stepId: body.stepId,
              prompt: body.prompt,
              // Validated by SendPromptRequestSchema; cast to the SDK block
              // type at this trust boundary for verbatim forward (T5.4).
              contentBlocks: body.contentBlocks as
                | acp.ContentBlock[]
                | undefined,
              preamble: mountPreamble ?? undefined,
              isUserCancel: () => entry.record.cancelRequested === true,
            },
            logger,
          );
        } catch (err) {
          // ADR-164 E-EH-04 / X-EH-19: a session evicted by a higher epoch
          // answers its pending prompt with FENCED, never a protocol error.
          throwIfFenced(entry, parsed.envelope);
          throw err;
        } finally {
          entry.record.readOnlyTurn = false;
          entry.record.cancelRequested = false;
          if (chatHitlId) {
            entry.emitter.off(SESSION_EVENT_CHANNEL, chatListener);
          }
        }

        throwIfFenced(entry, parsed.envelope);

        if (chatHitlId) {
          entry.record.monotonicId += 1;
          const chatEvent: SessionEvent = {
            type: "session.chat_turn",
            sessionId: req.params.id,
            monotonicId: entry.record.monotonicId,
            hitlRequestId: chatHitlId,
            role: "agent",
            body: chatBuf,
          };

          entry.emitter.emit(SESSION_EVENT_CHANNEL, chatEvent);
        }

        logger.info(
          {
            sessionId: req.params.id,
            stepId: body.stepId,
            stopReason: resp.stopReason,
            status: 200,
            readOnlyTurn: body.readOnlyTurn === true,
            commandId: parsed.envelope?.command.id ?? null,
          },
          "http POST /sessions/:id/prompt",
        );

        // M34 lifecycle: a one-shot standalone agent session (reapOnEndTurn)
        // has no external driver that acts on a clean `end_turn` (a flow
        // session is driven by the flow runner; a persistent agent parks +
        // re-messages). Reap the now-idle adapter so the heartbeat emits a bare
        // `session.exited{exitCode:0}` and the web consumer finalizes the run —
        // otherwise it lingers `Running` and leaks a concurrency slot.
        // `intentionalShutdown` with NO reason selects the natural-completion
        // path (a "checkpoint"/"intentional" reason would detach or
        // operator-cancel instead).
        if (entry.record.reapOnEndTurn && resp.stopReason === "end_turn") {
          entry.intentionalShutdown = true;
          entry.child.kill("SIGTERM");
        }

        return {
          status: 200,
          body: { stopReason: resp.stopReason, meta: resp._meta },
        };
      },
    });
  });

  // Interrupt the in-flight prompt turn WITHOUT tearing the session down: a
  // protocol-level `session/cancel` notification (adapter-agnostic — claude,
  // codex, gemini, opencode all honour it). The blocked /sessions/:id/prompt
  // request resolves with the `cancelled` stop reason; the cancelRequested flag
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
      { route: "POST /sessions/:id/cancel", allowLegacy: true },
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
      { route: "DELETE /sessions/:id", allowLegacy: true },
    );

    await runCommand({
      reply,
      parsed,
      kind: "session.delete",
      expectedRunId: entry.record.runId,
      entry,
      execute: async () => {
        registry.markIntentionalShutdown(req.params.id, "intentional");
        entry.child.kill("SIGTERM");
        const exited = await waitForExit(entry, killGraceMs);

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
    reply.send(registry.list());
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
  // SIGKILL escalation we return 500 EXECUTOR_UNAVAILABLE — the web
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
      CheckpointBodySchema,
      { route: "POST /sessions/:id/checkpoint", allowLegacy: true },
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
        entry.child.kill("SIGTERM");

        const exited = await waitForExit(entry, killGraceMs);

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
      {
        route: "POST /sessions/:id/input",
        allowLegacy: true,
      },
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

// ADR-164 X-EH-19: an evicted session's pending prompt answers 409 FENCED.
function throwIfFenced(
  entry: RegistryEntry,
  envelope: CommandEnvelope | null,
): void {
  const hostEpoch = entry.record.fencedByEpoch;

  if (hostEpoch === undefined) return;

  throw new SupervisorError(
    "FENCED",
    `session ${entry.record.sessionId} was evicted by assignment epoch ${hostEpoch}`,
    {
      details: {
        reason: "assignment_fenced",
        runId: entry.record.runId,
        commandEpoch:
          envelope?.fence.assignmentEpoch ?? entry.record.assignmentEpoch ?? 0,
        hostEpoch,
      },
    },
  );
}

async function waitForExit(
  entry: RegistryEntry,
  timeoutMs: number,
): Promise<boolean> {
  if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
    return true;
  }

  return new Promise<boolean>((resolveP) => {
    const timer = setTimeout(() => resolveP(false), timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveP(true);
    };

    entry.child.once("exit", onExit);
  });
}
