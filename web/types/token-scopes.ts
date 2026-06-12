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
  "comments:read",
  "comments:create",
  "relations:read",
  "relations:create",
  "relations:delete",
  "agents:trigger",
] as const;

// M34 (ADR-089): the fixed scope set issued to per-launch ephemeral agent
// tokens — task/comment/triage/relations ops only.
export const AGENT_TOKEN_SCOPES = [
  "tasks:read",
  "tasks:triage",
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
