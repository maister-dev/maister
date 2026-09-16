// TRC-07/08/09 + EDGE-TRC-05/07: the prompt-specific concerns that sit with
// the dispatcher rather than with the generic `run_messages` allocator.
//
// A dispatched prompt is the one thing a reader needs to judge whether an agent
// did what it was told, and today only the FIRST prompt of a node attempt is
// kept — gate, consensus and resume dispatches are dropped entirely by an owner
// filter plus a write-once guard. Recording all of them means answering three
// questions that the allocator has no business knowing about: what identifies a
// dispatch, how large a body may be, and what the host appends to it.

import type { ContextMountSnapshot } from "@/lib/context-mounts/types";

import { describe, expect, it, vi } from "vitest";

import { consensusPromptOperationKey } from "@/lib/flows/graph/consensus/prompt-owner";
import { nodePromptOperationKey } from "@/lib/flows/graph/node-prompt-owner";
import {
  PROMPT_BODY_MAX_BYTES,
  appendContextMountLine,
  boundPromptBody,
  promptDispatchKey,
  recordDispatchedPrompt,
} from "@/lib/flows/graph/prompt-record";
import { gatePromptOperationKey } from "@/lib/flows/graph/prompt-owner";

const NODE = {
  variant: "node",
  nodeAttemptId: "attempt-1",
  promptOrdinal: 0,
} as const;
const RESUME = {
  variant: "permission_resume",
  nodeAttemptId: "attempt-1",
  promptOrdinal: 1,
  hitlRequestId: "hitl-1",
} as const;
const GATE_AI = {
  variant: "gate_ai",
  nodeAttemptId: "attempt-1",
  gateId: "review",
  evaluationId: "eval-1",
  promptOrdinal: 0,
} as const;
const GATE_SKILL = { ...GATE_AI, variant: "gate_skill" } as const;
const VERIFIER = {
  variant: "consensus_verifier",
  nodeAttemptId: "attempt-1",
  round: 1,
  verifierId: "v1",
  targetId: "t1",
  verdictId: "verdict-1",
} as const;
const SYNTHESIS = {
  variant: "consensus_synthesis",
  nodeAttemptId: "attempt-1",
  round: 1,
  synthesisId: "synthesis-1",
} as const;

describe("promptDispatchKey", () => {
  // UT-TRC-07. D5: the command plane already defines canonical per-owner
  // identity. A second scheme would drift from the fence identity the rest of
  // the plane uses, so the key must be DERIVED from those functions — asserted
  // by containment, which a hand-rolled duplicate string would not satisfy
  // once either source function changed.
  it("UT-TRC-07: derives every variant's key from the existing operation-key functions", async () => {
    expect(promptDispatchKey(NODE)).toContain(nodePromptOperationKey(NODE));
    expect(promptDispatchKey(RESUME)).toContain(nodePromptOperationKey(RESUME));
    expect(promptDispatchKey(GATE_AI)).toContain(
      gatePromptOperationKey(GATE_AI),
    );
    expect(promptDispatchKey(GATE_SKILL)).toContain(
      gatePromptOperationKey(GATE_SKILL),
    );
    expect(promptDispatchKey(VERIFIER)).toContain(
      consensusPromptOperationKey(VERIFIER),
    );
    expect(promptDispatchKey(SYNTHESIS)).toContain(
      consensusPromptOperationKey(SYNTHESIS),
    );
  });

  it("UT-TRC-07: gives all six variants distinct keys", async () => {
    const owners = [NODE, RESUME, GATE_AI, GATE_SKILL, VERIFIER, SYNTHESIS];
    const keys = owners.map((owner) => promptDispatchKey(owner));

    expect(new Set(keys).size).toBe(owners.length);
  });

  // Two dispatches inside ONE attempt are what the write-once guard used to
  // collapse. They must not share a key, or the constraint would silently make
  // the second a no-op — reintroducing the bug at the database layer.
  it("UT-TRC-07: separates repeat dispatches within one node attempt", async () => {
    expect(promptDispatchKey(NODE)).not.toBe(
      promptDispatchKey({ ...NODE, promptOrdinal: 1 }),
    );
  });
});

