export const RUN_DIFF_SCOPES = [
  "run",
  "review",
  "since-last-review",
  "last-node",
  "uncommitted",
] as const;

export type RunDiffScope = (typeof RUN_DIFF_SCOPES)[number];

export function isRunDiffScope(value: string): value is RunDiffScope {
  return (RUN_DIFF_SCOPES as readonly string[]).includes(value);
}
