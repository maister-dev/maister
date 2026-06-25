import type { SupervisorEvent } from "@/lib/supervisor-client";

import { describe, expect, it, vi } from "vitest";

// events.ts issues `update(...).set(...).where(eq(scratch_messages.id, id))` and
// `select(...).where(eq(scratch_messages.run_id, runId))`. The fake DB below
// updates rows by id, so `eq` must surface the predicate value. The select fake
// ignores its predicate, so passing the value through is harmless there.
vi.mock("drizzle-orm", async (orig) => {
  const actual = await orig<typeof import("drizzle-orm")>();

  return { ...actual, eq: (_col: unknown, value: unknown) => value };
});

import { sendScratchPromptAndProjectEvents } from "@/lib/scratch-runs/events";
import {
  encodeHookTripPayload,
  encodeToolPayload,
  interpretScratchUpdate,
  parseQuickReplies,
  parseScratchMessageContent,
  summarizeToolInput,
} from "@/lib/scratch-runs/transcript";

type Row = {
  id: string;
  runId: string;
  sequence: number;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
};

function makeFakeDb(rows: Row[]) {
  return {
    select() {
      return {
        from() {
          return {
            async where() {
              return rows.map((row) => ({ sequence: row.sequence }));
            },
          };
        },
      };
    },
    insert() {
      return {
        async values(row: Row) {
          rows.push({ ...row });
        },
      };
    },
    update() {
      return {
        set(patch: { content: string }) {
          return {
            async where(id: string) {
              const row = rows.find((candidate) => candidate.id === id);

              if (row) row.content = patch.content;
            },
          };
        },
      };
    },
  };
}

function makeApi(updates: unknown[]) {
  return {
    async cancelPermission() {
      return { ok: true as const };
    },
    async sendPrompt() {
      return { stopReason: "end_turn" as const };
    },
    async *streamSession() {
      let monotonicId = 0;

      for (const update of updates) {
        monotonicId += 1;
        yield {
          type: "session.update" as const,
          sessionId: "sup-1",
          monotonicId,
          update,
        };
      }
    },
  };
}

async function project(updates: unknown[]): Promise<Row[]> {
  const rows: Row[] = [];

  await sendScratchPromptAndProjectEvents({
    runId: "run-1",
    sessionId: "sup-1",
    stepId: "dialog",
    prompt: "go",
    db: makeFakeDb(rows),
    api: makeApi(updates),
  });

  return rows;
}

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

describe("scratch hook_trip notice (ADR-108 T3.3)", () => {
  function makeRawApi(events: SupervisorEvent[]) {
    return {
      async cancelPermission() {
        return { ok: true as const };
      },
      async sendPrompt() {
        return { stopReason: "end_turn" as const };
      },
      async *streamSession() {
        for (const ev of events) yield ev;
      },
    };
  }

  it("appends a system notice and never escalates to NeedsInput", async () => {
    const rows: Row[] = [];

    await sendScratchPromptAndProjectEvents({
      runId: "run-1",
      sessionId: "sup-1",
      stepId: "dialog",
      prompt: "go",
      db: makeFakeDb(rows) as never,
      api: makeRawApi([
        {
          type: "session.hook_trip",
          sessionId: "sup-1",
          monotonicId: 1,
          rule: "path_guard",
          lifecycle: "pre_tool_call",
          disposition: "deny",
          toolCall: { title: "Edit /etc/passwd" },
        },
      ]) as never,
    });

    const system = rows.filter((row) => row.role === "system");

    expect(system).toHaveLength(1);
    expect(parseScratchMessageContent("system", system[0].content)).toEqual({
      kind: "hook_trip",
      rule: "path_guard",
      disposition: "deny",
    });
  });
});

describe("transcript coalescing", () => {
  it("merges streamed assistant chunks into a single bubble", async () => {
    const rows = await project([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hel" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "lo" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: " world" },
      },
    ]);

    const assistant = rows.filter((row) => row.role === "assistant");

    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe("Hello world");
  });

  it("merges tool_call and its updates into one tool row", async () => {
    const rows = await project([
      {
        sessionUpdate: "tool_call",
        toolCallId: "toolu_1",
        status: "pending",
        rawInput: { command: "git status" },
        content: [],
        _meta: { claudeCode: { toolName: "Bash" } },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_1",
        status: "in_progress",
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_1",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "clean" } },
        ],
      },
    ]);

    const tools = rows.filter((row) => row.role === "tool");

    expect(tools).toHaveLength(1);
    const parsed = parseScratchMessageContent("tool", tools[0].content);

    expect(parsed).toMatchObject({
      kind: "tool",
      tool: {
        name: "Bash",
        arg: "git status",
        status: "completed",
        result: "clean",
      },
    });
  });

  it("starts a new assistant bubble after an interleaved tool call", async () => {
    const rows = await project([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "before" },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "toolu_1",
        status: "completed",
        content: [],
        _meta: { claudeCode: { toolName: "Read" } },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "after" },
      },
    ]);

    const assistant = rows.filter((row) => row.role === "assistant");

    expect(assistant.map((row) => row.content)).toEqual(["before", "after"]);
    expect(rows.filter((row) => row.role === "tool")).toHaveLength(1);
  });

  it("keeps a single coalesced usage row", async () => {
    const rows = await project([
      { sessionUpdate: "usage_update", used: 10, size: 100 },
      { sessionUpdate: "usage_update", used: 20, size: 100 },
    ]);

    const usage = rows.filter((row) => row.role === "system");

    expect(usage).toHaveLength(1);
    expect(parseScratchMessageContent("system", usage[0].content)).toEqual({
      kind: "usage",
      used: 20,
      size: 100,
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