describe("boundPromptBody", () => {
  // UT-TRC-09
  it("UT-TRC-09: leaves a body within the bound byte-exact", async () => {
    const body = "implement the widget";
    const bounded = boundPromptBody(body);

    expect(bounded).toEqual({ content: body, truncated: false });
  });

  // UT-EDGE-TRC-05. A resolved prompt can inject artifact bodies via
  // `{{ artifacts.<id>.content }}` (ADR-120) and reach megabytes. Storing that
  // unbounded in `run_messages.content` would reintroduce exactly the row-bloat
  // this work removes.
  it("UT-EDGE-TRC-05: truncates an over-bound body behind a marker naming the full source", async () => {
    const body = "x".repeat(PROMPT_BODY_MAX_BYTES + 10_000);
    const bounded = boundPromptBody(body);

    expect(bounded.truncated).toBe(true);
    expect(Buffer.byteLength(bounded.content, "utf8")).toBeLessThanOrEqual(
      PROMPT_BODY_MAX_BYTES,
    );
    expect(bounded.content).toContain("node_attempts.resolved_prompt");
    expect(bounded.content.startsWith("x".repeat(1000))).toBe(true);
  });

  // The bound is in BYTES, and a truncation that splits a multi-byte character
  // would store invalid UTF-8 in a text column.
  it("UT-EDGE-TRC-05: never splits a multi-byte character", async () => {
    const bounded = boundPromptBody("😀".repeat(PROMPT_BODY_MAX_BYTES));

    expect(bounded.truncated).toBe(true);
    expect(Buffer.byteLength(bounded.content, "utf8")).toBeLessThanOrEqual(
      PROMPT_BODY_MAX_BYTES,
    );
    expect(bounded.content).not.toContain("�");
  });
});

describe("appendContextMountLine", () => {
  const mounts: ContextMountSnapshot[] = [
    {
      projectId: "p1",
      slug: "sibling-api",
      repoPath: "/repos/sibling-api",
      mountPath: "context/sibling-api",
      committish: "abc123",
      ref: "main",
    },
  ];

  // UT-EDGE-TRC-07. D9: the host rewrites the prompt once more after this text
  // is recorded, prepending `renderContextMountPreamble`. Reproducing that
  // block web-side would duplicate host logic across two packages with no
  // shared lib. So the row NAMES what was mounted and never fabricates the
  // preamble's wording.
  it("UT-EDGE-TRC-07: appends exactly one line naming the mounted slugs", async () => {
    const body = "implement the widget";
    const withMounts = appendContextMountLine(body, mounts);
    const added = withMounts.slice(body.length).trim().split("\n");

    expect(added).toHaveLength(1);
    expect(added[0]).toContain("sibling-api");
  });

  it("UT-EDGE-TRC-07: leaves the body byte-exact when the run mounts nothing", async () => {
    const body = "implement the widget";

    expect(appendContextMountLine(body, [])).toBe(body);
    expect(appendContextMountLine(body, null)).toBe(body);
    expect(appendContextMountLine(body, undefined)).toBe(body);
  });
});

describe("recordDispatchedPrompt", () => {
  // UT-TRC-08. This is audit data attached to a paid agent turn. A failed
  // write must cost the run nothing — the alternative is a transcript-row
  // problem taking down the dispatch it was only meant to describe.
  it("UT-TRC-08: warns and resolves when the write fails, never rejecting", async () => {
    const db = {
      transaction: vi.fn(async () => {
        throw new Error("connection terminated");
      }),
    };

    await expect(
      recordDispatchedPrompt({
        db,
        runId: "run-1",
        nodeAttemptId: "attempt-1",
        stepId: "implement",
        owner: NODE,
        prompt: "implement the widget",
        contextMounts: null,
      }),
    ).resolves.toBeUndefined();

    expect(db.transaction).toHaveBeenCalled();
  });
});
