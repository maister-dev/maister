// ADR-108 (M40): the pure guardrail engine. Every decision is a pure function so
// every branch is unit-tested directly (the resolveReadOnlySessionDecision
// pattern), independent of the ACP connection wiring.

import { describe, expect, it } from "vitest";

import {
  classifyProgressUpdate,
  extractWritePath,
  HOOK_RULE_META,
  noProgressTick,
  repetitionTick,
  resolvePathGuardDecision,
  toolCallSignature,
  WRITE_KINDS,
} from "../guardrail-hooks";

const WORKTREE = "/Users/dev/repo/.maister/wt/run-1";

describe("extractWritePath", () => {
  it("flags every write kind and reads the standardized locations[0].path", () => {
    for (const kind of WRITE_KINDS) {
      const r = extractWritePath({
        kind,
        locations: [{ path: `${WORKTREE}/src/x.ts` }],
      });

      expect(r).toEqual({ isWrite: true, path: `${WORKTREE}/src/x.ts` });
    }
  });

  it("is not a write for read-safe / unknown / absent kinds", () => {
    for (const kind of ["read", "search", "fetch", "think", "execute"]) {
      expect(extractWritePath({ kind }).isWrite).toBe(false);
    }
    expect(extractWritePath({}).isWrite).toBe(false);
    expect(extractWritePath({ kind: "frobnicate" }).isWrite).toBe(false);
  });

  it("returns a write with no path when locations is absent (kind-only fallback)", () => {
    expect(extractWritePath({ kind: "edit" })).toEqual({
      isWrite: true,
      path: undefined,
    });
    expect(extractWritePath({ kind: "write", locations: [] })).toEqual({
      isWrite: true,
      path: undefined,
    });
  });
});

