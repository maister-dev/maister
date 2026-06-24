import { z } from "zod";

import { decideSchema, gateSchema, nodeSchema } from "@/lib/config.schema";
import { parseWhen } from "@/lib/flows/graph/when-grammar";

export const NODE_TYPES = [
  "ai_coding",
  "cli",
  "check",
  "judge",
  "consensus",
  "human",
  "orchestrator",
  "form",
] as const;

export const GATE_KINDS = [
  "command_check",
  "skill_check",
  "ai_judgment",
  "artifact_required",
  "external_check",
  "human_review",
] as const;

export type NodeFormError = { path: string; message: string };

export type NodeFormResult =
  | { ok: true }
  | { ok: false; errors: NodeFormError[] };

function zodIssuesToErrors(issues: z.ZodIssue[]): NodeFormError[] {
  return issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

export function validateNodeDraft(node: unknown): NodeFormResult {
  const result = nodeSchema.safeParse(node);

  if (result.success) {
    return { ok: true };
  }

  return { ok: false, errors: zodIssuesToErrors(result.error.issues) };
}

// The gateSchema already contains the superRefine that rejects:
// - `external` block on non-external_check kinds
// - `calibration` block on non-ai_judgment/skill_check kinds
// We add one additional rule: human_review must NOT have mode: blocking.
const gateSchemaWithHumanReviewRule = gateSchema.superRefine((gate, ctx) => {
  if (gate.kind === "human_review" && gate.mode === "blocking") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["mode"],
      message: "human_review gate must not be mode: blocking",
    });
  }
});

export function validateGateDraft(gate: unknown): NodeFormResult {
  const result = gateSchemaWithHumanReviewRule.safeParse(gate);

  if (result.success) {
    return { ok: true };
  }

  return { ok: false, errors: zodIssuesToErrors(result.error.issues) };
}

// The decideSchema already enforces (M38, ADR-103): a well-formed `from`
// ("verdict" or "output.<dot.path>"), no `cases` for `from: output`, and
// exactly one `default` case for `from: verdict`. We add the one rule the
// schema defers to compile-time (T1.4): each `when` predicate must parse via the
// shared `parseWhen` grammar. The cross-node rules (case target ∈ transitions,
// on_mismatch ∈ rework.allowedTargets) need the surrounding node and live in
// `verifyDecideAndOnMismatch` (compile.ts) — not in this isolated draft check.
const decideSchemaWithWhenRule = decideSchema.superRefine((decide, ctx) => {
  if (decide.from !== "verdict") return;

  (decide.cases ?? []).forEach((c, index) => {
    if (!("when" in c)) return;
    const parsed = parseWhen(c.when);

    if (!parsed.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cases", index, "when"],
        message: parsed.error,
      });
    }
  });
});

export function validateDecideDraft(decide: unknown): NodeFormResult {
  const result = decideSchemaWithWhenRule.safeParse(decide);

  if (result.success) {
    return { ok: true };
  }

  return { ok: false, errors: zodIssuesToErrors(result.error.issues) };
}

export function blankNode(
  type: (typeof NODE_TYPES)[number],
  id: string,
): unknown {
  switch (type) {
    case "ai_coding":
      return { id, type: "ai_coding", action: { prompt: "TODO" } };
    case "cli":
      return { id, type: "cli", action: { command: "echo ok" } };
    case "check":
      return { id, type: "check", action: { command: "echo ok" } };
    case "judge":
      return { id, type: "judge", action: { prompt: "TODO" } };
    case "consensus":
      return {
        id,
        type: "consensus",
        prompt: "TODO",
        participants: [
          { id: "participant_a", runner: "codex" },
          { id: "participant_b", runner: "claude" },
        ],
        material_axes: ["correctness"],
        synthesizer: { runner: "codex" },
        output: {
          produces: [
            { id: "consensus_plan", kind: "plan", current: true },
            { id: "debate_log", kind: "human_note", current: true },
          ],
        },
      };
    case "human":
      return { id, type: "human" };
    // action.prompt is z.string().min(1) — seed a non-empty placeholder so the
    // fresh node is schema-valid (mirrors ai_coding/judge).
    case "orchestrator":
      return { id, type: "orchestrator", action: { prompt: "TODO" } };
    // form_schema is the one REQUIRED form-node setting — seed it so the blank
    // validates (a form node with no schema is the empty-prompt analogue).
    case "form":
      return { id, type: "form", settings: { form_schema: "TODO" } };
  }
}

export function blankGate(
  kind: (typeof GATE_KINDS)[number],
  id: string,
): unknown {
  switch (kind) {
    case "command_check":
      return { id, kind: "command_check" };
    case "skill_check":
      return { id, kind: "skill_check" };
    case "ai_judgment":
      return { id, kind: "ai_judgment" };
    case "artifact_required":
      return { id, kind: "artifact_required" };
    case "external_check":
      return { id, kind: "external_check" };
    case "human_review":
      // human_review must NOT be mode: blocking; advisory is the safe default.
      return { id, kind: "human_review", mode: "advisory" };
  }
}

// M38 (ADR-103): a blank `decide` table for the chosen source. `output` seeds a
// placeholder dot-path the author edits; `verdict` seeds a single `default` case
// (the minimum a verdict table needs to be schema-valid).
export function blankDecide(source: "output" | "verdict"): unknown {
  if (source === "verdict") {
    return { from: "verdict", cases: [{ default: true, target: "done" }] };
  }

  return { from: "output.outcome" };
}
