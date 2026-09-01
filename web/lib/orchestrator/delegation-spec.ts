import type { TaskDelegationSpec } from "@/lib/db/schema";
import type { DelegationTargetKind } from "@/lib/orchestrator/delegation-target";

// ADR-163: `tasks.delegation_spec` is a discriminated union whose agent arm has
// an OPTIONAL discriminant, because every row written before flow targets
// existed carries no `kind`. Reading the kind is therefore a one-line rule that
// must live in exactly one place — an inline `!spec.agentId` test would
// classify a perfectly valid flow spec as a malformed agent spec, and the
// as-plan auto-launcher would skip it forever without an error.

export type { TaskDelegationSpec };

export type AgentDelegationSpec = Extract<
  TaskDelegationSpec,
  { agentId: string }
>;
export type FlowDelegationSpec = Extract<TaskDelegationSpec, { kind: "flow" }>;

/**
 * The kind of an as-plan delegation spec, or `null` when the task carries none.
 * Absent `kind` on a present spec means "agent" (the pre-ADR-163 shape).
 */
export function delegationSpecKind(
  spec: TaskDelegationSpec | null | undefined,
): DelegationTargetKind | null {
  if (!spec) return null;

  return spec.kind === "flow" ? "flow" : "agent";
}

/**
 * Narrow to the agent arm, or `null` for any other shape (including an agent
 * spec whose `agentId` is missing or empty — a malformed row a caller must skip
 * rather than launch).
 */
export function asAgentDelegationSpec(
  spec: TaskDelegationSpec | null | undefined,
): AgentDelegationSpec | null {
  if (delegationSpecKind(spec) !== "agent") return null;

  const agentSpec = spec as AgentDelegationSpec;

  return typeof agentSpec.agentId === "string" && agentSpec.agentId.length > 0
    ? agentSpec
    : null;
}

/** Narrow to the flow arm, or `null` for any other (or malformed) shape. */
export function asFlowDelegationSpec(
  spec: TaskDelegationSpec | null | undefined,
): FlowDelegationSpec | null {
  if (delegationSpecKind(spec) !== "flow") return null;

  const flowSpec = spec as FlowDelegationSpec;

  return typeof flowSpec.flowId === "string" && flowSpec.flowId.length > 0
    ? flowSpec
    : null;
}
