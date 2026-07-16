export const TOKEN_SCOPE_ALL = "*";

export const TOKEN_SCOPES = [
  "tasks:create",
  "tasks:read",
  "tasks:update",
  "tasks:triage",
  "runs:launch",
  "runs:read",
  "readiness:read",
  "gates:report",
  "hitl:read",
  "hitl:request",
  "hitl:respond",
  "hitl:inbox:read",
  "hitl:respond:human",
  "comments:read",
  "comments:create",
  "relations:read",
  "relations:create",
  "relations:delete",
  // M-triager (ADR-112): read-only discovery of the project's launchable flows
  // and the enabled platform ACP runners a triage verdict may assign.
  "flows:read",
  "runners:read",
  "agents:trigger",
  "runs:delegate",
  "runs:collect",
  "runs:cancel",
  // M37 (ADR-100): the orchestrator's promote-a-reviewed-child privilege.
  "runs:promote",
  // ADR-141: branch sync + reopen (promote-class ops). Maps to the `promoteRun`
  // project action, NOT the `readBoard` fallback (see PROJECT_ACTION_BY_SCOPE).
  "runs:sync",
  // ADR-122 (Project Brain): recall / retain over the project-memory substrate.
  // Access is additionally gated by projects.brain_enabled and, for agent
  // tokens, the can_read_brain / can_write_brain link axes.
  "memory:read",
  "memory:write",
  // ADR-124: Experiment Comparison Studio. Read is detail/comparison access;
  // advise appends judge advisories only, never a human conclusion.
  "experiments:read",
  "experiments:advise",
  // ADR-145 (Evaluation Lab) D10/D12: attempt-bound evaluator judge scopes. These
  // are minted ONLY on a judge attempt's ephemeral agent token
  // (EVALUATION_JUDGE_TOKEN_SCOPES in lib/agents/tokens.ts) — deliberately NOT in
  // AGENT_TOKEN_SCOPES. A judge reads ONLY its token-bound evidence snapshot and
  // submits exactly one result; it can browse nothing and mutate no task/comment/
  // relation. The token binds the execution/attempt, so no tool accepts a study /
  // run / snapshot / item-owning id from the client.
  "evaluations:context:read",
  "evaluations:evidence:read",
  "evaluations:objective:read",
  "evaluations:result:submit",
] as const;

// M34 (ADR-089): the fixed scope set issued to per-launch ephemeral agent
// tokens — task/comment/triage/relations ops only.
export const AGENT_TOKEN_SCOPES = [
  "tasks:read",
  // M-triager (ADR-112 §6.2): clarify mode sharpens the task title/prompt via
  // `task_update` before recording the verdict.
  "tasks:update",
  "tasks:triage",
  "hitl:request",
  "comments:read",
  "comments:create",
  "relations:read",
  "relations:create",
  "relations:delete",
  // M-triager (ADR-112): the triager's ephemeral token reads the launchable
  // flow + enabled-runner catalogs before stamping a verdict.
  "flows:read",
  "runners:read",
  // ADR-122: memory scopes are in the fixed agent-token set; actual access is
  // still gated by can_read_brain / can_write_brain on the agent-project link.
  "memory:read",
  "memory:write",
  // ADR-124: experiment-judge agent reads the comparison DTO and appends an
  // advisory result. Human verdicts remain session-auth only.
  "experiments:read",
  "experiments:advise",
] as const satisfies readonly (typeof TOKEN_SCOPES)[number][];

export const TOKEN_SCOPE_VALUES = [TOKEN_SCOPE_ALL, ...TOKEN_SCOPES] as const;

export type TokenScope = (typeof TOKEN_SCOPE_VALUES)[number];

const KNOWN_SCOPES: ReadonlySet<string> = new Set(TOKEN_SCOPE_VALUES);

export function isTokenScope(value: string): value is TokenScope {
  return KNOWN_SCOPES.has(value);
}
