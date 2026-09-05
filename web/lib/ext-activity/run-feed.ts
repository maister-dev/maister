import type { RunActivityCursor } from "@/lib/ext-activity/cursor";
import type {
  ActivityAction,
  ActivitySalience,
  RunActivityItem,
  RunActivitySourceMessage,
} from "@/lib/ext-activity/types";

import {
  parseScratchMessageContent,
  summarizeToolInput,
  type ScratchToolPayload,
} from "@/lib/run-transcript/transcript";
import { filterBySalience } from "@/lib/ext-activity/salience";

type RunActivityPage = {
  items: RunActivityItem[];
  nextSinceId: RunActivityCursor;
  hasMore: boolean;
};

function truncateSummary(text: string, max = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();

  return normalized.length > max
    ? `${normalized.slice(0, max - 1)}…`
    : normalized;
}

function isWriteTool(tool: ScratchToolPayload): boolean {
  const name = tool.name.toLowerCase();
  const kind = tool.toolKind.toLowerCase();

  return (
    name.includes("edit") ||
    name.includes("write") ||
    name.includes("patch") ||
    kind.includes("edit") ||
    kind.includes("write") ||
    kind.includes("patch")
  );
}

function toolPath(tool: ScratchToolPayload): string | null {
  const input =
    tool.rawInput && typeof tool.rawInput === "object"
      ? (tool.rawInput as Record<string, unknown>)
      : null;
  const pathValue =
    (input?.file_path as string | undefined) ??
    (input?.path as string | undefined) ??
    summarizeToolInput(tool.rawInput);

  return typeof pathValue === "string" && pathValue.length > 0
    ? pathValue
    : null;
}

function toolCommand(tool: ScratchToolPayload): string | null {
  const input =
    tool.rawInput && typeof tool.rawInput === "object"
      ? (tool.rawInput as Record<string, unknown>)
      : null;
  const command =
    (input?.command as string | undefined) ??
    (tool.arg.length > 0 ? tool.arg : undefined);

  return typeof command === "string" && command.length > 0 ? command : null;
}

function looksLikeTestCommand(command: string | null): boolean {
  if (!command) return false;

  return /\b(test|vitest|jest|pytest|cargo test|go test|mvn test)\b/i.test(
    command,
  );
}

function toolAction(
  tool: ScratchToolPayload,
): Pick<RunActivityItem, "kind" | "salience" | "summary" | "action"> {
  const path = toolPath(tool);
  const command = toolCommand(tool);
  const outcome = tool.status;

  if (isWriteTool(tool) && path) {
    const summary =
      outcome === "completed"
        ? `edited ${path}`
        : outcome === "failed"
          ? `edit failed for ${path}`
          : `editing ${path}`;

    return {
      kind: "file_change",
      salience: "high",
      summary,
      action: {
        verb: "edit",
        object: path,
        outcome,
      },
    };
  }

  if (looksLikeTestCommand(command)) {
    return {
      kind: "test",
      salience: outcome === "failed" ? "high" : "normal",
      summary: outcome === "completed" ? "ran tests" : "running tests",
      action: {
        verb: "run",
        object: command ?? "tests",
        outcome,
      },
    };
  }

  if (command) {
    return {
      kind: "command",
      salience: outcome === "failed" ? "high" : "normal",
      summary:
        outcome === "completed"
          ? `ran ${command}`
          : outcome === "failed"
            ? `command failed: ${command}`
            : `running ${command}`,
      action: {
        verb: "run",
        object: command,
        outcome,
      },
    };
  }

  return {
    kind: "tool_call",
    salience: outcome === "failed" ? "high" : "normal",
    summary:
      outcome === "completed"
        ? `used ${tool.name}`
        : outcome === "failed"
          ? `${tool.name} failed`
          : `using ${tool.name}`,
    action: {
      verb: "use",
      object: tool.name,
      outcome,
    },
  };
}

function genericSystemAction(input: { content: string; summary?: string }): {
  salience: ActivitySalience;
  summary: string;
  action: ActivityAction;
} {
  const summary =
    input.summary ?? truncateSummary(input.content || "system update");

  return {
    salience: "normal",
    summary: summary.length > 0 ? summary : "system update",
    action: {
      verb: "report",
      object: "system update",
      outcome: "observed",
    },
  };
}

