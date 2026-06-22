import { describe, expect, it } from "vitest";

import {
  NODE_TYPES,
  GATE_KINDS,
  validateNodeDraft,
  validateGateDraft,
  validateDecideDraft,
  blankNode,
  blankGate,
  blankDecide,
} from "@/lib/flows/editor/node-form";

// ─── blankNode round-trips ────────────────────────────────────────────────────

describe("blankNode + validateNodeDraft", () => {
  it("ai_coding: blank is valid", () => {
    const result = validateNodeDraft(blankNode("ai_coding", "n1"));

    expect(result).toEqual({ ok: true });
  });

  it("cli: blank is valid", () => {
    const result = validateNodeDraft(blankNode("cli", "n2"));

    expect(result).toEqual({ ok: true });
  });

  it("check: blank is valid", () => {
    const result = validateNodeDraft(blankNode("check", "n3"));

    expect(result).toEqual({ ok: true });
  });

  it("judge: blank is valid", () => {
    const result = validateNodeDraft(blankNode("judge", "n4"));

    expect(result).toEqual({ ok: true });
  });

  it("human: blank is valid", () => {
    const result = validateNodeDraft(blankNode("human", "n5"));

    expect(result).toEqual({ ok: true });
  });

  it("all NODE_TYPES produce valid blanks", () => {
    for (const type of NODE_TYPES) {
      const result = validateNodeDraft(blankNode(type, `id-${type}`));

      expect(result, `type: ${type}`).toEqual({ ok: true });
    }
  });
});

// ─── validateNodeDraft invalid cases ─────────────────────────────────────────