describe("resolvePathGuardDecision", () => {
  const guard = (allowedPaths: string[]) => ({ allowedPaths });

  it("returns null when the rule is not armed", () => {
    expect(
      resolvePathGuardDecision({
        pathGuard: undefined,
        toolCall: { kind: "edit", locations: [{ path: `${WORKTREE}/x` }] },
        worktreePath: WORKTREE,
      }),
    ).toBeNull();
  });

  it("returns null for a non-write call (path_guard governs writes only)", () => {
    expect(
      resolvePathGuardDecision({
        pathGuard: guard(["src/**"]),
        toolCall: { kind: "read", locations: [{ path: `${WORKTREE}/secret` }] },
        worktreePath: WORKTREE,
      }),
    ).toBeNull();
  });

  it("allows an in-lane write (glob match on the worktree-relative path)", () => {
    expect(
      resolvePathGuardDecision({
        pathGuard: guard(["src/**", "tests/**"]),
        toolCall: {
          kind: "edit",
          locations: [{ path: `${WORKTREE}/src/a/b.ts` }],
        },
        worktreePath: WORKTREE,
      }),
    ).toEqual({ decision: "allow" });
  });

  it("denies an in-tree write outside the allow-set (out_of_lane)", () => {
    expect(
      resolvePathGuardDecision({
        pathGuard: guard(["src/**"]),
        toolCall: {
          kind: "write",
          locations: [{ path: `${WORKTREE}/secrets/.env` }],
        },
        worktreePath: WORKTREE,
      }),
    ).toEqual({ decision: "deny", reason: "out_of_lane" });
  });

  it("denies an out-of-tree absolute write (out_of_lane)", () => {
    expect(
      resolvePathGuardDecision({
        pathGuard: guard(["src/**"]),
        toolCall: { kind: "write", locations: [{ path: "/etc/passwd" }] },
        worktreePath: WORKTREE,
      }),
    ).toEqual({ decision: "deny", reason: "out_of_lane" });
  });

  it("denies a `..` traversal escaping the worktree (out_of_lane)", () => {
    expect(
      resolvePathGuardDecision({
        pathGuard: guard(["**"]),
        toolCall: {
          kind: "edit",
          locations: [{ path: `${WORKTREE}/../../other/x.ts` }],
        },
        worktreePath: WORKTREE,
      }),
    ).toEqual({ decision: "deny", reason: "out_of_lane" });
  });

  it("denies a write-kind call with no extractable path (kind_only_fallback)", () => {
    expect(
      resolvePathGuardDecision({
        pathGuard: guard(["src/**"]),
        toolCall: { kind: "edit" },
        worktreePath: WORKTREE,
      }),
    ).toEqual({ decision: "deny", reason: "kind_only_fallback" });
  });

  describe('"**" sentinel = any in-tree write allowed (not a literal glob)', () => {
    it("allows any in-tree write", () => {
      expect(
        resolvePathGuardDecision({
          pathGuard: guard(["**"]),
          toolCall: {
            kind: "create",
            locations: [{ path: `${WORKTREE}/anywhere/deep/x.ts` }],
          },
          worktreePath: WORKTREE,
        }),
      ).toEqual({ decision: "allow" });
    });

    it("still denies an out-of-tree write under the sentinel", () => {
      expect(
        resolvePathGuardDecision({
          pathGuard: guard(["**"]),
          toolCall: { kind: "write", locations: [{ path: "/tmp/evil" }] },
          worktreePath: WORKTREE,
        }),
      ).toEqual({ decision: "deny", reason: "out_of_lane" });
    });

    it("still denies a kind-only write under the sentinel", () => {
      expect(
        resolvePathGuardDecision({
          pathGuard: guard(["**"]),
          toolCall: { kind: "delete" },
          worktreePath: WORKTREE,
        }),
      ).toEqual({ decision: "deny", reason: "kind_only_fallback" });
    });
  });

  it("matches a relative toolCall path against the worktree-relative globs", () => {
    expect(
      resolvePathGuardDecision({
        pathGuard: guard(["src/**"]),
        toolCall: { kind: "edit", locations: [{ path: "src/a.ts" }] },
        worktreePath: WORKTREE,
      }),
    ).toEqual({ decision: "allow" });
  });

  it("supports single-* (one path segment) globs", () => {
    const base = {
      pathGuard: guard(["*.md"]),
      worktreePath: WORKTREE,
    };

    expect(
      resolvePathGuardDecision({
        ...base,
        toolCall: {
          kind: "edit",
          locations: [{ path: `${WORKTREE}/README.md` }],
        },
      }),
    ).toEqual({ decision: "allow" });
    // `*` does not cross a separator → a nested file is out of lane.
    expect(
      resolvePathGuardDecision({
        ...base,
        toolCall: {
          kind: "edit",
          locations: [{ path: `${WORKTREE}/docs/x.md` }],
        },
      }),
    ).toEqual({ decision: "deny", reason: "out_of_lane" });
  });
});

describe("toolCallSignature", () => {
  it("is stable across identical calls that differ only by toolCallId", () => {
    const a = toolCallSignature({
      toolCallId: "tc_01",
      kind: "edit",
      title: "Edit src/x.ts",
      locations: [{ path: "src/x.ts" }],
    });
    const b = toolCallSignature({
      toolCallId: "tc_99",
      kind: "edit",
      title: "Edit src/x.ts",
      locations: [{ path: "src/x.ts" }],
    });

    expect(a).toBe(b);
  });

  it("differs when a meaningful field differs", () => {
    const a = toolCallSignature({ toolCallId: "x", kind: "edit", title: "A" });
    const b = toolCallSignature({ toolCallId: "x", kind: "edit", title: "B" });

    expect(a).not.toBe(b);
  });

  it("handles null / primitive toolCalls without throwing", () => {
    expect(toolCallSignature(null)).toBe("null");
    expect(toolCallSignature(undefined)).toBe("null");
    expect(typeof toolCallSignature("str")).toBe("string");
  });
});

