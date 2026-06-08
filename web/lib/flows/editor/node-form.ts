import { z } from "zod";

import { gateSchema, nodeSchema } from "@/lib/config.schema";

export const NODE_TYPES = [
  "ai_coding",
  "cli",
  "check",
  "judge",
  "human",
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
    case "human":
      return { id, type: "human" };
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
