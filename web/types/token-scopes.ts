export const TOKEN_SCOPE_ALL = "*";

export const TOKEN_SCOPES = [
  "tasks:create",
  "tasks:read",
  "tasks:update",
  "runs:launch",
  "runs:read",
  "readiness:read",
  "gates:report",
  "hitl:read",
  "hitl:respond",
] as const;

export const TOKEN_SCOPE_VALUES = [TOKEN_SCOPE_ALL, ...TOKEN_SCOPES] as const;

export type TokenScope = (typeof TOKEN_SCOPE_VALUES)[number];

const KNOWN_SCOPES: ReadonlySet<string> = new Set(TOKEN_SCOPE_VALUES);

export function isTokenScope(value: string): value is TokenScope {
  return KNOWN_SCOPES.has(value);
}
