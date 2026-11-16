import type {
  RequestPermissionRequest,
  SessionNotification,
} from "@agentclientprotocol/sdk/unstable";

import { SupervisorError } from "./types";

type ToolCall = RequestPermissionRequest["toolCall"];
type ToolIdentitySnapshot = Readonly<{
  name?: string;
  kind?: ToolCall["kind"];
  bytes: number;
}>;

function explicitToolName(call: ToolCall): string | undefined {
  const metadata = call._meta?.claudeCode;

  return metadata &&
    typeof metadata === "object" &&
    "toolName" in metadata &&
    typeof metadata.toolName === "string"
    ? metadata.toolName
    : undefined;
}

function canInheritToolName(call: ToolCall): boolean {
  const metadata = call._meta?.claudeCode;

  return (
    metadata === undefined ||
    (metadata !== null &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      !("toolName" in metadata))
  );
}

/** Recover only adapter-supplied identity/kind from live tool-call deltas, never display titles or payloads. */
export function createAcpToolCallContext(): Readonly<{
  observe: (notification: SessionNotification) => void;
  permission: (request: RequestPermissionRequest) => RequestPermissionRequest;
}> {
  // Fits the bounded producer's small metadata reservation. No raw input,
  // content, diff, or arbitrary metadata object is retained here.
  const snapshots = new Map<string, ToolIdentitySnapshot>();
  const byteLimit = 4096;
  const entryLimit = 32;
  let retainedBytes = 0;

  function remove(key: string): void {
    retainedBytes -= snapshots.get(key)?.bytes ?? 0;
    snapshots.delete(key);
  }

  return {
    observe(notification) {
      const call = notification.update;

      if (
        call.sessionUpdate !== "tool_call" &&
        call.sessionUpdate !== "tool_call_update"
      )
        return;
      const key = JSON.stringify([notification.sessionId, call.toolCallId]);
      const previous =
        call.sessionUpdate === "tool_call_update"
          ? snapshots.get(key)
          : undefined;

      remove(key);
      if (call.status === "completed" || call.status === "failed") return;
      const name = canInheritToolName(call)
        ? previous?.name
        : explicitToolName(call);
      const kind = call.kind ?? previous?.kind;
      const bytes = Buffer.byteLength(
        JSON.stringify([key, name, kind]),
        "utf8",
      );

      if (bytes > byteLimit)
        throw new SupervisorError(
          "ACP_PROTOCOL",
          "ACP tool identity exceeds the bounded session context",
          {
            details: {
              reason: "required_output_incomplete",
              outputFailure: "producer_retained_limit",
            },
          },
        );
      while (
        snapshots.size >= entryLimit ||
        retainedBytes + bytes > byteLimit
      ) {
        const oldest = snapshots.keys().next().value;

        if (oldest === undefined) break;
        remove(oldest);
      }
      snapshots.set(key, { name, kind, bytes });
      retainedBytes += bytes;
    },
    permission(request) {
      const previous = snapshots.get(
        JSON.stringify([request.sessionId, request.toolCall.toolCallId]),
      );

      if (!previous) return request;
      const requestedName = explicitToolName(request.toolCall);

      if (
        (previous.kind &&
          request.toolCall.kind &&
          previous.kind !== request.toolCall.kind) ||
        (previous.name && requestedName && previous.name !== requestedName)
      )
        throw new SupervisorError(
          "ACP_PROTOCOL",
          "ACP permission identity contradicts its announced tool call",
          {
            details: {
              reason: "required_output_incomplete",
              outputFailure: "producer_permission_invalid",
            },
          },
        );
      const metadata = request.toolCall._meta?.claudeCode;
      const inheritedName = canInheritToolName(request.toolCall)
        ? previous.name
        : undefined;

      return {
        ...request,
        toolCall: {
          ...request.toolCall,
          ...(request.toolCall.kind === undefined && previous.kind
            ? { kind: previous.kind }
            : {}),
          ...(inheritedName
            ? {
                _meta: {
                  ...request.toolCall._meta,
                  claudeCode: {
                    ...(metadata && typeof metadata === "object"
                      ? metadata
                      : {}),
                    toolName: previous.name,
                  },
                },
              }
            : {}),
        },
      };
    },
  };
}
