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
  // The launched runner. Threaded for the ADR-073 passive harvest (the model
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

  return { connection, acpSessionId: newSessionResp.sessionId };
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
