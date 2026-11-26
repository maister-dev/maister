import type { NewSessionRequest } from "@agentclientprotocol/sdk/unstable";
import type { ClaudeNativePermissions } from "../../runtime/claude-native-permissions";

import { fileURLToPath } from "node:url";

/** Only explicit model pins override Claude's native environment/settings defaults. */
export function claudeModelOptions(model: string | undefined): {
  readonly model?: string;
} {
  const value = model?.trim();

  return value && value !== "default" ? { model: value } : {};
}

/** Native safe-tool shortcuts must still reach the platform permission seam. */
export function claudeToolArbitrationOptions(): {
  readonly allowDangerouslySkipPermissions: false;
  readonly settings: { readonly permissions: { readonly ask: string[] } };
} {
  return {
    allowDangerouslySkipPermissions: false,
    settings: { permissions: { ask: ["*"] } },
  };
}
export function claudeToolArbitrationMeta(): NewSessionRequest["_meta"] {
  return { claudeCode: { options: claudeToolArbitrationOptions() } };
}

function shellArgument(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Resolve addressed settings from typed permissions and the existing guardrail lane. */
export function addressedClaudeSettings(
  input: Readonly<{
    permissions?: ClaudeNativePermissions;
    allowedPaths?: readonly string[];
    mustArbitrate: boolean;
  }>,
) {
  const { permissions, allowedPaths, mustArbitrate } = input;
  const mode = permissions?.defaultMode;
  const effectiveMode =
    mustArbitrate && mode === "bypassPermissions" ? "default" : mode;
  const pathGuard = fileURLToPath(
    new URL("../../runtime/native-path-guard.mjs", import.meta.url),
  );
  const command = allowedPaths?.length
    ? [process.execPath, pathGuard, ...allowedPaths]
        .map(shellArgument)
        .join(" ")
    : undefined;

  return {
    mode: effectiveMode,
    settings:
      command || permissions || mustArbitrate
        ? {
            permissions: {
              ...(permissions?.allow ? { allow: permissions.allow } : {}),
              ...(mustArbitrate ? { ask: ["*"] } : {}),
            },
            ...(command
              ? {
                  hooks: {
                    PreToolUse: [
                      {
                        matcher: "Edit|Write|MultiEdit|NotebookEdit",
                        hooks: [{ type: "command", command }],
                      },
                    ],
                  },
                }
              : {}),
          }
        : undefined,
  };
}
