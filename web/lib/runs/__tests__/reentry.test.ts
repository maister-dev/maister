import { describe, expect, it } from "vitest";

import { compileManifest } from "@/lib/flows/graph/compile";
import { resolveReentryNode } from "@/lib/runs/reentry";

import type { FlowYamlV1 } from "@/lib/config.schema";
import type { NodeAttempt } from "@/lib/db/schema";

// T-A6 (AC-A6) — ADR-160 re-entry resolution chain. Ordered, server-state only:
//   1. the compiled flow-level `reentry`;
//   2. else the LAST executed `human` node whose `transitions.takeover` names a
//      node present in the compiled graph;
//   3. else refuse — the caller turns this into a PRECONDITION naming relaunch.
// Step 2 is ledger-derived on purpose: runGraph writes `current_step_id: null`
// on reaching Review, so the cursor cannot be the anchor.

type AttemptSeed = {
  nodeId: string;
  attempt?: number;
  startedAt: Date;
};

function attempts(seeds: AttemptSeed[]): NodeAttempt[] {
  return seeds.map(
    (s, i) =>
      ({
        id: `att-${i}`,
        runId: "run-1",
        nodeId: s.nodeId,
        attempt: s.attempt ?? 1,
        startedAt: s.startedAt,
        endedAt: s.startedAt,
      }) as unknown as NodeAttempt,
  );
}

function graph(opts: { reentry?: string; takeoverTarget?: string }) {
  const manifest = {
    schemaVersion: 1,
    name: "reentry-fixture",
    compat: { engine_min: "3.5.0" },
    ...(opts.reentry ? { reentry: opts.reentry } : {}),
    nodes: [
      {
        id: "implement",
        type: "ai_coding",
        action: { prompt: "do it" },
        transitions: { success: "verify" },
      },
      {
        id: "verify",
        type: "cli",
        action: { command: "true" },
        transitions: { success: "review" },
      },
      {
        id: "review",
        type: "human",
        finish: { human: { decisions: ["approve", "takeover"] } },
        transitions: {
          approve: "done",
          ...(opts.takeoverTarget ? { takeover: opts.takeoverTarget } : {}),
        },
      },
    ],
  } as unknown as FlowYamlV1;

  return compileManifest(manifest);
}

const T0 = new Date("2026-08-31T10:00:00Z");
const T1 = new Date("2026-08-31T10:05:00Z");
const T2 = new Date("2026-08-31T10:10:00Z");

describe("T-A6 ADR-160 — resolveReentryNode chain", () => {
  it("resolves from the flow-level manifest `reentry` when declared", () => {
    const result = resolveReentryNode(
      graph({ reentry: "verify" }),
      attempts([{ nodeId: "implement", startedAt: T0 }]),
    );

    expect(result).toEqual({
      ok: true,
      nodeId: "verify",
      source: "manifest",
    });
  });

  it("falls back to the last executed human node's takeover transition", () => {
    const result = resolveReentryNode(
      graph({ takeoverTarget: "verify" }),
      attempts([
        { nodeId: "implement", startedAt: T0 },
        { nodeId: "verify", startedAt: T1 },
        { nodeId: "review", startedAt: T2 },
      ]),
    );

    expect(result).toEqual({
      ok: true,
      nodeId: "verify",
      source: "takeover_transition",
    });
  });

  // Precedence matters: a flow may declare BOTH. The manifest is the explicit
  // author intent and must win over the inferred ledger route.
  it("prefers the manifest `reentry` over a present takeover transition", () => {
    const result = resolveReentryNode(
      graph({ reentry: "implement", takeoverTarget: "verify" }),
      attempts([
        { nodeId: "implement", startedAt: T0 },
        { nodeId: "review", startedAt: T2 },
      ]),
    );

    expect(result).toEqual({
      ok: true,
      nodeId: "implement",
      source: "manifest",
    });
  });

  it("refuses when neither a manifest reentry nor a takeover transition exists", () => {
    const result = resolveReentryNode(
      graph({}),
      attempts([
        { nodeId: "implement", startedAt: T0 },
        { nodeId: "review", startedAt: T2 },
      ]),
    );

    expect(result).toEqual({ ok: false, reason: "no_reentry_declared" });
  });

  // A stale target must DISABLE the action, not crash the claim route. The
  // compiled graph is the allow-list; an unknown target falls through.
  it("falls through rather than throwing when the takeover target is absent from the graph", () => {
    const g = graph({ takeoverTarget: "verify" });
    // Simulate a target that compiled away (or a hand-edited revision).
    g.nodes.delete("verify");

    const result = resolveReentryNode(
      g,
      attempts([{ nodeId: "review", startedAt: T2 }]),
    );

    expect(result).toEqual({ ok: false, reason: "no_reentry_declared" });
  });

  // "Last executed" is by ledger order, not graph order: an earlier human node
  // must not win over a later one.
  it("uses the LAST executed human node when several ran", () => {
    const manifest = {
      schemaVersion: 1,
      name: "two-humans",
      compat: { engine_min: "3.5.0" },
      nodes: [
        {
          id: "triage",
          type: "human",
          finish: { human: { decisions: ["ok", "takeover"] } },
          transitions: { ok: "review", takeover: "triage" },
        },
        {
          id: "review",
          type: "human",
          finish: { human: { decisions: ["approve", "takeover"] } },
          transitions: { approve: "done", takeover: "review" },
        },
      ],
    } as unknown as FlowYamlV1;

    const result = resolveReentryNode(
      compileManifest(manifest),
      attempts([
        { nodeId: "triage", startedAt: T0 },
        { nodeId: "review", startedAt: T2 },
      ]),
    );

    expect(result).toEqual({
      ok: true,
      nodeId: "review",
      source: "takeover_transition",
    });
  });
});
