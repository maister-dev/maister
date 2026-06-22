import type { GateResult, NodeAttempt } from "@/lib/db/schema";

import { describe, expect, it } from "vitest";

import { buildRunContext } from "@/lib/flows/graph/run-context";

// reduceLedger reads nodeId/attempt/stdout/vars/exitCode; the rest of the row is
// irrelevant to the projection, so build minimal rows.
function na(
  nodeId: string,
  attempt: number,
  stdout: string,
  vars: Record<string, unknown>,
): NodeAttempt {
  return {
    nodeId,
    attempt,
    stdout,
    vars,
    exitCode: 0,
  } as unknown as NodeAttempt;
}

function gr(gateId: string, status: string, verdict: unknown): GateResult {
  return { gateId, status, verdict } as unknown as GateResult;
}

describe("buildRunContext (P7, ADR-103)", () => {
  it("projects {intent, nodes(summary+vars), gates(status+verdict?), promoted}", () => {
    const ctx = buildRunContext({
      taskPrompt: "fix the bug",
      nodeAttempts: [
        na("plan", 1, "planned it", { approach: "tdd" }),
        na("impl", 1, "implemented", { files: 3 }),
      ],
      gateResults: [
        gr("q", "passed", { verdict: "pass", confidence: 0.9 }),
        gr("cmd", "passed", null),
      ],
    });

    expect(ctx.intent).toBe("fix the bug");
    expect(ctx.nodes).toEqual({
      plan: { summary: "planned it", vars: { approach: "tdd" } },
      impl: { summary: "implemented", vars: { files: 3 } },
    });
    expect(ctx.gates.q).toEqual({
      status: "passed",
      verdict: { verdict: "pass", confidence: 0.9 },
    });
    // command_check-style gate (null verdict) → status only, no `verdict` key.
    expect(ctx.gates.cmd).toEqual({ status: "passed" });
    expect("verdict" in ctx.gates.cmd).toBe(false);
  });

  it("uses the highest attempt per node", () => {
    const ctx = buildRunContext({
      taskPrompt: "x",
      nodeAttempts: [
        na("impl", 1, "first", { v: 1 }),
        na("impl", 2, "second", { v: 2 }),
      ],
      gateResults: [],
    });

    expect(ctx.nodes.impl).toEqual({ summary: "second", vars: { v: 2 } });
    expect(ctx.promoted.v).toBe(2);
  });

  it("promoted is a flat union, last-wins by node-iteration order", () => {
    const ctx = buildRunContext({
      taskPrompt: "x",
      nodeAttempts: [
        na("a", 1, "", { shared: "from-a", onlyA: 1 }),
        na("b", 1, "", { shared: "from-b", onlyB: 2 }),
      ],
      gateResults: [],
    });

    expect(ctx.promoted).toEqual({ shared: "from-b", onlyA: 1, onlyB: 2 });
  });

  it("the latest gate result per gateId wins (createdAt-asc input)", () => {
    const ctx = buildRunContext({
      taskPrompt: "x",
      nodeAttempts: [],
      gateResults: [
        gr("q", "failed", { verdict: "fail" }),
        gr("q", "passed", { verdict: "pass" }),
      ],
    });

    expect(ctx.gates.q).toEqual({
      status: "passed",
      verdict: { verdict: "pass" },
    });
  });

  it("is idempotent — same ledger yields byte-identical JSON", () => {
    const args = {
      taskPrompt: "x",
      nodeAttempts: [
        na("a", 1, "", { shared: "from-a" }),
        na("b", 1, "", { shared: "from-b" }),
      ],
      gateResults: [gr("q", "passed", { verdict: "pass" })],
    };

    expect(JSON.stringify(buildRunContext(args))).toBe(
      JSON.stringify(buildRunContext(args)),
    );
  });

  it("projects ONLY ledger + gate + prompt data — no side channel adds a key (secret-safety)", () => {
    // buildRunContext reads taskPrompt + node vars + gate verdicts and nothing
    // else (never context.env), so the output is closed over its inputs: exactly
    // these four top-level sections carrying only the vars the caller passed. A
    // regression that pulled in another source would add a key or a value here.
    const ctx = buildRunContext({
      taskPrompt: "x",
      nodeAttempts: [na("a", 1, "out", { safe: "ok" })],
      gateResults: [],
    });

    expect(Object.keys(ctx).sort()).toEqual([
      "gates",
      "intent",
      "nodes",
      "promoted",
    ]);
    expect(ctx.nodes.a.vars).toEqual({ safe: "ok" });
    expect(ctx.promoted).toEqual({ safe: "ok" });
  });
});
