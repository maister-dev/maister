// M30 (ADR-078 L2): read-only chat turns — the prompt carries readOnlyTurn,
// and requestPermission auto-rejects unambiguous MUTATING toolCall kinds
// BEFORE any SSE emit or pending-permission registration (so no
// session.permission_request event and no web hitl row). read/fetch pass;
// execute (bash) passes and relies on the L3 sensor. A mutating kind with no
// reject option passes through (L2 is best-effort by design; L3 guards).

import { describe, expect, it } from "vitest";

import { resolveReadOnlyAutoReject } from "../acp-client";
import { parseGateChatHitlId, SendPromptRequestSchema } from "../types";

const OPTIONS = [
  { optionId: "allow-1", kind: "allow_once", name: "Allow" },
  { optionId: "reject-1", kind: "reject_once", name: "Reject" },
];

describe("SendPromptRequestSchema readOnlyTurn (ADR-078 L2)", () => {
  it("accepts an optional readOnlyTurn boolean", () => {
    const r = SendPromptRequestSchema.safeParse({
      stepId: "gate-chat-abc",
      prompt: "hi",
      readOnlyTurn: true,
    });

    expect(r.success).toBe(true);
    expect(r.success && r.data.readOnlyTurn).toBe(true);
  });

  it("stays valid without the flag (existing senders unchanged)", () => {
    const r = SendPromptRequestSchema.safeParse({
      stepId: "implement",
      prompt: "hi",
    });

    expect(r.success).toBe(true);
  });
});

describe("resolveReadOnlyAutoReject (L2 classifier)", () => {
  it("auto-rejects unambiguous mutating kinds on a read-only turn", () => {
    for (const kind of ["edit", "write", "create", "delete", "move"]) {
      const r = resolveReadOnlyAutoReject(true, { kind }, OPTIONS);

      expect(r?.optionId).toBe("reject-1");
    }
  });

  it("lets read/fetch pass", () => {
    for (const kind of ["read", "fetch"]) {
      expect(resolveReadOnlyAutoReject(true, { kind }, OPTIONS)).toBeNull();
    }
  });

  it("lets execute (bash) pass — L3 is the guarantee", () => {
    expect(
      resolveReadOnlyAutoReject(true, { kind: "execute" }, OPTIONS),
    ).toBeNull();
  });

  it("is inert when the turn is not read-only", () => {
    expect(
      resolveReadOnlyAutoReject(false, { kind: "edit" }, OPTIONS),
    ).toBeNull();
    expect(
      resolveReadOnlyAutoReject(undefined, { kind: "edit" }, OPTIONS),
    ).toBeNull();
  });

  it("passes through when no reject option exists (best-effort, never throws)", () => {
    expect(
      resolveReadOnlyAutoReject(true, { kind: "edit" }, [
        { optionId: "allow-1", kind: "allow_once", name: "Allow" },
      ]),
    ).toBeNull();
  });

  it("passes through on a missing/unknown kind (only UNAMBIGUOUS kinds reject)", () => {
    expect(resolveReadOnlyAutoReject(true, {}, OPTIONS)).toBeNull();
    expect(
      resolveReadOnlyAutoReject(true, { kind: "other" }, OPTIONS),
    ).toBeNull();
  });
});

describe("parseGateChatHitlId (DD4 marker)", () => {
  it("extracts the hitlRequestId from a gate-chat stepId", () => {
    expect(parseGateChatHitlId("gate-chat-0f9d6c1e-1111")).toBe(
      "0f9d6c1e-1111",
    );
  });

  it("returns null for non-chat stepIds", () => {
    expect(parseGateChatHitlId("implement")).toBeNull();
    expect(parseGateChatHitlId("gate-chat-")).toBeNull();
  });
});
