import { z } from "zod";

// ADR-163: the WIRE SHAPE of a delegation target, and nothing else. This module
// owns "is this payload well-formed for the target kind it names?" — it touches
// no database and imports no launcher, so the three concerns stay one per
// module (shape here, trust in lib/flows/delegatable-flow.ts, limits in
// lib/orchestrator/admission.ts).

/**
 * A delegation target is a DISCRIMINATED UNION, not two optional fields plus a
 * procedural fallback: exactly one of `agentId` / `flowId`. Each arm is
 * `.strict()`, so the other kind's key is a schema error rather than a silently
 * dropped field.
 *
 * The union is spelled as a strict object plus a refinement rather than
 * `z.union([...])` so BOTH violations get their own exact message. A bare union
 * reports "no matching variant", which tells the caller nothing about whether
 * it sent too many identifiers or none.
 */
export const delegationTargetSchema = z
  .object({
    agentId: z.string().min(1).optional(),
    flowId: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasAgent = value.agentId !== undefined;
    const hasFlow = value.flowId !== undefined;

    if (hasAgent && hasFlow) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "target must carry exactly one of agentId / flowId (both present)",
      });

      return;
    }
    if (!hasAgent && !hasFlow) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "target must carry exactly one of agentId / flowId (neither present)",
      });
    }
  });

export type DelegationTarget = z.infer<typeof delegationTargetSchema>;

export type DelegationTargetKind = "agent" | "flow";

/**
 * The target's kind. Safe to call only on a target the schema above accepted —
 * which is the only way one enters the system.
 */
export function delegationTargetKind(
  target: DelegationTarget,
): DelegationTargetKind {
  return target.flowId !== undefined ? "flow" : "agent";
}

/**
 * The per-kind option allow-list (ADR-163 D4). Each optional field is supported
 * by one target kind or by both; a field the kind cannot support is REFUSED
 * with its own message, never ignored. The messages are contract — the refusal
 * table in docs/system-analytics/orchestrator.md quotes them, and the caller
 * needs to know WHICH rule it broke.
 */
export type DelegationOptions = {
  mode: "task" | "run";
  title?: string;
  workspace?: string;
  workspaceMode?: string;
  persistent?: boolean;
  addressableKey?: string;
  // ADR-165: the NAME of a `result_profiles` entry the child publishes under.
  resultProfile?: string;
};

const FLOW_FORBIDDEN: {
  key: keyof DelegationOptions;
  message: string;
}[] = [
  {
    key: "workspace",
    message:
      "workspace is not supported for flow targets (a flow run always provisions its own worktree)",
  },
  {
    key: "workspaceMode",
    message:
      "workspaceMode is agent-target only (a flow child cannot join a shared agent tree)",
  },
  {
    key: "persistent",
    message:
      "persistent children are agent-target only (a flow child has no addressable session)",
  },
  {
    key: "addressableKey",
    message:
      "addressableKey is agent-target only (a flow child has no addressable session)",
  },
  {
    // ADR-165 R1: a flow child declares its OWN `result.export` in its manifest;
    // there is no profile for a caller to select on its behalf.
    key: "resultProfile",
    message:
      "resultProfile is agent-target only (a flow child declares its own result.export)",
  },
];

/**
 * Validate the non-target options against the resolved target kind.
 *
 * Returns the refusal message, or `null` when the combination is allowed. The
 * caller maps it onto `MaisterError("CONFIG")` / 422 — this module stays free of
 * the error and HTTP layers so it can be unit-tested as a pure function.
 */
export function refuseUnsupportedDelegationOption(
  kind: DelegationTargetKind,
  options: DelegationOptions,
): string | null {
  if (kind === "flow") {
    for (const rule of FLOW_FORBIDDEN) {
      if (options[rule.key] !== undefined) return rule.message;
    }

    return null;
  }

  // An agent `mode: run` child creates no task, so there is nothing for `title`
  // to name. Refusing beats today's silent drop.
  if (options.mode === "run" && options.title !== undefined) {
    return "title is only meaningful with mode:task (an agent mode:run child has no task to name)";
  }

  // ADR-165 R2: the result is published in the child's TERMINAL transaction, and
  // a persistent child never reaches one — it parks between turns. The
  // combination is unsatisfiable, so it is refused rather than accepted and then
  // silently never producing a result. Stated as an allow-list (resultProfile is
  // valid iff agent AND not persistent), not a deny-list of shapes.
  if (options.persistent && options.resultProfile !== undefined) {
    return "resultProfile is not supported for persistent children (a persistent child never reaches a terminal, and the result is published there)";
  }

  return null;
}

/** The child task's title when the caller supplied none. */
export function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split("\n")[0].trim();

  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}
