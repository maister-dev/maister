import "server-only";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { maxAgentChainDepth } from "@/lib/instance-config";
import { CROSS_PROJECT_AGENT_SCOPES } from "@/types/token-scopes";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { agentProjectLinks, runs } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "agent-cross-project-reach",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ReachDenyReason =
  | "no_link"
  | "link_disabled"
  | "reach_off"
  | "scope_not_in_subset"
  | "chain_depth_exhausted";

export type ReachDecision =
  | { allowed: true; reason: "ok" }
  | { allowed: false; reason: ReachDenyReason };

function inSubset(scopeLabel: string): boolean {
  return (CROSS_PROJECT_AGENT_SCOPES as readonly string[]).includes(scopeLabel);
}

// ADR-156 D6/D7: may an agent token minted in ANOTHER project act in
// `targetProjectId` for `scopeLabel`? Checked in order — scope subset, then an
// enabled reach-granted attachment in the TARGET, then the chain-depth budget.
//
// Every deny is existence-hidden at the caller (404, never 403): a
// distinguishable refusal would let an agent enumerate projects platform-wide.
export async function canAgentReachProject(input: {
  agentId: string;
  targetProjectId: string;
  scopeLabel: string;
  callingRunId: string | null;
  db?: Db;
}): Promise<ReachDecision> {
  const _db = (input.db ?? getDb()) as unknown as { select: any };

  const decide = (decision: ReachDecision): ReachDecision => {
    const payload = {
      agentId: input.agentId,
      targetProjectId: input.targetProjectId,
      scopeLabel: input.scopeLabel,
      callingRunId: input.callingRunId,
      reason: decision.reason,
    };

    if (decision.allowed) log.debug(payload, "cross-project reach allowed");
    else log.warn(payload, "cross-project reach denied");

    return decision;
  };

  if (!inSubset(input.scopeLabel)) {
    return decide({ allowed: false, reason: "scope_not_in_subset" });
  }

  const links = (await _db
    .select({
      enabled: agentProjectLinks.enabled,
      crossProjectReach: agentProjectLinks.crossProjectReach,
    })
    .from(agentProjectLinks)
    .where(
      and(
        eq(agentProjectLinks.agentId, input.agentId),
        eq(agentProjectLinks.projectId, input.targetProjectId),
      ),
    )) as Array<{ enabled: boolean; crossProjectReach: boolean }>;
  const link = links[0];

  if (!link) return decide({ allowed: false, reason: "no_link" });
  if (!link.enabled) return decide({ allowed: false, reason: "link_disabled" });
  if (!link.crossProjectReach) {
    return decide({ allowed: false, reason: "reach_off" });
  }

  // A reach that cannot be attributed to a run has no depth to spend against,
  // so it is treated as exhausted — fail closed, never seed 0.
  if (input.callingRunId === null) {
    return decide({ allowed: false, reason: "chain_depth_exhausted" });
  }

  const rows = (await _db
    .select({ depth: runs.agentChainDepth })
    .from(runs)
    .where(eq(runs.id, input.callingRunId))) as Array<{ depth: number }>;
  const depth = rows[0]?.depth;

  if (depth === undefined || depth >= maxAgentChainDepth()) {
    return decide({ allowed: false, reason: "chain_depth_exhausted" });
  }

  return decide({ allowed: true, reason: "ok" });
}
