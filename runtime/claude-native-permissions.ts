export const CLAUDE_NATIVE_MODES = ["default", "plan", "bypassPermissions"] as const;

export type ClaudeNativePermissions = Readonly<{
  allow?: string[];
  defaultMode?: (typeof CLAUDE_NATIVE_MODES)[number];
}>;
