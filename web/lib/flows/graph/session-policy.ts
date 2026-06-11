import type { SessionPolicy } from "@/lib/config.schema";

// M30 (ADR-078, DD8): 3-level highest-wins resolution of the rework session
// policy, with the deliberate `resume` engine default — the ~$0.28 idle
// respawn buys back the critique context, which is the point of resuming.
export type SessionPolicySource =
  | "rework-transition"
  | "node"
  | "flow-defaults"
  | "engine-default";

export function resolveSessionPolicy(input: {
  reworkPolicy?: SessionPolicy;
  nodePolicy?: SessionPolicy;
  flowDefault?: SessionPolicy;
}): { policy: SessionPolicy; source: SessionPolicySource } {
  if (input.reworkPolicy) {
    return { policy: input.reworkPolicy, source: "rework-transition" };
  }
  if (input.nodePolicy) {
    return { policy: input.nodePolicy, source: "node" };
  }
  if (input.flowDefault) {
    return { policy: input.flowDefault, source: "flow-defaults" };
  }

  return { policy: "resume", source: "engine-default" };
}