function toRunActivityItem(
  message: RunActivitySourceMessage,
): RunActivityItem | null {
  const parsed = parseScratchMessageContent(message.role, message.content);

  switch (parsed.kind) {
    case "text":
      return {
        id: message.id,
        lastMutationId: message.lastMutationId,
        ts: message.ts,
        runId: message.runId,
        nodeId: message.nodeId,
        kind: "message",
        salience: "normal",
        summary: truncateSummary(parsed.text),
        action: {
          verb: "say",
          object: "assistant message",
          outcome: "ok",
          detail: parsed.text,
        },
      };
    case "thought":
      return {
        id: message.id,
        lastMutationId: message.lastMutationId,
        ts: message.ts,
        runId: message.runId,
        nodeId: message.nodeId,
        kind: "reasoning",
        salience: "low",
        summary: truncateSummary(parsed.text),
        action: {
          verb: "reason",
          object: "internal note",
          outcome: "recorded",
          detail: parsed.text,
        },
      };
    case "tool": {
      const action = toolAction(parsed.tool);

      return {
        id: message.id,
        lastMutationId: message.lastMutationId,
        ts: message.ts,
        runId: message.runId,
        nodeId: message.nodeId,
        ...action,
      };
    }
    case "permission":
      return {
        id: message.id,
        lastMutationId: message.lastMutationId,
        ts: message.ts,
        runId: message.runId,
        nodeId: message.nodeId,
        kind: "hitl",
        salience: "high",
        summary: "requested permission",
        action: {
          verb: "request",
          object: "permission",
          outcome: "waiting",
          detail: parsed.prompt,
        },
      };
    case "hook_trip":
      return {
        id: message.id,
        lastMutationId: message.lastMutationId,
        ts: message.ts,
        runId: message.runId,
        nodeId: message.nodeId,
        kind: "lifecycle",
        salience: parsed.disposition === "halt" ? "high" : "normal",
        summary:
          parsed.disposition === "halt"
            ? `guardrail ${parsed.rule} halted the run`
            : `guardrail ${parsed.rule} denied a call`,
        action: {
          verb: "trip",
          object: `guardrail ${parsed.rule}`,
          outcome: parsed.disposition,
        },
      };
    case "flow_action_result":
    case "legacy": {
      const generic = genericSystemAction(
        parsed.kind === "legacy"
          ? {
              content: parsed.text,
              summary:
                message.role === "system"
                  ? "system update"
                  : truncateSummary(parsed.text || "update"),
            }
          : {
              content: JSON.stringify(parsed.payload),
              summary: "system update",
            },
      );

      return {
        id: message.id,
        lastMutationId: message.lastMutationId,
        ts: message.ts,
        runId: message.runId,
        nodeId: message.nodeId,
        kind: "generic",
        ...generic,
      };
    }
    case "usage":
      return null;
  }
}

export function buildSemanticRunActivityItems(
  messages: readonly RunActivitySourceMessage[],
): RunActivityItem[] {
  const latestById = new Map<string, RunActivitySourceMessage>();

  for (const message of messages) {
    const previous = latestById.get(message.id);

    if (!previous || message.lastMutationId >= previous.lastMutationId) {
      latestById.set(message.id, message);
    }
  }

  return Array.from(latestById.values())
    .sort((left, right) =>
      left.lastMutationId === right.lastMutationId
        ? left.id.localeCompare(right.id)
        : left.lastMutationId < right.lastMutationId
          ? -1
          : 1,
    )
    .map(toRunActivityItem)
    .filter((item): item is RunActivityItem => item !== null);
}

export function pageRunActivityItems(
  items: readonly RunActivityItem[],
  input: {
    sinceId: RunActivityCursor | null;
    limit: number;
    salience: ActivitySalience;
  },
): RunActivityPage {
  const isAfterCursor = (item: RunActivityItem): boolean => {
    if (input.sinceId === null) {
      return true;
    }

    if (item.lastMutationId > input.sinceId.lastMutationId) {
      return true;
    }

    if (item.lastMutationId < input.sinceId.lastMutationId) {
      return false;
    }

    if (input.sinceId.lastItemId === null) {
      return false;
    }

    return item.id.localeCompare(input.sinceId.lastItemId) > 0;
  };

  const filtered = filterBySalience(items, input.salience).filter((item) =>
    isAfterCursor(item),
  );
  const pageItems = filtered.slice(0, input.limit);
  const nextSinceId =
    pageItems.length > 0
      ? {
          lastMutationId: pageItems[pageItems.length - 1].lastMutationId,
          lastItemId: pageItems[pageItems.length - 1].id,
        }
      : (input.sinceId ?? { lastMutationId: 0n, lastItemId: null });

  return {
    items: pageItems,
    nextSinceId,
    hasMore: filtered.length > pageItems.length,
  };
}
