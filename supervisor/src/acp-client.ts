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

import { modelCatalogCache } from "./model-catalog/cache";
import { harvestSessionModels } from "./model-catalog/harvest";
import {
  pendingPermissions as defaultPendingPermissions,
  type AcpPermissionOutcome,
  type PendingPermissionRegistry,
} from "./pending-permissions";
import { SESSION_EVENT_CHANNEL } from "./registry";
import {
  SupervisorError,
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

  const initResp = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: {} },
  });

  logger.info(
    { sessionId, protocolVersion: initResp.protocolVersion },
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
      env: (s.envKeys ?? []).map((k) => ({
        name: k,
        value: process.env[k] ?? "",
      })),
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
    const agentCaps = (initResp.agentCapabilities ?? {}) as {
      sessionCapabilities?: { resume?: unknown };
    };

    if (agentCaps.sessionCapabilities?.resume) {
      const resumeResp = await connection.resumeSession({
        sessionId: args.resumeSessionId,
        cwd: worktreePath,
        mcpServers: acpMcpServers as acp.McpServer[],
      });

      logger.info(
        { sessionId, acpSessionId: args.resumeSessionId },
        "acp resume-session",
      );
      record.acpSessionId = args.resumeSessionId;
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
        acpSessionId: args.resumeSessionId,
        sessionId,
        record,
        emitter,
        logger,
      });

      return { connection, acpSessionId: args.resumeSessionId };
    }
    // Unreachable for the bundled claude/codex adapters (both advertise
    // sessionCapabilities.resume). FAIL LOUD rather than silently falling
    // through to newSession — an empty session would orphan the conversation
    // (the original resume bug). Surfaces as the documented terminal CHECKPOINT.
    throw new SupervisorError(
      "CHECKPOINT",
      `resume requested but adapter does not advertise sessionCapabilities.resume (acpSessionId=${args.resumeSessionId})`,
    );
  }

  const newSessionResp = await connection.newSession({
    cwd: worktreePath,
    mcpServers: acpMcpServers as acp.McpServer[],
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
  const channel: "settings_local" | "set_session_model" =
    runner.adapter === "codex" ? "set_session_model" : "settings_local";

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
  args: { acpSessionId: string; stepId: string; prompt: string },
  logger: Logger,
): Promise<acp.PromptResponse> {
  logger.info(
    {
      acpSessionId: args.acpSessionId,
      stepId: args.stepId,
      len: args.prompt.length,
    },
    "acp prompt-sent",
  );

  const resp = await conn.prompt({
    sessionId: args.acpSessionId,
    prompt: [{ type: "text", text: args.prompt }],
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
