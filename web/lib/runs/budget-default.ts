import "server-only";

import {
  expandExecutionPolicy,
  type ExecutionPolicy,
} from "@/lib/runs/execution-policy";

// Launch-time auto-fill for unattended runs (spec §6.1 / E12). When an
// `unattended` run is launched with NO budget set at any scope AND the operator
// configured a default token ceiling, seed BOTH `run.maxTokens` and
// `tree.maxTokens` from the env var so a hands-off run is never unbounded by
// accident. BOTH seeds are load-bearing: run scope bounds the single run, and
// tree scope bounds an orchestrator swarm's TOTAL spend (summed at the root).
// Seeding the two at the SAME value keeps a standalone run on the ESCALATE rung
// rather than a hard kill: run scope is evaluated first and wins the equal-rung
// tie in `pickHigher`, so the tree rung's force-promotion to terminate — which
// tests the winning verdict's scope — does not apply to it. Only a real swarm,
// whose tree total exceeds the root's own spend, trips tree scope alone.
// Lives in a server module so the env read stays server-side and
// execution-policy.ts stays client-safe. Never throws — a missing / invalid /
// non-positive env value leaves the policy untouched (fail-OPEN, consistent with
// the budget axis as a whole).
export function applyDefaultBudgetForUnattended(
  policy: ExecutionPolicy,
): ExecutionPolicy {
  const r = expandExecutionPolicy(policy);

  if (r.preset !== "unattended") return policy;
  if (r.budget.run || r.budget.task || r.budget.tree) return policy;

  const raw = process.env.MAISTER_DEFAULT_UNATTENDED_BUDGET_TOKENS;

  if (!raw) return policy;

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed <= 0) return policy;

  return {
    ...policy,
    overrides: {
      ...policy.overrides,
      budget: {
        run: { maxTokens: parsed },
        tree: { maxTokens: parsed },
      },
    },
  };
}
