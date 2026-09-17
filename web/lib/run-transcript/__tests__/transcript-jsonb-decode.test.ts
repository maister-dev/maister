// Ingest escapes the characters `jsonb` cannot hold so a single NUL can no
// longer wedge the event plane. That escape is a STORAGE representation: the
// reader must hand back exactly what the agent produced, or the fix would have
// traded an outage for silently corrupted transcripts.
//
// Note the order. The real pipeline escapes the payload OBJECT at ingest, so by
// the time the transcript projector stringifies a value it already carries the
// marker. Escaping the STRINGIFIED form instead would be a no-op, because
// JSON.stringify has already turned the NUL into a six-character escape — and
// that escape is exactly what blows up the projector's `::jsonb` casts.
import { describe, expect, it } from "vitest";

import { encodeJsonbSafe } from "@/lib/execution-host/events/jsonb-safe";
import {
  encodeThoughtPayload,
  encodeToolPayload,
  parseScratchMessageContent,
} from "@/lib/run-transcript/transcript";

const NUL = String.fromCharCode(0);
const NUL_TEXT = `edit ${NUL} here`;
const JSON_NUL_ESCAPE = "\\u0000";

describe("transcript decoding of jsonb-safe escapes", () => {
  it("restores a NUL inside a thought", () => {
    const stored = encodeThoughtPayload(encodeJsonbSafe(NUL_TEXT));

    expect(stored).not.toContain(JSON_NUL_ESCAPE);
    expect(stored).not.toContain(NUL);

    expect(parseScratchMessageContent("system", stored)).toEqual({
      kind: "thought",
      text: NUL_TEXT,
    });
  });

  it("restores a NUL inside a tool result and its raw input", () => {
    const stored = encodeToolPayload(
      encodeJsonbSafe({
        name: "Edit",
        toolKind: "edit",
        status: "completed" as const,
        arg: "read-model.ts",
        rawInput: { needle: NUL_TEXT },
        result: NUL_TEXT,
      }),
    );

    expect(stored).not.toContain(JSON_NUL_ESCAPE);

    const parsed = parseScratchMessageContent("tool", stored);

    expect(parsed.kind).toBe("tool");
    if (parsed.kind !== "tool") throw new Error("expected a tool message");
    expect(parsed.tool.result).toBe(NUL_TEXT);
    expect(parsed.tool.rawInput).toEqual({ needle: NUL_TEXT });
  });

  it("leaves ordinary content untouched", () => {
    expect(
      parseScratchMessageContent(
        "system",
        encodeThoughtPayload("nothing special here"),
      ),
    ).toEqual({ kind: "thought", text: "nothing special here" });
    expect(parseScratchMessageContent("user", "plain user text")).toEqual({
      kind: "text",
      markdown: false,
      text: "plain user text",
    });
  });
});
