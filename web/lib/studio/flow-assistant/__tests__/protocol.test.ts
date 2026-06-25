import { describe, expect, it } from "vitest";

import {
  FLOW_ASSISTANT_ACTION_SCHEMA_VERSION,
  createAppliedActionResult,
  parseAssistantActionBlocks,
  stripAssistantProtocolBlocks,
} from "../protocol";

import { parseScratchMessageContent } from "@/lib/scratch-runs/transcript";

describe("Flow assistant action protocol", () => {
  it("extracts a valid action and strips protocol JSON from markdown", () => {
    const markdown = [
      "I will update the flow.",
      "",
      "```maister-flow-assistant-action",
      JSON.stringify({
        schemaVersion: FLOW_ASSISTANT_ACTION_SCHEMA_VERSION,
        summary: "Update README",
        operations: [
          {
            op: "upsert_file",
            path: "README.md",
            baseHash: null,
            content: "# Hello\n",
          },
        ],
      }),
      "```",
    ].join("\n");

    const parsed = parseAssistantActionBlocks(markdown);

    expect(parsed.kind).toBe("parsed");
    expect(parsed.sanitizedText).toBe("I will update the flow.");
    if (parsed.kind !== "parsed") return;
    expect(parsed.action.operations[0]?.path).toBe("README.md");
    expect(parsed.action.actionId).toMatch(/^act_/);
    expect(stripAssistantProtocolBlocks(markdown)).not.toContain(
      "maister_flow_assistant_action",
    );
  });

  it("turns malformed action blocks into sanitized invalid states", () => {
    const parsed = parseAssistantActionBlocks(
      '```maister-flow-assistant-action\n{"bad": true}\n```',
    );

    expect(parsed.kind).toBe("malformed");
    expect(parsed.sanitizedText).toBe("");
    if (parsed.kind !== "malformed") return;
    expect(parsed.issueSummary.join("\n")).toContain("schemaVersion");
  });

  it("parses sanitized flow_action_result system messages", () => {
    const action = {
      schemaVersion: FLOW_ASSISTANT_ACTION_SCHEMA_VERSION,
      actionId: "act_test",
      summary: "Update README",
      operations: [
        {
          op: "upsert_file" as const,
          path: "README.md",
          baseHash: null,
          content: "# Hello\n",
        },
      ],
    };
    const result = createAppliedActionResult({ action });
    const parsed = parseScratchMessageContent("system", JSON.stringify(result));

    expect(parsed.kind).toBe("flow_action_result");
    if (parsed.kind !== "flow_action_result") return;
    expect(parsed.payload.status).toBe("applied");
    expect(parsed.payload.touchedPaths).toEqual(["README.md"]);
  });
});