describe("validateNodeDraft — invalid nodes", () => {
  it("unknown type → error on type field", () => {
    const result = validateNodeDraft({ id: "n1", type: "unknown_type" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("ai_coding missing action.prompt → error", () => {
    const result = validateNodeDraft({
      id: "n1",
      type: "ai_coding",
      action: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path);

      expect(paths.some((p) => p.includes("prompt"))).toBe(true);
    }
  });

  it("ai_coding empty action.prompt → error", () => {
    const result = validateNodeDraft({
      id: "n1",
      type: "ai_coding",
      action: { prompt: "" },
    });

    expect(result.ok).toBe(false);
  });

  it("cli missing action.command → error", () => {
    const result = validateNodeDraft({
      id: "n1",
      type: "cli",
      action: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path);

      expect(paths.some((p) => p.includes("command"))).toBe(true);
    }
  });

  it("check missing action.command → error", () => {
    const result = validateNodeDraft({
      id: "n1",
      type: "check",
      action: {},
    });

    expect(result.ok).toBe(false);
  });

  it("judge missing action.prompt → error", () => {
    const result = validateNodeDraft({
      id: "n1",
      type: "judge",
      action: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path);

      expect(paths.some((p) => p.includes("prompt"))).toBe(true);
    }
  });

  it("ai_coding out-of-enum settings.thinkingEffort → error", () => {
    const result = validateNodeDraft({
      id: "n1",
      type: "ai_coding",
      action: { prompt: "do something" },
      settings: { thinkingEffort: "ultra" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path);

      expect(paths.some((p) => p.includes("thinkingEffort"))).toBe(true);
    }
  });

  it("judge out-of-enum settings.thinkingEffort → error", () => {
    const result = validateNodeDraft({
      id: "n1",
      type: "judge",
      action: { prompt: "evaluate" },
      settings: { thinkingEffort: "max" },
    });

    expect(result.ok).toBe(false);
  });

  it("missing id → error", () => {
    const result = validateNodeDraft({
      type: "human",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path);

      expect(paths.some((p) => p === "id" || p.includes("id"))).toBe(true);
    }
  });

  it("non-object input → error", () => {
    const result = validateNodeDraft(null);

    expect(result.ok).toBe(false);
  });

  it("ai_coding unknown settings key → error (strict)", () => {
    const result = validateNodeDraft({
      id: "n1",
      type: "ai_coding",
      action: { prompt: "x" },
      settings: { unknownKey: "bad" },
    });

    expect(result.ok).toBe(false);
  });
});

// ─── rework + output.result shapes ───────────────────────────────────────────

describe("validateNodeDraft — rework and output.result", () => {
  it("ai_coding with valid rework → ok", () => {
    const result = validateNodeDraft({
      id: "n1",
      type: "ai_coding",
      action: { prompt: "x" },
      rework: {
        allowedTargets: ["n0"],
        workspacePolicies: ["keep"],
        maxLoops: 3,
      },
    });

    expect(result).toEqual({ ok: true });
  });

  it("rework with empty allowedTargets → error", () => {
    const result = validateNodeDraft({
      id: "n1",
      type: "ai_coding",
      action: { prompt: "x" },
      rework: {
        allowedTargets: [],
        workspacePolicies: ["keep"],
        maxLoops: 3,
      },
    });

    expect(result.ok).toBe(false);
  });

  it("rework with maxLoops=0 → error", () => {
    const result = validateNodeDraft({
      id: "n1",
      type: "ai_coding",
      action: { prompt: "x" },
      rework: {
        allowedTargets: ["n0"],
        workspacePolicies: ["keep"],
        maxLoops: 0,
      },
    });

    expect(result.ok).toBe(false);
  });

  it("ai_coding with valid output.result → ok", () => {
    const result = validateNodeDraft({
      id: "n1",
      type: "ai_coding",
      action: { prompt: "x" },
      output: {
        result: { schema: "./schema.json" },
      },
    });

    expect(result).toEqual({ ok: true });
  });

  it("output.result missing schema → error", () => {
    const result = validateNodeDraft({
      id: "n1",
      type: "ai_coding",
      action: { prompt: "x" },
      output: {
        result: {},
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path);

      expect(paths.some((p) => p.includes("schema"))).toBe(true);
    }
  });
});

// ─── blankGate round-trips ────────────────────────────────────────────────────

describe("blankGate + validateGateDraft", () => {
  it("all GATE_KINDS produce valid blanks", () => {
    for (const kind of GATE_KINDS) {
      const result = validateGateDraft(blankGate(kind, `g-${kind}`));

      expect(result, `kind: ${kind}`).toEqual({ ok: true });
    }
  });

  it("command_check: blank is valid", () => {
    expect(validateGateDraft(blankGate("command_check", "g1"))).toEqual({
      ok: true,
    });
  });

  it("skill_check: blank is valid", () => {
    expect(validateGateDraft(blankGate("skill_check", "g2"))).toEqual({
      ok: true,
    });
  });

  it("ai_judgment: blank is valid", () => {
    expect(validateGateDraft(blankGate("ai_judgment", "g3"))).toEqual({
      ok: true,
    });
  });

  it("artifact_required: blank is valid", () => {
    expect(validateGateDraft(blankGate("artifact_required", "g4"))).toEqual({
      ok: true,
    });
  });

  it("external_check: blank is valid", () => {
    expect(validateGateDraft(blankGate("external_check", "g5"))).toEqual({
      ok: true,
    });
  });

  it("human_review: blank is valid", () => {
    expect(validateGateDraft(blankGate("human_review", "g6"))).toEqual({
      ok: true,
    });
  });
});

// ─── validateGateDraft invalid cases ─────────────────────────────────────────

describe("validateGateDraft — invalid gates", () => {
  it("human_review with mode:blocking → invalid", () => {
    const result = validateGateDraft({
      id: "g1",
      kind: "human_review",
      mode: "blocking",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("human_review with mode:advisory → valid", () => {
    const result = validateGateDraft({
      id: "g1",
      kind: "human_review",
      mode: "advisory",
    });

    expect(result).toEqual({ ok: true });
  });

  it("ai_judgment calibration.confidence_min below 0 → invalid", () => {
    const result = validateGateDraft({
      id: "g1",
      kind: "ai_judgment",
      calibration: { confidence_min: -0.1 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path);

      expect(paths.some((p) => p.includes("confidence_min"))).toBe(true);
    }
  });

  it("ai_judgment calibration.confidence_min above 1 → invalid", () => {
    const result = validateGateDraft({
      id: "g1",
      kind: "ai_judgment",
      calibration: { confidence_min: 1.5 },
    });

    expect(result.ok).toBe(false);
  });

  it("ai_judgment calibration.confidence_min exactly 0 → valid", () => {
    const result = validateGateDraft({
      id: "g1",
      kind: "ai_judgment",
      calibration: { confidence_min: 0 },
    });

    expect(result).toEqual({ ok: true });
  });

  it("ai_judgment calibration.confidence_min exactly 1 → valid", () => {
    const result = validateGateDraft({
      id: "g1",
      kind: "ai_judgment",
      calibration: { confidence_min: 1 },
    });

    expect(result).toEqual({ ok: true });
  });

  it("skill_check with calibration → valid", () => {
    const result = validateGateDraft({
      id: "g1",
      kind: "skill_check",
      calibration: { confidence_min: 0.8 },
    });

    expect(result).toEqual({ ok: true });
  });

  it("command_check with calibration → invalid (only ai_judgment/skill_check)", () => {
    const result = validateGateDraft({
      id: "g1",
      kind: "command_check",
      calibration: { confidence_min: 0.8 },
    });

    expect(result.ok).toBe(false);
  });

  it("external_check block on non-external_check kind → invalid", () => {
    const result = validateGateDraft({
      id: "g1",
      kind: "command_check",
      external: { description: "CI" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path);

      expect(paths.some((p) => p.includes("external"))).toBe(true);
    }
  });

  it("external_check block on external_check kind → valid", () => {
    const result = validateGateDraft({
      id: "g1",
      kind: "external_check",
      external: { description: "CI" },
    });

    expect(result).toEqual({ ok: true });
  });

  it("invalid kind → error", () => {
    const result = validateGateDraft({
      id: "g1",
      kind: "totally_invalid",
    });

    expect(result.ok).toBe(false);
  });

  it("missing id → error", () => {
    const result = validateGateDraft({ kind: "command_check" });

    expect(result.ok).toBe(false);
  });

  it("non-object → error", () => {
    const result = validateGateDraft("not-a-gate");

    expect(result.ok).toBe(false);
  });
});

// ─── decide (M38, ADR-103) ───────────────────────────────────────────────────

describe("blankDecide + validateDecideDraft", () => {
  it("blankDecide('output') round-trips as valid", () => {
    expect(validateDecideDraft(blankDecide("output"))).toEqual({ ok: true });
  });

  it("blankDecide('verdict') round-trips as valid", () => {
    expect(validateDecideDraft(blankDecide("verdict"))).toEqual({ ok: true });
  });

  it("from: output.<dotpath> (top-level) → ok", () => {
    expect(validateDecideDraft({ from: "output.outcome" })).toEqual({
      ok: true,
    });
  });

  it("from: output.<dotpath> (nested) → ok", () => {
    expect(validateDecideDraft({ from: "output.triage.outcome" })).toEqual({
      ok: true,
    });
  });

  it("from: verdict with one default + a parseable when → ok", () => {
    const result = validateDecideDraft({
      from: "verdict",
      cases: [
        { when: "confidence >= 0.8", target: "approve" },
        { default: true, target: "review" },
      ],
    });

    expect(result).toEqual({ ok: true });
  });
});

describe("validateDecideDraft — invalid decide", () => {
  it("malformed `from` (not verdict, not output.<path>) → error on from", () => {
    const result = validateDecideDraft({ from: "verd" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path.includes("from"))).toBe(true);
    }
  });

  it("from: output with a `cases` table → error", () => {
    const result = validateDecideDraft({
      from: "output.outcome",
      cases: [{ default: true, target: "x" }],
    });

    expect(result.ok).toBe(false);
  });

  it("from: verdict with two defaults → error", () => {
    const result = validateDecideDraft({
      from: "verdict",
      cases: [
        { default: true, target: "a" },
        { default: true, target: "b" },
      ],
    });

    expect(result.ok).toBe(false);
  });

  it("from: verdict with zero defaults → error", () => {
    const result = validateDecideDraft({
      from: "verdict",
      cases: [{ when: "confidence >= 0.8", target: "approve" }],
    });

    expect(result.ok).toBe(false);
  });

  it("from: verdict with an unparseable when → error", () => {
    const result = validateDecideDraft({
      from: "verdict",
      cases: [
        { when: "confidence is high", target: "approve" },
        { default: true, target: "review" },
      ],
    });

    expect(result.ok).toBe(false);
  });

  it("from: verdict with an empty target → error", () => {
    const result = validateDecideDraft({
      from: "verdict",
      cases: [
        { when: "confidence >= 0.8", target: "" },
        { default: true, target: "review" },
      ],
    });

    expect(result.ok).toBe(false);
  });

  it("unknown top-level key → error (strict)", () => {
    const result = validateDecideDraft({
      from: "output.outcome",
      unknownKey: true,
    });

    expect(result.ok).toBe(false);
  });

  it("non-object input → error", () => {
    expect(validateDecideDraft(null).ok).toBe(false);
  });
});

// ─── error shape ─────────────────────────────────────────────────────────────

describe("NodeFormError shape", () => {
  it("errors have path and message strings", () => {
    const result = validateNodeDraft({ type: "unknown" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const err of result.errors) {
        expect(typeof err.path).toBe("string");
        expect(typeof err.message).toBe("string");
      }
    }
  });
});
