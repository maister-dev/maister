import type { EventEmitter } from "node:events";
import type {
  Readable as NodeReadable,
  Writable as NodeWritable,
} from "node:stream";
import type {
  ReadableStream as NodeReadableStream,
  WritableStream as NodeWritableStream,
} from "node:stream/web";
import type { Logger } from "pino";

import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import {
  clientCapabilitiesForAdapter,
  getAdapterRuntime,
  resolveResumeAction,
} from "./adapter-registry";
import { modelCatalogCache } from "./model-catalog/cache";
import { harvestSessionModels } from "./model-catalog/harvest";
import {
  pendingPermissions as defaultPendingPermissions,
  type AcpPermissionOutcome,
  type PendingPermissionRegistry,
} from "./pending-permissions";
import { SESSION_EVENT_CHANNEL } from "./registry";
import {
  isSupervisorError,
  SupervisorError,
  type ExecutorAgent,
  type McpServerInput,
  type PermissionOptionDescriptor,
  type RunnerLaunch,
  type SessionEvent,
  type SessionRecord,
} from "./types";

export type CreateAcpConnectionArgs = {
  stdin: NodeWritable;
  stdoutSource: NodeReadable;
  sessionId: string;
  worktreePath: string;
  record: SessionRecord;
  emitter: EventEmitter;
  logger: Logger;
  adapter: ExecutorAgent;
  pendingPermissions?: PendingPermissionRegistry;
  mcpServers?: McpServerInput[];
  // When set, resume the prior ACP session via the `session/resume` call
  // (restores context, no history replay) instead of creating a `session/new`.
  resumeSessionId?: string;
  // The launched runner. Threaded for the ADR-076 passive harvest (the model
  // state on the session/new + session/resume response is fed into the shared
  // model-catalog cache) and reused by the model-application path (Phase 3).
  runner?: RunnerLaunch;
};

export type CreateAcpConnectionResult = {
  connection: acp.ClientSideConnection;
  acpSessionId: string;
};

type ToolCallLike = {
  toolCallId?: string;
  title?: string;
  kind?: string;
};

// M30 (ADR-078 L2): unambiguous MUTATING ACP toolCall kinds. `execute`
// (bash) deliberately passes — read-only commands like grep/cat must work;
// the web-side L3 mutation sensor is the guarantee for anything that slips.
const READ_ONLY_MUTATING_KINDS = new Set([
  "edit",
  "write",
  "create",
  "delete",
  "move",
]);

// M30 (ADR-078 L2): decide whether a permission request raised during a
// read-only gate-chat turn is auto-rejected. Returns the reject option to
// deliver, or null to pass the request through to the normal HITL flow.
// Best-effort by design: no reject option / unknown kind / non-read-only
// turn → null (L3 guards). Exported for the supervisor test suite.
export function resolveReadOnlyAutoReject(
  readOnlyTurn: boolean | undefined,
  toolCall: ToolCallLike,
  options: ReadonlyArray<PermissionOptionDescriptor>,
): PermissionOptionDescriptor | null {
  if (readOnlyTurn !== true) return null;
  if (!toolCall.kind || !READ_ONLY_MUTATING_KINDS.has(toolCall.kind)) {
    return null;
  }

  return (
    options.find((o) => o.kind === "reject_once") ??
    options.find((o) => (o.kind ?? "").startsWith("reject")) ??
    null
  );
}

// M34 (ADR-090 L1): read-safe ACP toolCall kinds auto-approved on a
// read-only SESSION. Everything outside this allow-list — including
// `execute` (bash can mutate) and unknown kinds — is denied: the session is
// headless, so every request MUST be decided inline (there is no HITL inbox
// to fall through to).
const READ_ONLY_SESSION_ALLOWED_KINDS = new Set([
  "read",
  "search",
  "fetch",
  "think",
]);

export type ReadOnlySessionDecision =
  | { decision: "allow"; option: PermissionOptionDescriptor }
  | { decision: "deny"; option: PermissionOptionDescriptor | null }
  | null;

// Total arbitration for read-only sessions: allow read-safe kinds, deny the
// rest. A null return means the session is not read-only (normal HITL flow).
// A deny with a null option is answered with the `cancelled` outcome.
// Exported for the supervisor test suite.
export function resolveReadOnlySessionDecision(
  readOnlySession: boolean | undefined,
  toolCall: ToolCallLike,
  options: ReadonlyArray<PermissionOptionDescriptor>,
): ReadOnlySessionDecision {
  if (readOnlySession !== true) return null;

  const allow =
    toolCall.kind !== undefined &&
    READ_ONLY_SESSION_ALLOWED_KINDS.has(toolCall.kind);

  if (allow) {
    const option =
      options.find((o) => o.kind === "allow_once") ??
      options.find((o) => (o.kind ?? "").startsWith("allow")) ??
      null;

    // No allow-shaped option → fail closed.
    if (option) return { decision: "allow", option };
  }

  return {
    decision: "deny",
    option:
      options.find((o) => o.kind === "reject_once") ??
      options.find((o) => (o.kind ?? "").startsWith("reject")) ??
      null,
  };
}

