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
] as const;

// M34 (ADR-089): the fixed scope set issued to per-launch ephemeral agent
// tokens — task/comment/triage/relations ops only.
export const AGENT_TOKEN_SCOPES = [
  "tasks:read",
  // M-triager (ADR-112 §6.2): clarify mode sharpens the task title/prompt via
  // `task_update` before recording the verdict.
  "tasks:update",
  "tasks:triage",
  "comments:read",
  "comments:create",
  "relations:read",
  "relations:create",
  "relations:delete",
  // M-triager (ADR-112): the triager's ephemeral token reads the launchable
  // flow + enabled-runner catalogs before stamping a verdict.
  "flows:read",
  "runners:read",
] as const satisfies readonly (typeof TOKEN_SCOPES)[number][];

export const TOKEN_SCOPE_VALUES = [TOKEN_SCOPE_ALL, ...TOKEN_SCOPES] as const;

export type TokenScope = (typeof TOKEN_SCOPE_VALUES)[number];

const KNOWN_SCOPES: ReadonlySet<string> = new Set(TOKEN_SCOPE_VALUES);

export function isTokenScope(value: string): value is TokenScope {
  return KNOWN_SCOPES.has(value);
}
