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

import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import { SESSION_EVENT_CHANNEL } from "./registry";
import {
  SupervisorError,
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

function pickAutoAllowOption(
  options: ReadonlyArray<{ optionId: string; kind?: string; name?: string }>,
): { optionId: string; reason: "allow_always" | "allow_once" | "fallback" } {
  const always = options.find((o) => o.kind === "allow_always");

  if (always) return { optionId: always.optionId, reason: "allow_always" };

  const once = options.find((o) => o.kind === "allow_once");

  if (once) return { optionId: once.optionId, reason: "allow_once" };

  return { optionId: options[0]?.optionId ?? "", reason: "fallback" };
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
      // TODO(m7): replace auto-allow with structured HITL (insert hitl_requests row,
      //           emit session.permission_request, block until response artifact arrives).
      const tc = (params.toolCall ?? {}) as ToolCallLike;
      const { optionId, reason } = pickAutoAllowOption(params.options);

      record.monotonicId += 1;
      const event: SessionEvent = {
        type: "session.permission_auto",
        sessionId,
        monotonicId: record.monotonicId,
        toolCall: params.toolCall,
        optionId,
      };

      emitter.emit(SESSION_EVENT_CHANNEL, event);
      logger.warn(
        {
          sessionId,
          toolCallId: tc.toolCallId,
          toolCallTitle: tc.title,
          toolCallKind: tc.kind,
          optionId,
          reason,
        },
        "auto-allow-permission",
      );

      return {
        outcome: { outcome: "selected", optionId },
      };
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

  const newSessionResp = await connection.newSession({
    cwd: worktreePath,
    mcpServers: [],
  });

  logger.info(
    { sessionId, acpSessionId: newSessionResp.sessionId },
    "acp new-session",
  );

  record.acpSessionId = newSessionResp.sessionId;

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