// B1 (execution-policy permissions=auto_approve): pick the allow/proceed option
// for inline auto-approval (L3, below the read-only layers). Mirrors the L1
// allow-kind match; never selects a reject* option. Null when no allow-shaped
// option exists — the caller then falls through to HITL rather than
// blind-approve or cancel. Exported for the supervisor test suite.
export function resolveAutoApproveOption(
  options: ReadonlyArray<PermissionOptionDescriptor>,
): PermissionOptionDescriptor | null {
  return (
    options.find((o) => o.kind === "allow_once") ??
    options.find((o) => (o.kind ?? "").startsWith("allow")) ??
    null
  );
}

type AcpMethod = "initialize" | "newSession" | "resumeSession" | "prompt";

const ACP_HANDSHAKE_TIMEOUT_ENV = "MAISTER_ACP_HANDSHAKE_TIMEOUT_MS";
export const DEFAULT_ACP_HANDSHAKE_TIMEOUT_MS = 30_000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function resolveAcpHandshakeTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[ACP_HANDSHAKE_TIMEOUT_ENV];

  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_ACP_HANDSHAKE_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
    throw new SupervisorError(
      "PRECONDITION",
      `${ACP_HANDSHAKE_TIMEOUT_ENV} must be a positive integer number of milliseconds`,
    );
  }

  return parsed;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${message} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref();
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function classifyAcpMethodError(args: {
  adapter: ExecutorAgent;
  method: AcpMethod;
  err: unknown;
  sessionId?: string;
}): SupervisorError {
  if (isSupervisorError(args.err)) return args.err;

  const rawMessage = errorText(args.err);
  const lower = rawMessage.toLowerCase();
  const context = `adapter=${args.adapter}, method=${args.method}${
    args.sessionId ? `, sessionId=${args.sessionId}` : ""
  }`;

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      `ACP ${args.method} timed out while opening adapter session (${context}): ${rawMessage}`,
    );
  }

  if (
    lower.includes("auth") ||
    lower.includes("credential") ||
    lower.includes("login") ||
    lower.includes("api key") ||
    lower.includes("permission denied")
  ) {
    return new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      `ACP ${args.method} failed because adapter authentication is unavailable (${context}): ${rawMessage}`,
    );
  }

  if (
    args.method === "resumeSession" &&
    (lower.includes("unsupported") ||
      lower.includes("not implemented") ||
      lower.includes("method not found") ||
      lower.includes("not found"))
  ) {
    return new SupervisorError(
      "CHECKPOINT",
      `ACP resume is unsupported (${context}): ${rawMessage}`,
    );
  }

  return new SupervisorError(
    "ACP_PROTOCOL",
    `ACP ${args.method} failed (${context}): ${rawMessage}`,
  );
}

async function callAcpMethod<T>(args: {
  adapter: ExecutorAgent;
  method: AcpMethod;
  sessionId?: string;
  logger: Logger;
  timeoutMs?: number;
  run: () => Promise<T>;
}): Promise<T> {
  try {
    const promise = args.run();

    return await (args.timeoutMs
      ? withTimeout(
          promise,
          args.timeoutMs,
          `ACP ${args.method} (${args.adapter})`,
        )
      : promise);
  } catch (err) {
    const classified = classifyAcpMethodError({
      adapter: args.adapter,
      method: args.method,
      err,
      sessionId: args.sessionId,
    });

    args.logger.warn(
      {
        adapter: args.adapter,
        method: args.method,
        sessionId: args.sessionId,
        code: classified.code,
        err: classified.message,
      },
      "acp method failed",
    );

    throw classified;
  }
}

