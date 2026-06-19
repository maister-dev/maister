// B1 (execution-policy permissions=auto_approve): inline L3 permission
// auto-approval. The supervisor's requestPermission handler runs L1 (read-only
// session) then L2 (read-only gate-chat turn) FIRST — both early-return — so
// this L3 layer is consulted only when neither read-only layer fired; read-only
// always wins (structural, like L2's "L3 is the guarantee" note). On no
// allow-shaped option the handler falls through to the HITL deferred rather
// than blind-approving.

import { describe, expect, it } from "vitest";

import { resolveAutoApproveOption } from "../acp-client";
import { StartSessionRequestSchema } from "../types";

const BASE_SESSION = {
  runId: "run-1",
  projectSlug: "proj",
  worktreePath: "/tmp/agent-run",
  stepId: "agent",
  executor: { agent: "claude", model: "claude-sonnet-4-6" },
};

describe("StartSessionRequestSchema autoApprovePermissions (B1)", () => {
  it("accepts an optional autoApprovePermissions boolean", () => {
    const r = StartSessionRequestSchema.safeParse({
      ...BASE_SESSION,
      autoApprovePermissions: true,
    });

    expect(r.success).toBe(true);
    expect(r.success && r.data.autoApprovePermissions).toBe(true);
  });

  it("stays valid without the flag (existing senders unchanged)", () => {
    const r = StartSessionRequestSchema.safeParse(BASE_SESSION);

    expect(r.success).toBe(true);
  });
});

describe("resolveAutoApproveOption (L3 allow-pick)", () => {
  it("prefers an explicit allow_once option", () => {
    const option = resolveAutoApproveOption([
      { optionId: "allow-1", kind: "allow_once", name: "Allow once" },
      { optionId: "always-1", kind: "allow_always", name: "Always" },
      { optionId: "reject-1", kind: "reject_once", name: "Reject" },
    ]);

    expect(option).toEqual(expect.objectContaining({ optionId: "allow-1" }));
  });

  it("falls back to any allow* kind when there is no allow_once", () => {
    const option = resolveAutoApproveOption([
      { optionId: "always-1", kind: "allow_always", name: "Always" },
      { optionId: "reject-1", kind: "reject_once", name: "Reject" },
    ]);

    expect(option).toEqual(expect.objectContaining({ optionId: "always-1" }));
  });

  it("returns null when only reject options exist (caller falls through to HITL)", () => {
    expect(
      resolveAutoApproveOption([
        { optionId: "reject-1", kind: "reject_once", name: "Reject" },
        { optionId: "reject-2", kind: "reject", name: "Deny" },
      ]),
    ).toBeNull();
  });

  it("returns null for an empty option set (never blind-approve)", () => {
    expect(resolveAutoApproveOption([])).toBeNull();
  });

  it("ignores unknown/custom kinds (only allow* is auto-approved)", () => {
    expect(
      resolveAutoApproveOption([
        { optionId: "weird-1", kind: "custom", name: "Custom" },
      ]),
    ).toBeNull();
  });
});
