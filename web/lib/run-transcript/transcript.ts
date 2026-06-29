import type { ScratchMessageRole } from "@/lib/db/schema";

import {
  FLOW_ASSISTANT_ACTION_FENCE,
  parseFlowActionResultPayload,
  type FlowActionResultPayload,
} from "@/lib/studio/flow-assistant/protocol";

// Shared, framework-pure contract for scratch transcript messages. Both the
// server-side ACP projector (events.ts) and the client renderer
// (scratch-dialog.tsx) import this so the on-disk/in-DB content encoding never
// drifts between writer and reader. No "server-only" — the client imports it.
//
// Encoding (no schema migration — content is the single payload field):
//   role "user"      -> plain text
//   role "assistant" -> plain markdown text (coalesced agent_message_chunk)
//   role "tool"      -> JSON ScratchToolPayload
//   role "system"    -> JSON ScratchSystemPayload (thought | usage | permission | ...)

export type ScratchToolStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed";

export type ScratchToolPayload = {
  v: 1;
  kind: "tool";
  name: string;
  toolKind: string;
  status: ScratchToolStatus;
  arg: string;
  rawInput: unknown;
  result: string;
};

export type ScratchThoughtPayload = { v: 1; kind: "thought"; text: string };
export type ScratchUsagePayload = {
  v: 1;
  kind: "usage";
  used: number;
  size: number;
};
export type ScratchPermissionPayload = {
  v: 1;
  kind: "permission";
  prompt: string;
};

// ADR-108 (M40): a guardrail trip surfaced inline in a scratch transcript. A
// scratch run never escalates to NeedsInput (D2) — the trip is a chat notice
// only. `deny` = path_guard deny-and-continue; `halt` = a liveness breaker.
export type ScratchHookTripRule = "path_guard" | "repetition" | "no_progress";
export type ScratchHookTripPayload = {
  v: 1;
  kind: "hook_trip";
  rule: ScratchHookTripRule;
  disposition: "deny" | "halt";
};

export type ScratchFlowActionResultPayload = FlowActionResultPayload;

export type ScratchSystemPayload =
  | ScratchThoughtPayload
  | ScratchUsagePayload
  | ScratchPermissionPayload
  | ScratchHookTripPayload
  | ScratchFlowActionResultPayload;

export type ParsedScratchMessage =
  | { kind: "text"; markdown: boolean; text: string }
  | { kind: "tool"; tool: ScratchToolPayload }
  | { kind: "thought"; text: string }
  | { kind: "usage"; used: number; size: number }
  | { kind: "permission"; prompt: string }
  | {
      kind: "hook_trip";
      rule: ScratchHookTripRule;
      disposition: "deny" | "halt";
    }
  | { kind: "flow_action_result"; payload: ScratchFlowActionResultPayload }
  | { kind: "legacy"; role: ScratchMessageRole; text: string };

export type QuickReply = { label: string; value: string };

// Ordered by specificity: the first rawInput key present becomes the badge's
// one-line argument summary (e.g. Read -> file_path, Bash -> command).
export const TOOL_ARG_KEYS = [
  "file_path",
  "path",
  "command",
  "pattern",
  "url",
  "skill",
  "query",
  "notebook_path",
  "prompt",
  "description",
] as const;

const FLOW_ASSISTANT_ACTION_FENCE_PREFIX = "```" + FLOW_ASSISTANT_ACTION_FENCE;
const FLOW_ASSISTANT_ACTION_PLACEHOLDER =
  "I prepared a Flow update for MAIster to validate.";

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function findActionFenceStart(content: string, from: number): number {
  let index = content.indexOf(FLOW_ASSISTANT_ACTION_FENCE_PREFIX, from);

  while (index >= 0) {
    if (index === 0 || content[index - 1] === "\n") return index;
    index = content.indexOf(FLOW_ASSISTANT_ACTION_FENCE_PREFIX, index + 1);
  }

  return -1;
}