export async function createAcpConnection(
  args: CreateAcpConnectionArgs,
): Promise<CreateAcpConnectionResult> {
  const {
    stdin,
    stdoutSource,
    sessionId,
    worktreePath,
    record,
    emitter,
    logger,
  } = args;
  const pendingPermissions =
    args.pendingPermissions ?? defaultPendingPermissions;
  const handshakeTimeoutMs = resolveAcpHandshakeTimeoutMs();

  const writable = Writable.toWeb(
    stdin,
  ) as unknown as NodeWritableStream<Uint8Array>;
  const readable = Readable.toWeb(
    stdoutSource,
  ) as unknown as NodeReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(
    writable as unknown as Parameters<typeof acp.ndJsonStream>[0],
    readable as unknown as Parameters<typeof acp.ndJsonStream>[1],
  );

  const clientImpl: acp.Client = {
    async sessionUpdate(params) {
      record.monotonicId += 1;
      const event: SessionEvent = {
        type: "session.update",
        sessionId,
        monotonicId: record.monotonicId,
        update: params.update,
      };

      emitter.emit(SESSION_EVENT_CHANNEL, event);
      logger.debug(
        {
          sessionId,
          monotonicId: record.monotonicId,
          updateType:
            (params.update as { sessionUpdate?: string } | null)
              ?.sessionUpdate ?? null,
        },
        "session-update",
      );
    },

    async requestPermission(params) {
      const tc = (params.toolCall ?? {}) as ToolCallLike;
      const requestId = randomUUID();
      const options: ReadonlyArray<PermissionOptionDescriptor> =
        params.options.map((o) => ({
          optionId: o.optionId,
          kind: o.kind,
          name: o.name,
        }));

      // M34 (ADR-090 L1): a read-only SESSION arbitrates every request
      // inline — read-safe kinds approved, everything else denied (the
      // session is headless; no HITL inbox exists for it). Decided BEFORE
      // the SSE emit and the pending-permission registration.
      const sessionDecision = resolveReadOnlySessionDecision(
        record.readOnlySession,
        tc,
        options,
      );

      if (sessionDecision) {
        logger.info(
          {
            sessionId,
            toolKind: tc.kind,
            decision: sessionDecision.decision,
            optionId: sessionDecision.option?.optionId ?? null,
          },
          "[read-only-session] permission arbitrated inline (L1)",
        );

        if (sessionDecision.option) {
          return {
            outcome: {
              outcome: "selected",
              optionId: sessionDecision.option.optionId,
            },
          };
        }

        return { outcome: { outcome: "cancelled" } };
      }

      // M30 (ADR-078 L2): a mutating tool on a read-only gate-chat turn is
      // auto-rejected BEFORE the SSE emit and the pending-permission
      // registration — no session.permission_request event fires and no web
      // hitl row is created. No-op under permissive runner policies
      // (--dangerously-skip-permissions never calls this) — hence L3.
      const autoReject = resolveReadOnlyAutoReject(
        record.readOnlyTurn,
        tc,
        options,
      );

      if (autoReject) {
        logger.info(
          {
            sessionId,
            toolKind: tc.kind,
            optionId: autoReject.optionId,
          },
          "[neutrality] read-only turn — mutating tool auto-rejected (L2)",
        );

        return {
          outcome: { outcome: "selected", optionId: autoReject.optionId },
        };
      }

      // B1 (execution-policy permissions=auto_approve, L3): a session launched
      // with autoApprovePermissions auto-selects the allow option inline —
      // BELOW the read-only layers (L1 session / L2 gate-chat turn always win
      // above). No allow-shaped option → fall through to the HITL deferred
      // (never blind-approve or cancel).
      if (record.autoApprovePermissions === true) {
        const autoApprove = resolveAutoApproveOption(options);

        if (autoApprove) {
          logger.info(
            { sessionId, toolKind: tc.kind, optionId: autoApprove.optionId },
            "[perm.auto] permission auto-approved (L3)",
          );

          return {
            outcome: { outcome: "selected", optionId: autoApprove.optionId },
          };
        }
      }

      record.monotonicId += 1;
      const event: SessionEvent = {
        type: "session.permission_request",
        sessionId,
        monotonicId: record.monotonicId,
        requestId,
        options,
        toolCall: params.toolCall,
      };

      emitter.emit(SESSION_EVENT_CHANNEL, event);
      logger.info(
        {
          sessionId,
          requestId,
          optionsCount: options.length,
          toolCallSummary: {
            id: tc.toolCallId,
            kind: tc.kind,
            title: tc.title,
          },
        },
        "permission-request emitted",
      );

      const outcome = await new Promise<AcpPermissionOutcome>(
        (resolve, reject) => {
          pendingPermissions.register(sessionId, requestId, {
            resolve,
            reject,
          });
        },
      );

      return { outcome };
    },
  };

  const connection = new acp.ClientSideConnection(() => clientImpl, stream);

  logger.info({ sessionId }, "acp connection-init");

  const initResp = await callAcpMethod({
    adapter: args.adapter,
    method: "initialize",
    sessionId,
    logger,
    timeoutMs: handshakeTimeoutMs,
    run: () =>
      connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: clientCapabilitiesForAdapter(args.adapter),
      }),
  });

  logger.info(
    {
      sessionId,
      adapter: args.adapter,
      protocolVersion: initResp.protocolVersion,
    },
    "acp initialized",
  );

  // M27/T-C4: build the transport-appropriate ACP McpServer. Secret VALUES are
  // resolved here, supervisor-side, from process.env by NAME — never received
  // from the web tier (envKeys/headerKeys carry NAMES only).
  const acpMcpServers: acp.McpServer[] = (args.mcpServers ?? []).map((s) => {
    if (s.transport === "sse" || s.transport === "http") {
      return {
        type: s.transport,
        name: s.name,
        url: s.url ?? "",
        headers: (s.headerKeys ?? []).map((k) => ({
          name: k,
          value: process.env[k] ?? "",
        })),
      };
    }

    return {
      name: s.name,
      command: s.command ?? "",
      args: s.args ?? [],
      // Literal `env` entries (server-generated secrets, M34) win over
      // same-named process.env lookups.
      env: [
        ...(s.envKeys ?? [])
          .filter((k) => !(k in (s.env ?? {})))
          .map((k) => ({ name: k, value: process.env[k] ?? "" })),
        ...Object.entries(s.env ?? {}).map(([name, value]) => ({
          name,
          value,
        })),
      ],
    };
  });

  // Resume uses the ACP `session/resume` call: it restores the prior
  // conversation into the agent's context WITHOUT replaying history (ACP spec:
  // "the Agent MUST NOT replay the conversation history") — which is exactly
  // what we want, the transcript is already persisted. The session id is
  // REUSED, never minted anew, so runs.acp_session_id keeps pointing at the
  // real conversation. (Resume is a protocol call, NOT a CLI flag: both
  // adapters ignore `--resume` on argv.)
  if (args.resumeSessionId) {
    const resumeSessionId = args.resumeSessionId;
    const agentCaps = (initResp.agentCapabilities ?? {}) as {
      sessionCapabilities?: { load?: unknown; resume?: unknown };
    };
    const resumeAction = resolveResumeAction(args.adapter, agentCaps);

    if (resumeAction.kind === "resume_session") {
      const resumeResp = await callAcpMethod({
        adapter: args.adapter,
        method: "resumeSession",
        sessionId,
        logger,
        timeoutMs: handshakeTimeoutMs,
        run: () =>
          connection.resumeSession({
            sessionId: resumeSessionId,
            cwd: worktreePath,
            mcpServers: acpMcpServers as acp.McpServer[],
          }),
      });

      logger.info(
        { sessionId, acpSessionId: resumeSessionId },
        "acp resume-session",
      );
      record.acpSessionId = resumeSessionId;
      harvestSessionModels(
        args.runner,
        resumeResp.models,
        modelCatalogCache,
        logger,
      );
      await applyAndVerifyModel({
        connection,
        runner: args.runner,
        models: resumeResp.models,
        acpSessionId: resumeSessionId,
        sessionId,
        record,
        emitter,
        logger,
      });

      return { connection, acpSessionId: resumeSessionId };
    }
    // Unreachable for the bundled claude/codex adapters (both advertise
    // sessionCapabilities.resume). FAIL LOUD rather than silently falling
    // through to newSession — an empty session would orphan the conversation
    // (the original resume bug). Surfaces as the documented terminal CHECKPOINT.
    throw new SupervisorError(
      "CHECKPOINT",
      `${resumeAction.reason} (acpSessionId=${resumeSessionId})`,
    );
  }

  const newSessionResp = await callAcpMethod({
    adapter: args.adapter,
    method: "newSession",
    sessionId,
    logger,
    timeoutMs: handshakeTimeoutMs,
    run: () =>
      connection.newSession({
        cwd: worktreePath,
        mcpServers: acpMcpServers as acp.McpServer[],
      }),
  });

  logger.info(
    { sessionId, acpSessionId: newSessionResp.sessionId },
    "acp new-session",
  );

  record.acpSessionId = newSessionResp.sessionId;
  harvestSessionModels(
    args.runner,
    newSessionResp.models,
    modelCatalogCache,
    logger,
  );
  await applyAndVerifyModel({
    connection,
    runner: args.runner,
    models: newSessionResp.models,
    acpSessionId: newSessionResp.sessionId,
    sessionId,
    record,
    emitter,
    logger,
  });

  return { connection, acpSessionId: newSessionResp.sessionId };
}

