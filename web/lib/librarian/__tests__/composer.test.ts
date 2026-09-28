import { describe, expect, it } from "vitest";

import {
  composeLibrarianContext,
  decideSessionMode,
  type ComposerMessage,
} from "@/lib/librarian/composer";

// D3 (ADR-185): the composer is a pure selection over supplied rows. The
// owner's current message always goes in; older messages fill the remaining
// budget newest-first; anything left out is recorded as `truncated`.

function message(
  seq: number,
  body: string,
  authorKind = "owner",
): ComposerMessage {
  return {
    id: `m${seq}`,
    seq: BigInt(seq),
    authorKind: authorKind as ComposerMessage["authorKind"],
    body,
  };
}

const base = {
  instructions: "INSTRUCTIONS",
  instructionsVersion: "v-test",
  subject: null,
  summaries: [],
  memoryItems: [],
};

describe("UT-LCV-10: the composer keeps the owner's message and stays in budget", () => {
  it("includes every message when the budget allows, oldest first", () => {
    const composed = composeLibrarianContext({
      ...base,
      history: [message(1, "hello"), message(2, "hi there", "librarian")],
      current: message(3, "what is ABC-1?"),
      maxChars: 10_000,
    });

    expect(composed.messageIds).toEqual(["m1", "m2", "m3"]);
    expect(composed.truncated).toBe(false);
    expect(composed.prompt.indexOf("hello")).toBeLessThan(
      composed.prompt.indexOf("what is ABC-1?"),
    );
    expect(composed.charCount).toBe(composed.prompt.length);
  });

  it("drops the oldest history first and marks the context truncated", () => {
    const composed = composeLibrarianContext({
      ...base,
      history: [
        message(1, "x".repeat(400)),
        message(2, "y".repeat(400), "librarian"),
      ],
      current: message(3, "current question"),
      maxChars: 900,
    });

    expect(composed.messageIds).toEqual(["m2", "m3"]);
    expect(composed.truncated).toBe(true);
  });

  it("always includes the owner's current message, even over budget", () => {
    const composed = composeLibrarianContext({
      ...base,
      history: [message(1, "earlier")],
      current: message(2, "z".repeat(5_000)),
      maxChars: 100,
    });

    expect(composed.messageIds).toEqual(["m2"]);
    expect(composed.prompt).toContain("z".repeat(5_000));
    expect(composed.truncated).toBe(true);
  });

  it("records the instructions version and empty revision maps", () => {
    const composed = composeLibrarianContext({
      ...base,
      history: [],
      current: message(1, "q"),
      maxChars: 1_000,
    });

    expect(composed.instructionsVersion).toBe("v-test");
    expect(composed.summaryRevisions).toEqual({});
    expect(composed.memoryItemRevisions).toEqual({});
  });
});

describe("IT-LCV-06 (pure part): resume only under the same epoch and runner", () => {
  const stored = {
    acpSessionId: "acp-1",
    sessionEpoch: 3,
    sessionRunnerId: "r1",
    sessionRunnerSnapshot: {
      id: "r1",
      adapter: "claude",
      capabilityAgent: "claude",
      model: "test",
      providerKind: "anthropic",
      permissionPolicy: "ask",
    },
    runnerSnapshot: {
      id: "r1",
      adapter: "claude",
      capabilityAgent: "claude",
      model: "test",
      providerKind: "anthropic",
      permissionPolicy: "ask",
    },
  };

  it("resumes when the epoch and runner both match", () => {
    expect(
      decideSessionMode({ ...stored, conversationEpoch: 3, runnerId: "r1" }),
    ).toBe("resume");
  });

  it("starts a new session on an epoch change, a runner change or no handle", () => {
    expect(
      decideSessionMode({ ...stored, conversationEpoch: 4, runnerId: "r1" }),
    ).toBe("new");
    expect(
      decideSessionMode({ ...stored, conversationEpoch: 3, runnerId: "r2" }),
    ).toBe("new");
    expect(
      decideSessionMode({
        ...stored,
        conversationEpoch: 3,
        runnerId: "r1",
        runnerSnapshot: { ...stored.runnerSnapshot, model: "new-model" },
      }),
    ).toBe("new");
    expect(
      decideSessionMode({
        ...stored,
        acpSessionId: null,
        conversationEpoch: 3,
        runnerId: "r1",
      }),
    ).toBe("new");
    expect(
      decideSessionMode({
        ...stored,
        sessionEpoch: null,
        conversationEpoch: 0,
        runnerId: "r1",
      }),
    ).toBe("new");
  });
});
