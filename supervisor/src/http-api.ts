import type { FastifyInstance } from "fastify";
import type * as acp from "@agentclientprotocol/sdk";
import type { Logger } from "pino";
import type { SessionRegistry, RegistryEntry } from "./registry";

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import { z, ZodError } from "zod";

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
import { type CcrManager } from "./ccr-manager";
import { attachCost } from "./cost";
import { attachHeartbeat } from "./heartbeat";
import {
  modelCatalogCache,
  type ModelCatalogCache,
} from "./model-catalog/cache";
import { ModelSourceRegistry } from "./model-catalog/registry";
import { resolveModelCatalog } from "./model-catalog/resolve";
import { ModelCatalogDraftSchema } from "./model-catalog/types";
import { pendingPermissions } from "./pending-permissions";
import { contentBlockUriViolation } from "./prompt-confinement";
import { SESSION_EVENT_CHANNEL } from "./registry";
import { spawnSession } from "./spawn";
import {
  httpStatusForCode,
  isSupervisorError,
  parseGateChatHitlId,
  SendPromptRequestSchema,
  StartSessionRequestSchema,
  SupervisorError,
  type SessionEvent,
  type SessionStatus,
  type SupervisorDiagnosticsResponse,
  type SupervisorHealthResponse,
} from "./types";

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

// ADR-093: admin CCR sidecar start body — the full CcrInstanceConfig forwarded
// by the admin-gated web tier. `id` must equal the path param (body-controlled,
// trusted only because the sole caller is the server-to-server web tier).
const SidecarStartBodySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/),
    lifecycle: z.enum(["managed", "external"]).optional(),
    configPath: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    healthcheckUrl: z.string().url().optional(),
  })
  .strict();

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
  "MAISTER_CCR_AUTH_TOKEN",
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
  ccrManager?: CcrManager;
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
};

