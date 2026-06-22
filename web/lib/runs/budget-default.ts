import "server-only";

import {
  expandExecutionPolicy,
  type ExecutionPolicy,
} from "@/lib/runs/execution-policy";

// Launch-time auto-fill for unattended runs (spec §6.1 / E12). When an
// `unattended` run is launched with NO budget set at any scope AND the operator
// configured a default token ceiling, seed BOTH `run.maxTokens` and
// `tree.maxTokens` from the env var so a hands-off run is never unbounded by
// accident. The run seed is load-bearing: a standalone run has root_run_id=NULL,
// so the watchdog's tree scope (gated on rootRunId===id) never evaluates for it —
// run scope is the only one always evaluated for a Running candidate. The tree
// seed still bounds an orchestrator swarm's TOTAL spend (summed at the root).
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
