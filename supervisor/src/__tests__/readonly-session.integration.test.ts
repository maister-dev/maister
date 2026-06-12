// M33 (ADR-088 L1): session-scoped read-only arbitration. The session is
// headless (no HITL inbox exists for none/repo_read platform-agent runs), so
// EVERY permission request must be decided inline: read-safe kinds approved,
// everything else — including execute (bash) and unknown kinds — denied.
// A deny with no reject-shaped option answers with the `cancelled` outcome.

import { describe, expect, it } from "vitest";

import { resolveReadOnlySessionDecision } from "../acp-client";
import { StartSessionRequestSchema } from "../types";

const OPTIONS = [
  { optionId: "allow-1", kind: "allow_once", name: "Allow" },
  { optionId: "reject-1", kind: "reject_once", name: "Reject" },
];

const BASE_SESSION = {
  runId: "run-1",
  projectSlug: "proj",
  worktreePath: "/tmp/agent-run",
  stepId: "agent",
  executor: { agent: "claude", model: "claude-sonnet-4-6" },
};

describe("StartSessionRequestSchema readOnlySession (ADR-088 L1)", () => {
  it("accepts an optional readOnlySession boolean", () => {
    const r = StartSessionRequestSchema.safeParse({
      ...BASE_SESSION,
      readOnlySession: true,
    });

    expect(r.success).toBe(true);
    expect(r.success && r.data.readOnlySession).toBe(true);
  });

  it("stays valid without the flag (existing senders unchanged)", () => {
    const r = StartSessionRequestSchema.safeParse(BASE_SESSION);

    expect(r.success).toBe(true);
  });
});

describe("resolveReadOnlySessionDecision (L1 arbitration)", () => {
  it("approves read-safe kinds with the allow option", () => {
    for (const kind of ["read", "search", "fetch", "think"]) {
      const d = resolveReadOnlySessionDecision(true, { kind }, OPTIONS);

      expect(d).toEqual({
        decision: "allow",
        option: expect.objectContaining({ optionId: "allow-1" }),
      });
    }
  });

  it("denies write-class kinds with the reject option", () => {
    for (const kind of ["edit", "write", "create", "delete", "move"]) {
      const d = resolveReadOnlySessionDecision(true, { kind }, OPTIONS);

      expect(d).toEqual({
        decision: "deny",
        option: expect.objectContaining({ optionId: "reject-1" }),
      });
    }
  });

  it("denies execute (bash can mutate) and unknown/missing kinds — fail closed", () => {
    for (const toolCall of [
      { kind: "execute" },
      { kind: "other" },
      {},
    ] as const) {
      const d = resolveReadOnlySessionDecision(true, toolCall, OPTIONS);

      expect(d?.decision).toBe("deny");
    }
  });

  it("denies with a null option (cancelled outcome) when no reject option exists", () => {
    const d = resolveReadOnlySessionDecision(true, { kind: "edit" }, [
      { optionId: "allow-1", kind: "allow_once", name: "Allow" },
    ]);

    expect(d).toEqual({ decision: "deny", option: null });
  });

  it("fails closed when an allow-intent has no allow-shaped option", () => {
    const d = resolveReadOnlySessionDecision(true, { kind: "read" }, [
      { optionId: "weird-1", kind: "custom", name: "Custom" },
    ]);

    expect(d?.decision).toBe("deny");
  });

  it("is inert for normal sessions — the HITL flow stays untouched", () => {
    expect(
      resolveReadOnlySessionDecision(false, { kind: "edit" }, OPTIONS),
    ).toBeNull();
    expect(
      resolveReadOnlySessionDecision(undefined, { kind: "edit" }, OPTIONS),
    ).toBeNull();
  });
});