type SessionIdParams = { Params: { id: string } };

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

  app.setErrorHandler((err, _req, reply) => {
    if (isSupervisorError(err)) {
      const status = httpStatusForCode(err.code);

      reply.status(status).send({ code: err.code, message: err.message });

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
      version: SUPERVISOR_VERSION,
      uptimeMs: Math.max(0, Date.now() - SUPERVISOR_STARTED_AT_MS),
      checkedAt: new Date().toISOString(),
      sessions: countSessionsByStatus(registry.list()),
    };

    reply.status(200).send(body);
  });

  app.get("/diagnostics", async (_req, reply) => {
    const ccr = opts.spawnOverrides?.ccrManager;
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
      sidecars: [
        {
          id: "ccr-default",
          kind: "ccr",
          state: ccr?.getState() ?? "idle",
        },
      ],
      envRefs: diagnosticEnvRefs(),
    };

    reply.status(200).send(body);
  });

  app.post("/sessions", async (req, reply) => {
    const parsed = StartSessionRequestSchema.parse(req.body);
    const sessionId = randomUUID();
    const { child, emitter, record, acpStdoutTap, eventsLog } =
      await spawnSession({
        sessionId,
        request: parsed,
        runtimeRoot,
        logger,
        binaryOverride: opts.spawnOverrides?.binary,
        preArgs: opts.spawnOverrides?.preArgs,
        ccrManager: opts.spawnOverrides?.ccrManager,
      });

    registry.register(record, child, emitter, { eventsLog });
    attachHeartbeat({ sessionId, child, registry, logger });
    await attachCost({
      sessionId,
      runtimeRoot,
      projectSlug: parsed.projectSlug,
      runId: parsed.runId,
      stepId: parsed.stepId,
      nodeAttemptId: parsed.nodeAttemptId,
      getContext: () => {
        const latest = registry.get(sessionId)?.record;

        return {
          stepId: latest?.stepId,
          nodeAttemptId: latest?.nodeAttemptId,
        };
      },
      emitter,
      logger,
      resumed: Boolean(parsed.resumeSessionId),
    });

    if (!child.stdin) {
      throw new SupervisorError("SPAWN", "child has no stdin for ACP");
    }

    const { connection, acpSessionId } = await createAcpConnection({
      stdin: child.stdin,
      stdoutSource: acpStdoutTap,
      sessionId,
      worktreePath: parsed.worktreePath,
      record,
      emitter,
      logger,
      adapter: parsed.runner?.adapter ?? parsed.executor.agent,
      mcpServers: parsed.mcpServers,
      resumeSessionId: parsed.resumeSessionId,
      runner: parsed.runner,
    });

    registry.attachAcp(sessionId, connection, acpSessionId);

    logger.info(
      {
        sessionId,
        runId: parsed.runId,
        pid: record.pid,
        acpSessionId,
        status: 201,
      },
      "http POST /sessions",
    );
    reply.status(201).send({ sessionId, pid: record.pid, acpSessionId });
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

    const body = SendPromptRequestSchema.parse(req.body);

    // Defense-in-depth: independently confine every content-block file URI to
    // roots bound to THIS session at creation (worktree ∪ repo ∪ run dir) before
    // forwarding — the web tier confines too, but the supervisor must not trust a
    // direct caller. Remote schemes + sandbox escapes are rejected, not forwarded.
    const uriViolation = contentBlockUriViolation(body.contentBlocks, {
      worktreePath: entry.record.worktreePath,
      repoPath: entry.record.repoPath,
      runDir: dirname(entry.record.logPath),
    });

    if (uriViolation) {
      logger.warn(
        { sessionId: req.params.id, status: 409, message: uriViolation },
        "prompt route: content-block URI confinement violation",
      );
      reply.status(409).send({ code: "PRECONDITION", message: uriViolation });

      return;
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

    let resp: Awaited<ReturnType<typeof sendPromptOnConnection>>;

    try {
      resp = await sendPromptOnConnection(
        entry.connection,
        {
          adapter: entry.record.adapter,
          acpSessionId: entry.acpSessionId,
          stepId: body.stepId,
          prompt: body.prompt,
          // Validated by SendPromptRequestSchema; cast to the SDK block type at
          // this trust boundary for verbatim forward (T5.4).
          contentBlocks: body.contentBlocks as acp.ContentBlock[] | undefined,
        },
        logger,
      );
    } finally {
      entry.record.readOnlyTurn = false;
      if (chatHitlId) {
        entry.emitter.off(SESSION_EVENT_CHANNEL, chatListener);
      }
    }

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
      },
      "http POST /sessions/:id/prompt",
    );
    reply.status(200).send({ stopReason: resp.stopReason, meta: resp._meta });
  });

  app.delete<SessionIdParams>("/sessions/:id", async (req, reply) => {
    const entry = registry.get(req.params.id);

    if (!entry) {
      reply
        .status(404)
        .send({ code: "PRECONDITION", message: "unknown session" });

      return;
    }

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
    reply.status(204).send();
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
    const parsed = CheckpointBodySchema.safeParse(req.body ?? {});

    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");

      reply.status(409).send({ code: "PRECONDITION", message });

      return;
    }

    const entry = registry.get(sessionId);

    if (!entry) {
      reply
        .status(404)
        .send({ code: "PRECONDITION", message: "unknown session" });

      return;
    }

    const checkpointLog = logger.child({ name: "supervisor-checkpoint" });

    // Idempotency: if the child is already gone, return 200 with the
    // current state. The sweeper may hit this branch when the
    // supervisor restarted between two ticks.
    if (entry.record.status === "exited" || entry.record.status === "crashed") {
      checkpointLog.info(
        {
          sessionId,
          status: entry.record.status,
          alreadyCheckpointed: true,
        },
        "checkpoint endpoint idempotent ack",
      );
      reply.status(200).send({
        alreadyCheckpointed: true,
        sessionId,
        monotonicId: entry.record.monotonicId,
      });

      return;
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

    reply.status(200).send({
      alreadyCheckpointed: false,
      sessionId,
      monotonicId: entry.record.monotonicId,
    });
  });

  app.post<SessionIdParams>("/sessions/:id/input", (req, reply) => {
    const sessionId = req.params.id;
    const startedAt = Date.now();
    const parsed = InputBodySchema.safeParse(req.body);

    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");

      logger.warn(
        { sessionId, status: 409, message },
        "input route: validation failed",
      );
      reply.status(409).send({ code: "PRECONDITION", message });

      return;
    }

    const body = parsed.data;

    if (!registry.has(sessionId)) {
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

    let ok: boolean;
    let outcome: "ok" | "missing";

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

    outcome = ok ? "ok" : "missing";
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
      reply.status(410).send({
        code: "HITL_TIMEOUT",
        message: "no pending permission with that requestId",
      });

      return;
    }

    reply.status(200).send({ ok: true });
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

  // ADR-093: admin-triggered CCR sidecar start/stop. Reuses the existing keyed
  // CcrManager. Stop targets a SINGLE instance via the per-instance stop(id),
  // never the manager-wide shutdown() (which would kill every instance and any
  // live session routing through CCR). The route is a proxy over
  // supervisor-owned process state — no DB idempotency marker is written.
  app.post<SessionIdParams>("/sidecars/:id/start", async (req, reply) => {
    const ccr = opts.spawnOverrides?.ccrManager;

    if (!ccr) {
      reply.status(409).send({
        code: "PRECONDITION",
        message: "CCR manager is not configured",
      });

      return;
    }

    const body = SidecarStartBodySchema.parse(req.body);

    if (body.id !== req.params.id) {
      reply.status(409).send({
        code: "PRECONDITION",
        message: "sidecar body id does not match path id",
      });

      return;
    }

    logger.debug(
      { sidecarId: body.id, lifecycle: body.lifecycle ?? "managed" },
      "http POST /sidecars/:id/start",
    );

    try {
      await ccr.ensureRunning({ instance: body });
    } catch (err) {
      logger.error(
        {
          sidecarId: body.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "ccr sidecar start failed",
      );
      throw err;
    }

    const state = ccr.getState(body.id);

    logger.info(
      { sidecarId: body.id, state, status: 200 },
      "ccr sidecar started",
    );
    reply.status(200).send({ ok: true, state });
  });

  app.post<SessionIdParams>("/sidecars/:id/stop", async (req, reply) => {
    const ccr = opts.spawnOverrides?.ccrManager;

    if (!ccr) {
      reply.status(409).send({
        code: "PRECONDITION",
        message: "CCR manager is not configured",
      });

      return;
    }

    logger.debug({ sidecarId: req.params.id }, "http POST /sidecars/:id/stop");
    await ccr.stop(req.params.id);
    const state = ccr.getState(req.params.id);

    logger.info(
      { sidecarId: req.params.id, state, status: 200 },
      "ccr sidecar stopped",
    );
    reply.status(200).send({ ok: true, state });
  });
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
