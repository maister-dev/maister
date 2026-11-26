const DENY_PATTERNS: readonly RegExp[] = [
  /TOKEN/i,
  /KEY/i,
  /SECRET/i,
  /PASSWORD/i,
  /AUTH/i,
  /^ANTHROPIC_/i,
  /^OPENAI_/i,
  /^DB_URL$/i,
  /^MAISTER_SUPERVISOR_URL$/i,
  /CREDENTIAL/i,
  /PRIVATE/i,
];

// ADR-153: the child and the template view share this default safe scope.
export const DEFAULT_ALLOW_PATTERNS: readonly RegExp[] = [
  /^LANG$/,
  /^LC_/,
  /^TZ$/,
  /^PATH$/,
  /^HOME$/,
  /^USER$/,
  /^SHELL$/,
  /^TERM$/,
];

export function flowTemplateEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  extra: readonly RegExp[] = [],
): Record<string, string> {
  const allowed = [...DEFAULT_ALLOW_PATTERNS, ...extra];

  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !DENY_PATTERNS.some((pattern) => pattern.test(entry[0])) &&
        allowed.some((pattern) => pattern.test(entry[0])),
    ),
  );
}