type ApplyModelArgs = {
  connection: acp.ClientSideConnection;
  runner: RunnerLaunch | undefined;
  models: acp.SessionModelState | null | undefined;
  acpSessionId: string;
  sessionId: string;
  record: SessionRecord;
  emitter: EventEmitter;
  logger: Logger;
};

// ADR-076 model application + verification (T3.2/T3.3). claude is pinned ahead
// of session/new via the settings.local.json channel (web tier), so here we
// only verify it. codex is pinned via the ACP `unstable_setSessionModel` call.
// A residual mismatch is emitted as an ADVISORY `session.update` (a synthetic
// payload variant, NOT a new event kind) and NEVER fails the run — env-router
// slot-mapping legitimately reports a remapped name, and `cost.jsonl` stays the
// billed-model ground truth. Runs on both new and resumed sessions.
export async function applyAndVerifyModel(args: ApplyModelArgs): Promise<void> {
  const {
    connection,
    runner,
    models,
    acpSessionId,
    sessionId,
    record,
    emitter,
    logger,
  } = args;
  const observed = models?.currentModelId;

  // `!runner` narrows `runner` to non-undefined for the accesses below;
  // `!runner.model` is defensive (the schema enforces min(1)).
  if (!runner || !runner.model) return;

  const configured = runner.model;
  const channel = getAdapterRuntime(runner.adapter).modelChannel;

  // Already on the configured model → nothing to apply or verify (only decidable
  // when the adapter actually reported a current model).
  if (observed === configured) return;

  // claude pins via settings.local.json before session/new, so this path only
  // VERIFIES. With no observed model there is nothing to verify — return rather
  // than emit an advisory we cannot substantiate. codex pins HERE via
  // setSessionModel, so it must NOT bail on absent observed: a version-skewed
  // adapter that omits currentModelId still needs the configured model applied
  // (ADR-076 apply-gap).
  if (channel === "settings_local" && !observed) return;

  if (channel === "set_session_model") {
    try {
      await connection.unstable_setSessionModel({
        sessionId: acpSessionId,
        modelId: configured,
      });
      logger.info(
        { sessionId, configuredModel: configured, observedModelId: observed },
        "model applied via setSessionModel",
      );

      return;
    } catch (err) {
      logger.warn(
        {
          sessionId,
          configuredModel: configured,
          err: err instanceof Error ? err.message : String(err),
        },
        "setSessionModel failed; emitting advisory",
      );
    }
  }

  record.monotonicId += 1;
  emitter.emit(SESSION_EVENT_CHANNEL, {
    type: "session.update",
    sessionId,
    monotonicId: record.monotonicId,
    update: {
      sessionUpdate: "model_advisory",
      configuredModel: configured,
      // "" when the adapter reported no current model (codex apply failed with
      // no observable state); the asyncapi contract requires the field present.
      observedModelId: observed ?? "",
      channel,
    },
  } satisfies SessionEvent);
  logger.info(
    {
      sessionId,
      configuredModel: configured,
      observedModelId: observed,
      channel,
    },
    "model mismatch advisory",
  );
}

