import { describe, expect, it } from "vitest";

import {
  encodeHookTripPayload,
  encodeToolPayload,
  interpretScratchUpdate,
  parseQuickReplies,
  parseScratchMessageContent,
  summarizeToolInput,
} from "@/lib/scratch-runs/transcript";

describe("interpretScratchUpdate", () => {
  it("extracts assistant text and skips empty chunks", () => {
    expect(
      interpretScratchUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      }),
    ).toEqual({ kind: "text", text: "hello" });

    expect(
      interpretScratchUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "" },
      }),
    ).toBeNull();
  });

  it("classifies tool_call with name, arg, and status", () => {
    expect(
      interpretScratchUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "toolu_1",
        kind: "read",
        status: "pending",
        rawInput: { file_path: "src/app.ts" },
        content: [],
        _meta: { claudeCode: { toolName: "Read" } },
      }),
    ).toMatchObject({
      kind: "tool_call",
      toolCallId: "toolu_1",
      name: "Read",
      toolKind: "read",
      status: "pending",
      arg: "src/app.ts",
    });
  });

  it("extracts result text and status from tool_call_update", () => {
    expect(
      interpretScratchUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "done" } }],
      }),
    ).toMatchObject({
      kind: "tool_update",
      toolCallId: "toolu_1",
      status: "completed",
      result: "done",
    });
  });

  it("drops protocol noise", () => {
    expect(
      interpretScratchUpdate({ sessionUpdate: "available_commands_update" }),
    ).toBeNull();
    expect(
      interpretScratchUpdate({ sessionUpdate: "current_mode_update" }),
    ).toBeNull();
    expect(interpretScratchUpdate(null)).toBeNull();
    expect(interpretScratchUpdate("{}")).toBeNull();
  });

  it("reads token usage", () => {
    expect(
      interpretScratchUpdate({
        sessionUpdate: "usage_update",
        used: 55650,
        size: 200000,
      }),
    ).toEqual({ kind: "usage", used: 55650, size: 200000 });
  });
});

describe("summarizeToolInput", () => {
  it("prefers the most specific known argument key", () => {
    expect(summarizeToolInput({ command: "ls -la" })).toBe("ls -la");
    expect(summarizeToolInput({ file_path: "a.ts", command: "x" })).toBe(
      "a.ts",
    );
    expect(summarizeToolInput({ unknown: "x" })).toBe("");
    expect(summarizeToolInput(null)).toBe("");
  });
});

describe("parseScratchMessageContent", () => {
  it("round-trips a tool payload", () => {
    const content = encodeToolPayload({
      name: "Bash",
      toolKind: "execute",
      status: "completed",
      arg: "npm test",
      rawInput: { command: "npm test" },
      result: "ok",
    });

    expect(parseScratchMessageContent("tool", content)).toEqual({
      kind: "tool",
      tool: {
        v: 1,
        kind: "tool",
        name: "Bash",
        toolKind: "execute",
        status: "completed",
        arg: "npm test",
        rawInput: { command: "npm test" },
        result: "ok",
      },
    });
  });

  it("renders assistant as markdown and falls back for legacy JSON", () => {
    expect(parseScratchMessageContent("assistant", "# hi")).toEqual({
      kind: "text",
      markdown: true,
      text: "# hi",
    });
    expect(
      parseScratchMessageContent("system", '{"jsonrpc":"2.0","id":0}'),
    ).toMatchObject({ kind: "legacy", role: "system" });
  });

  it("hides complete Flow assistant action fences from assistant markdown", () => {
    const parsed = parseScratchMessageContent(
      "assistant",
      [
        "I'll update the Flow.",
        "```maister-flow-assistant-action",
        '{"schemaVersion":"maister_flow_assistant_action.v1","summary":"Update","operations":[{"op":"upsert_file","path":"flow.yaml","baseHash":null,"content":"raw file content"}]}',
        "```",
        "Done.",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      kind: "text",
      markdown: true,
      text: "I'll update the Flow.\nDone.",
    });
  });

  it("hides incomplete Flow assistant action fences while streaming", () => {
    const parsed = parseScratchMessageContent(
      "assistant",
      [
        "Working on it.",
        "```maister-flow-assistant-action",
        '{"operations":[{"content":"raw file content"}]}',
      ].join("\n"),
    );

    expect(parsed).toEqual({
      kind: "text",
      markdown: true,
      text: "Working on it.",
    });
  });

  it("shows a friendly placeholder for action-only assistant chunks", () => {
    const parsed = parseScratchMessageContent(
      "assistant",
      [
        "```maister-flow-assistant-action",
        '{"operations":[{"content":"raw file content"}]}',
      ].join("\n"),
    );

    expect(parsed).toEqual({
      kind: "text",
      markdown: true,
      text: "I prepared a Flow update for MAIster to validate.",
    });
  });

  it("round-trips a hook_trip payload (ADR-108)", () => {
    const content = encodeHookTripPayload("repetition", "halt");

    expect(parseScratchMessageContent("system", content)).toEqual({
      kind: "hook_trip",
      rule: "repetition",
      disposition: "halt",
    });
  });
});

describe("parseQuickReplies", () => {
  const aifPlanMessage = [
    "Картина ясна: Flow management уже есть как панели per-project board.",
    "",
    "Прежде чем глубже копать, мне нужно понять scope. Один вопрос:",
    "",
    "**Какой Flow management ты проектируешь?**",
    "",
    "1. **Платформенный каталог Flow-плагинов** (новая страница в `/admin/`) — реестр всех Flow.",
    "2. **Per-project Flow management v2** — переработка существующих панелей.",
    "3. **Оба сразу** — платформа сверху, проект снизу.",
    "4. **Что-то другое** — опиши.",
    "",
    "Подсказка: название ветки может означать разное.",
  ].join("\n");

  it("extracts options from a prose question with a bold-titled list", () => {
    expect(parseQuickReplies(aifPlanMessage)).toEqual([
      {
        label: "Платформенный каталог Flow-плагинов",
        value: "Платформенный каталог Flow-плагинов",
      },
      {
        label: "Per-project Flow management v2",
        value: "Per-project Flow management v2",
      },
      { label: "Оба сразу", value: "Оба сразу" },
      { label: "Что-то другое", value: "Что-то другое" },
    ]);
  });

  it("handles plain (non-bold) options, trimming at the dash", () => {
    const text =
      "Which approach?\n1) Local merge — fast\n2) Pull request — reviewable";

    expect(parseQuickReplies(text)).toEqual([
      { label: "Local merge", value: "Local merge" },
      { label: "Pull request", value: "Pull request" },
    ]);
  });

  it("does not fire on a numbered plan without a preceding question", () => {
    const plan =
      "Here is the plan:\n1. Read the file\n2. Edit it\n3. Run tests\nDone.";

    expect(parseQuickReplies(plan)).toEqual([]);
  });

  it("requires at least two options", () => {
    expect(parseQuickReplies("Proceed?\n1. Yes")).toEqual([]);
  });

  it("returns nothing for plain prose", () => {
    expect(parseQuickReplies("All done. Anything else?")).toEqual([]);
  });
});