export function stripFlowAssistantActionFencesForDisplay(
  content: string,
): string {
  let cursor = 0;
  let output = "";
  let stripped = false;

  while (cursor < content.length) {
    const start = findActionFenceStart(content, cursor);

    if (start < 0) {
      output += content.slice(cursor);
      break;
    }

    output += content.slice(cursor, start);
    stripped = true;

    const fenceLineEnd = content.indexOf("\n", start);

    if (fenceLineEnd < 0) break;

    const closeStart = content.indexOf("\n```", fenceLineEnd + 1);

    if (closeStart < 0) break;

    const closeLineEnd = content.indexOf("\n", closeStart + 4);

    cursor = closeLineEnd < 0 ? content.length : closeLineEnd + 1;
  }

  if (!stripped) return content;

  const normalized = output
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return normalized.length > 0 ? normalized : FLOW_ASSISTANT_ACTION_PLACEHOLDER;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function chunkText(content: unknown): string {
  const block = asObject(content);

  return block && typeof block.text === "string" ? block.text : "";
}

export function toolNameFromUpdate(update: Record<string, unknown>): string {
  const meta = asObject(update._meta);
  const claudeCode = meta ? asObject(meta.claudeCode) : null;

  if (
    claudeCode &&
    typeof claudeCode.toolName === "string" &&
    claudeCode.toolName
  ) {
    return claudeCode.toolName;
  }
  if (typeof update.title === "string" && update.title) return update.title;

  return "tool";
}

function hasToolName(update: Record<string, unknown>): boolean {
  const meta = asObject(update._meta);
  const claudeCode = meta ? asObject(meta.claudeCode) : null;

  return (
    (!!claudeCode && typeof claudeCode.toolName === "string") ||
    typeof update.title === "string"
  );
}

export function summarizeToolInput(rawInput: unknown): string {
  const input = asObject(rawInput);

  if (!input) return "";
  for (const key of TOOL_ARG_KEYS) {
    const value = input[key];

    if (typeof value === "string" && value.trim()) return value.trim();
  }

  return "";
}

export function normalizeToolStatus(
  status: unknown,
): ScratchToolStatus | undefined {
  return status === "pending" ||
    status === "in_progress" ||
    status === "completed" ||
    status === "failed"
    ? status
    : undefined;
}

export function toolResultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];

  for (const item of content) {
    const entry = asObject(item);

    if (!entry) continue;
    const inner = asObject(entry.content);

    if (inner && typeof inner.text === "string") parts.push(inner.text);
    else if (typeof entry.text === "string") parts.push(entry.text);
  }

  return parts.join("\n");
}

export type InterpretedScratchUpdate =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | {
      kind: "tool_call";
      toolCallId: string;
      name: string;
      toolKind: string;
      status: ScratchToolStatus;
      arg: string;
      rawInput: unknown;
      result: string;
    }
  | {
      kind: "tool_update";
      toolCallId: string;
      name?: string;
      toolKind?: string;
      status?: ScratchToolStatus;
      arg?: string;
      rawInput?: unknown;
      result?: string;
    }
  | { kind: "usage"; used: number; size: number }
  | null;

// Classify one ACP `session.update.update` payload into a renderable unit, or
// null for noise (empty stream chunks, available_commands_update,
// current_mode_update, plan, unknown shapes).
export function interpretScratchUpdate(
  update: unknown,
): InterpretedScratchUpdate {
  const u = asObject(update);

  if (!u) return null;

  switch (u.sessionUpdate) {
    case "agent_message_chunk": {
      const text = chunkText(u.content);

      return text ? { kind: "text", text } : null;
    }
    case "agent_thought_chunk": {
      const text = chunkText(u.content);

      return text ? { kind: "thought", text } : null;
    }
    case "tool_call": {
      if (typeof u.toolCallId !== "string") return null;

      return {
        kind: "tool_call",
        toolCallId: u.toolCallId,
        name: toolNameFromUpdate(u),
        toolKind: typeof u.kind === "string" ? u.kind : "other",
        status: normalizeToolStatus(u.status) ?? "pending",
        arg: summarizeToolInput(u.rawInput),
        rawInput: u.rawInput ?? null,
        result: toolResultText(u.content),
      };
    }
    case "tool_call_update": {
      if (typeof u.toolCallId !== "string") return null;
      const arg = summarizeToolInput(u.rawInput);
      const result = toolResultText(u.content);
      const rawInput = asObject(u.rawInput);

      return {
        kind: "tool_update",
        toolCallId: u.toolCallId,
        name: hasToolName(u) ? toolNameFromUpdate(u) : undefined,
        toolKind: typeof u.kind === "string" ? u.kind : undefined,
        status: normalizeToolStatus(u.status),
        arg: arg || undefined,
        rawInput:
          rawInput && Object.keys(rawInput).length > 0 ? u.rawInput : undefined,
        result: result || undefined,
      };
    }
    case "usage_update": {
      const used = numberOrNull(u.used);
      const size = numberOrNull(u.size);

      return used !== null && size !== null
        ? { kind: "usage", used, size }
        : null;
    }
    default:
      return null;
  }
}

export function encodeToolPayload(tool: {
  name: string;
  toolKind: string;
  status: ScratchToolStatus;
  arg: string;
  rawInput: unknown;
  result: string;
}): string {
  const payload: ScratchToolPayload = {
    v: 1,
    kind: "tool",
    name: tool.name,
    toolKind: tool.toolKind,
    status: tool.status,
    arg: tool.arg,
    rawInput: tool.rawInput ?? null,
    result: tool.result,
  };

  return JSON.stringify(payload);
}

export function encodeThoughtPayload(text: string): string {
  const payload: ScratchThoughtPayload = { v: 1, kind: "thought", text };

  return JSON.stringify(payload);
}

export function encodeUsagePayload(used: number, size: number): string {
  const payload: ScratchUsagePayload = { v: 1, kind: "usage", used, size };

  return JSON.stringify(payload);
}