describe("repetitionTick", () => {
  it("counts consecutive identical signatures and trips at EXACTLY max", () => {
    const max = 5;
    let state = {
      lastToolCallSig: undefined as string | undefined,
      repeatCount: 0,
    };
    const trips: boolean[] = [];

    for (let i = 0; i < 5; i += 1) {
      const r = repetitionTick(state, "sig-A", max);

      state = {
        lastToolCallSig: r.lastToolCallSig,
        repeatCount: r.repeatCount,
      };
      trips.push(r.tripped);
    }

    // Trips only on the 5th identical call.
    expect(trips).toEqual([false, false, false, false, true]);
    expect(state.repeatCount).toBe(5);
  });

  it("resets the run to 1 on a differing signature", () => {
    let state = { lastToolCallSig: "sig-A", repeatCount: 4 };
    const r = repetitionTick(state, "sig-B", 5);

    expect(r).toEqual({
      lastToolCallSig: "sig-B",
      repeatCount: 1,
      tripped: false,
    });

    state = { lastToolCallSig: r.lastToolCallSig, repeatCount: r.repeatCount };
    expect(repetitionTick(state, "sig-B", 5).repeatCount).toBe(2);
  });

  it("trips on the first call when max is 1", () => {
    expect(
      repetitionTick({ lastToolCallSig: undefined, repeatCount: 0 }, "s", 1)
        .tripped,
    ).toBe(true);
  });

  it("re-arms after a reset: a fresh run of identical sigs trips again at max", () => {
    const max = 3;
    // A near-trip run on sig-A, then a differing sig resets the run to 1.
    let r = repetitionTick(
      { lastToolCallSig: "sig-A", repeatCount: 2 },
      "sig-B",
      max,
    );

    expect(r).toMatchObject({ repeatCount: 1, tripped: false });

    // Driving sig-B back up to `max` consecutive trips again — no off-by-one on
    // the post-reset increment path.
    let state = {
      lastToolCallSig: r.lastToolCallSig,
      repeatCount: r.repeatCount,
    };

    r = repetitionTick(state, "sig-B", max);
    expect(r).toMatchObject({ repeatCount: 2, tripped: false });
    state = { lastToolCallSig: r.lastToolCallSig, repeatCount: r.repeatCount };
    r = repetitionTick(state, "sig-B", max);
    expect(r).toMatchObject({ repeatCount: 3, tripped: true });
  });
});

describe("classifyProgressUpdate", () => {
  it("treats a write-kind tool_call as a progress turn", () => {
    expect(
      classifyProgressUpdate({ sessionUpdate: "tool_call", kind: "edit" }),
    ).toEqual({ isTurn: true, isProgress: true });
  });

  it("treats a non-write tool_call as an idle turn", () => {
    expect(
      classifyProgressUpdate({ sessionUpdate: "tool_call", kind: "read" }),
    ).toEqual({ isTurn: true, isProgress: false });
    expect(
      classifyProgressUpdate({ sessionUpdate: "tool_call", kind: "execute" }),
    ).toEqual({ isTurn: true, isProgress: false });
  });

  it("ignores non-tool_call updates (chunks, plans, nulls) — not a turn", () => {
    expect(
      classifyProgressUpdate({ sessionUpdate: "agent_message_chunk" }),
    ).toEqual({
      isTurn: false,
      isProgress: false,
    });
    expect(classifyProgressUpdate({ sessionUpdate: "plan" }).isTurn).toBe(
      false,
    );
    expect(classifyProgressUpdate(null).isTurn).toBe(false);
    expect(classifyProgressUpdate(undefined).isTurn).toBe(false);
  });
});

describe("noProgressTick", () => {
  it("increments on idle turns and trips at EXACTLY maxTurns", () => {
    const max = 3;
    let state = { turnsSinceProgress: 0 };
    const trips: boolean[] = [];

    for (let i = 0; i < 3; i += 1) {
      const r = noProgressTick(state, false, max);

      state = { turnsSinceProgress: r.turnsSinceProgress };
      trips.push(r.tripped);
    }

    expect(trips).toEqual([false, false, true]);
  });

  it("resets to 0 on a progress turn", () => {
    const r = noProgressTick({ turnsSinceProgress: 14 }, true, 15);

    expect(r).toEqual({ turnsSinceProgress: 0, tripped: false });
  });
});

describe("HOOK_RULE_META (frozen matrix)", () => {
  it("maps each rule to its lifecycle + disposition", () => {
    expect(HOOK_RULE_META.path_guard).toEqual({
      lifecycle: "pre_tool_call",
      disposition: "deny",
    });
    expect(HOOK_RULE_META.repetition).toEqual({
      lifecycle: "pre_tool_call",
      disposition: "halt",
    });
    expect(HOOK_RULE_META.no_progress).toEqual({
      lifecycle: "post_turn",
      disposition: "halt",
    });
  });
});
