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
  // ADR-152 (agent memory): the agent's OWN per-attachment memory.md. A SEPARATE
  // store from Project Brain — reusing `memory:write` would make one grant open
  // two stores, re-coupling exactly the axes ADR-152 separates. Access is
  // additionally gated by agent_project_links.memory_enabled; neither the scope
  // nor the flag alone authorizes a write.
  "agent_memory:write",
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
  // ADR-156 D6b: agents may create tasks. This is a SAME-PROJECT privilege
  // expansion as much as a cross-project one — every agent in every project
  // gains it the moment this grant lands, which is what forced the
  // `runs.agent_chain_depth` cap to cover same-project A↔B loops too. The other
  // two legs of the agent-gains-an-op triple already exist: the route
  // `POST /api/v1/ext/projects/[slug]/tasks` declares `scopeLabel:
  // "tasks:create"` and `PROJECT_ACTION_BY_SCOPE` maps it to `createTask`.
  // A task created with no flowId is a flowless simple-intent task —
  // `unconfigured` until triage fills the flow (the existing ADR-112 path).
  "tasks:create",
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
  // ADR-152: in the fixed agent-token set; the per-link memory_enabled axis
  // still gates the actual write.
  "agent_memory:write",
] as const satisfies readonly (typeof TOKEN_SCOPES)[number][];

// ADR-156 D6: the write-safe subset an agent token minted in ANOTHER project
// may exercise here, intersected with the token's own scopes at check time.
// This is an ALLOW-LIST, never a deny-list: a scope added to AGENT_TOKEN_SCOPES
// later is refused cross-project by default and must be added here on purpose.
//
// Deliberately excluded, and why:
//   runs:*             — never in AGENT_TOKEN_SCOPES anyway; an outside agent
//                        must not spend another project's execution budget.
//   tasks:update       — mutating a sibling's EXISTING task content from
//   tasks:triage         outside; creating a new task is additive, editing is
//                        not.
//   hitl:request       — would create human-input demand in a project whose
//                        humans never opted into this agent.
//   flows:read         — catalog disclosure about a project the agent is not
//   runners:read         attached to for execution.
//   memory:read        — project-scoped knowledge stores, each gated by its own
//   memory:write         per-link axis (can_read_brain / can_write_brain /
//   agent_memory:write   memory_enabled) that reach does not imply.
export const CROSS_PROJECT_AGENT_SCOPES = [
  "tasks:read",
  "tasks:create",
  "comments:read",
  "comments:create",
  "relations:read",
  "relations:create",
  "relations:delete",
] as const satisfies readonly (typeof TOKEN_SCOPES)[number][];

export const TOKEN_SCOPE_VALUES = [TOKEN_SCOPE_ALL, ...TOKEN_SCOPES] as const;

export type TokenScope = (typeof TOKEN_SCOPE_VALUES)[number];

const KNOWN_SCOPES: ReadonlySet<string> = new Set(TOKEN_SCOPE_VALUES);

export function isTokenScope(value: string): value is TokenScope {
  return KNOWN_SCOPES.has(value);
}