export function encodePermissionPayload(prompt: string): string {
  const payload: ScratchPermissionPayload = {
    v: 1,
    kind: "permission",
    prompt,
  };

  return JSON.stringify(payload);
}

export function encodeHookTripPayload(
  rule: ScratchHookTripRule,
  disposition: "deny" | "halt",
): string {
  const payload: ScratchHookTripPayload = {
    v: 1,
    kind: "hook_trip",
    rule,
    disposition,
  };

  return JSON.stringify(payload);
}

export function parseScratchMessageContent(
  role: ScratchMessageRole,
  content: string,
): ParsedScratchMessage {
  if (role === "assistant")
    return {
      kind: "text",
      markdown: true,
      text: stripFlowAssistantActionFencesForDisplay(content),
    };
  if (role === "user") return { kind: "text", markdown: false, text: content };

  let parsed: unknown = null;

  try {
    parsed = JSON.parse(content);
  } catch {
    return { kind: "legacy", role, text: content };
  }

  const obj = asObject(parsed);

  if (obj && obj.v === 1) {
    if (role === "tool" && obj.kind === "tool") {
      return { kind: "tool", tool: obj as unknown as ScratchToolPayload };
    }
    if (obj.kind === "thought" && typeof obj.text === "string") {
      return { kind: "thought", text: obj.text };
    }
    if (
      obj.kind === "usage" &&
      typeof obj.used === "number" &&
      typeof obj.size === "number"
    ) {
      return { kind: "usage", used: obj.used, size: obj.size };
    }
    if (obj.kind === "permission" && typeof obj.prompt === "string") {
      return { kind: "permission", prompt: obj.prompt };
    }
    if (
      obj.kind === "hook_trip" &&
      (obj.rule === "path_guard" ||
        obj.rule === "repetition" ||
        obj.rule === "no_progress") &&
      (obj.disposition === "deny" || obj.disposition === "halt")
    ) {
      return {
        kind: "hook_trip",
        rule: obj.rule,
        disposition: obj.disposition,
      };
    }
    if (obj.kind === "flow_action_result") {
      const payload = parseFlowActionResultPayload(obj);

      if (payload) return { kind: "flow_action_result", payload };
    }
  }

  return { kind: "legacy", role, text: content };
}

const OPTION_LINE = /^\s*\d+[.)]\s+(.+\S)\s*$/;
const QUICK_REPLY_MAX = 8;
const QUICK_REPLY_LABEL_MAX = 90;

function quickReplyLabel(optionBody: string): string {
  const bold = optionBody.match(/^\*\*(.+?)\*\*/);
  const base = bold
    ? bold[1]
    : (optionBody.split(/\s+[—–-]\s+|:\s+/)[0] ?? optionBody);
  const cleaned = base.replace(/\*\*/g, "").replace(/`/g, "").trim();

  return cleaned.length > QUICK_REPLY_LABEL_MAX
    ? `${cleaned.slice(0, QUICK_REPLY_LABEL_MAX - 1)}…`
    : cleaned;
}

// Heuristic: turn an agent's prose "question + numbered options" into clickable
// quick replies. Triggers ONLY when a `?`-terminated line appears BEFORE the
// first enumerated item — that guard rejects plain numbered plans/step lists
// (which have no preceding question). Returns [] when it does not match, so the
// caller falls back to the free-text composer.
export function parseQuickReplies(text: string): QuickReply[] {
  if (!text || !text.includes("?")) return [];
  const lines = text.split("\n");
  const firstOptionIndex = lines.findIndex((line) => OPTION_LINE.test(line));

  if (firstOptionIndex === -1) return [];

  const hasQuestionBeforeOptions = lines
    .slice(0, firstOptionIndex)
    .some((line) => line.replace(/[*_\s]+$/, "").endsWith("?"));

  if (!hasQuestionBeforeOptions) return [];

  const replies: QuickReply[] = [];

  for (const line of lines.slice(firstOptionIndex)) {
    const match = line.match(OPTION_LINE);

    if (!match) continue;
    const label = quickReplyLabel(match[1]);

    if (label) replies.push({ label, value: label });
  }

  return replies.length >= 2 ? replies.slice(0, QUICK_REPLY_MAX) : [];
}

// --- Run-kind-agnostic aliases (T-B1) --------------------------------------
// This module is the canonical transcript substrate shared by scratch AND flow
// (`lib/scratch-runs/transcript.ts` re-exports it for back-compat). The `Scratch*`
// names above are retained verbatim; the generic aliases below are what the flow
// transcript projector + read model consume so neither surface forks the
// interpret/parse/encode logic.
export const interpretSessionUpdate = interpretScratchUpdate;
export const parseTranscriptMessageContent = parseScratchMessageContent;
export type InterpretedSessionUpdate = InterpretedScratchUpdate;
export type ParsedTranscriptMessage = ParsedScratchMessage;
