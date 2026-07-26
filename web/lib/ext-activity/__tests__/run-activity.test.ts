import { describe, expect, it } from "vitest";

import { encodeThoughtPayload, encodeToolPayload, encodeUsagePayload } from "@/lib/run-transcript/transcript";
import {
  buildSemanticRunActivityItems,
  pageRunActivityItems,
} from "@/lib/ext-activity/run-feed";

const RUN_ID = "run-123";

describe("run activity semantic replay", () => {
  it("turns transcript rows into assistant-safe semantic items", () => {
    const items = buildSemanticRunActivityItems([
      {
        id: "msg-1",
        runId: RUN_ID,
        nodeId: "plan",
        role: "assistant",
        content: "Planning the fix",
        lastMutationId: 1n,
        ts: new Date("2026-07-26T10:00:00.000Z"),
      },
      {
        id: "tool-1",
        runId: RUN_ID,
        nodeId: "implement",
        role: "tool",
        content: encodeToolPayload({
          name: "Edit",
          toolKind: "edit",
          status: "completed",
          arg: "web/lib/foo.ts",
          rawInput: { file_path: "web/lib/foo.ts" },
          result: "",
        }),
        lastMutationId: 2n,
        ts: new Date("2026-07-26T10:01:00.000Z"),
      },
      {
        id: "thought-1",
        runId: RUN_ID,
        nodeId: "implement",
        role: "system",
        content: encodeThoughtPayload("Need to inspect the config"),
        lastMutationId: 3n,
        ts: new Date("2026-07-26T10:02:00.000Z"),
      },
      {
        id: "usage-1",
        runId: RUN_ID,
        nodeId: "implement",
        role: "system",
        content: encodeUsagePayload(100, 200000),
        lastMutationId: 4n,
        ts: new Date("2026-07-26T10:03:00.000Z"),
      },
    ]);

    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "file_change",
      "reasoning",
    ]);
    expect(items[1]).toMatchObject({
      summary: "edited web/lib/foo.ts",
      salience: "high",
      action: {
        verb: "edit",
        object: "web/lib/foo.ts",
        outcome: "completed",
      },
    });
    expect(items[2].salience).toBe("low");
  });

  it("falls back to a generic item for unclassified payloads", () => {
    const items = buildSemanticRunActivityItems([
      {
        id: "legacy-1",
        runId: RUN_ID,
        nodeId: null,
        role: "system",
        content: "{\"unexpected\":true}",
        lastMutationId: 7n,
        ts: null,
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("generic");
    expect(items[0].summary).toContain("system update");
  });

  it("pages by mutation horizon so in-place mutations resurface", () => {
    const items = buildSemanticRunActivityItems([
      {
        id: "tool-1",
        runId: RUN_ID,
        nodeId: "implement",
        role: "tool",
        content: encodeToolPayload({
          name: "Edit",
          toolKind: "edit",
          status: "in_progress",
          arg: "web/lib/foo.ts",
          rawInput: { file_path: "web/lib/foo.ts" },
          result: "",
        }),
        lastMutationId: 3n,
        ts: new Date("2026-07-26T10:01:00.000Z"),
      },
      {
        id: "tool-1",
        runId: RUN_ID,
        nodeId: "implement",
        role: "tool",
        content: encodeToolPayload({
          name: "Edit",
          toolKind: "edit",
          status: "completed",
          arg: "web/lib/foo.ts",
          rawInput: { file_path: "web/lib/foo.ts" },
          result: "",
        }),
        lastMutationId: 5n,
        ts: new Date("2026-07-26T10:02:00.000Z"),
      },
    ]);
    const page = pageRunActivityItems(items, {
      sinceId: 4n,
      limit: 10,
      salience: "low",
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: "tool-1",
      lastMutationId: 5n,
      action: { outcome: "completed" },
    });
    expect(page.nextSinceId).toBe(5n);
    expect(page.hasMore).toBe(false);
  });
});