export async function sendPromptOnConnection(
  conn: acp.ClientSideConnection,
  args: {
    adapter: ExecutorAgent;
    acpSessionId: string;
    stepId: string;
    prompt: string;
    contentBlocks?: acp.ContentBlock[];
  },
  logger: Logger,
): Promise<acp.PromptResponse> {
  // T5.4: forward the web tier's assembled content blocks verbatim; otherwise
  // wrap the plain string into a single text block (verbatim-forward).
  const prompt: acp.ContentBlock[] =
    args.contentBlocks && args.contentBlocks.length > 0
      ? args.contentBlocks
      : [{ type: "text", text: args.prompt }];

  logger.info(
    {
      acpSessionId: args.acpSessionId,
      stepId: args.stepId,
      len: args.prompt.length,
      blocks: prompt.length,
    },
    "acp prompt-sent",
  );

  const resp = await callAcpMethod({
    adapter: args.adapter,
    method: "prompt",
    sessionId: args.acpSessionId,
    logger,
    run: () =>
      conn.prompt({
        sessionId: args.acpSessionId,
        prompt,
      }),
  });

  logger.info(
    {
      acpSessionId: args.acpSessionId,
      stepId: args.stepId,
      stopReason: resp.stopReason,
    },
    "acp prompt-end",
  );

  if (resp.stopReason === "cancelled") {
    throw new SupervisorError(
      "ACP_PROTOCOL",
      `prompt cancelled (sessionId=${args.acpSessionId}, stepId=${args.stepId})`,
    );
  }

  return resp;
}
