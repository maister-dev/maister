import { describe, expect, it } from "vitest";

import { extractLatestAvailableCommands } from "@/lib/scratch-runs/available-commands";

function ev(
  monotonicId: number,
  commands: Array<Record<string, unknown>>,
): string {
  return JSON.stringify({
    type: "session.update",
    sessionId: "s1",
    monotonicId,
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: commands,
    },
  });
}

describe("extractLatestAvailableCommands (FR-A1/A2/A3)", () => {
  it("returns [] when there is no available_commands_update", () => {
    const log = [
      JSON.stringify({
        type: "session.update",
        update: { sessionUpdate: "agent_message_chunk" },
      }),
      JSON.stringify({ type: "session.line", line: "hi" }),
    ].join("\n");

    expect(extractLatestAvailableCommands(log)).toEqual([]);
  });

  it("maps name/description/hint and keeps names AS-EMITTED (codex $-baked)", () => {
    const log = ev(3, [
      {
        name: "$aif-plan",
        description: "Plan a feature",
        input: { hint: "<feature>" },
      },
      { name: "/status", description: "Show status" },
    ]);

    expect(extractLatestAvailableCommands(log)).toEqual([
      { name: "$aif-plan", description: "Plan a feature", hint: "<feature>" },
      { name: "/status", description: "Show status", hint: null },
    ]);
  });

  it("extracts available commands from raw JSON-RPC session.line entries", () => {
    const log = JSON.stringify({
      type: "session.line",
      line: JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "agent-session",
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              {
                name: "aif-plan",
                description: "Plan a feature",
                input: { hint: "<feature>" },
              },
              { name: "compact", description: "Compact context" },
            ],
          },
        },
      }),
    });

    expect(extractLatestAvailableCommands(log)).toEqual([
      { name: "aif-plan", description: "Plan a feature", hint: "<feature>" },
      { name: "compact", description: "Compact context", hint: null },
    ]);
  });

  it("is latest-wins across multiple snapshots", () => {
    const log = [
      ev(1, [{ name: "old", description: "old" }]),
      ev(5, [{ name: "new", description: "new" }]),
    ].join("\n");

    expect(extractLatestAvailableCommands(log).map((c) => c.name)).toEqual([
      "new",
    ]);
  });

  it("ignores malformed JSON lines and unnamed commands", () => {
    const log = [
      "{ not json",
      ev(2, [{ description: "no name" }, { name: "ok", description: "d" }]),
    ].join("\n");

    expect(extractLatestAvailableCommands(log).map((c) => c.name)).toEqual([
      "ok",
    ]);
  });

  it("ignores a non-available-commands session.update that mentions the string in text", () => {
    // fast-path substring match must not promote a chat message
    const log = JSON.stringify({
      type: "session.update",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { text: "talking about available_commands_update here" },
      },
    });

    expect(extractLatestAvailableCommands(log)).toEqual([]);
  });
});
