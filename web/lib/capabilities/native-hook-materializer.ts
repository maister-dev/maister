import "server-only";

import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type { ClaudeSettingsLocalHooks } from "@/lib/capabilities/agent-map";
import type { HooksConfig } from "@/lib/flows/hooks-config";

import path from "node:path";

// ADR-104 D7 (M40): the per-adapter native-hook materializer seam. The universal
// supervisor ACP-seam interceptor enforces ALL three rules for every adapter;
// the OPTIONAL native backend (a claude `PreToolUse` hook written into the M14
// `.claude/settings.local.json`) is a defense-in-depth optimization covering
// ONLY `path_guard` (rules `repetition` / `no_progress` need cross-turn session
// state and stay supervisor-only). It is a pure SHAPE PRODUCER — the M14
// materializer folds the result into the SINGLE settings.local.json write, so the
// ownership-marker / reclaim / cleanup protocol is untouched.
export type NativeHookMaterializer = {
  adapter: AdapterId;
  // Build the settings.local.json `hooks` block for this adapter from the
  // resolved guardrail config, or `undefined` when there is no native backend
  // for the adapter, the path-guard rule is not armed, or there is nothing to
  // write. MUST be pure (no I/O) — the caller owns the file write.
  buildSettingsHooks(args: {
    hooksConfig: HooksConfig | undefined;
    guardScriptPath: string;
  }): ClaudeSettingsLocalHooks | undefined;
};

// The claude tool names whose PreToolUse the native guard intercepts. Mirrors the
// supervisor WRITE_KINDS surface (Edit/Write/MultiEdit are edit/write/create;
// NotebookEdit is the notebook write tool).
const CLAUDE_WRITE_TOOL_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";

// P4 (spike-confirmed): claude-agent-acp sets `settingSources: ["user","project",
// "local"]` and the SDK Settings schema honors a `hooks` block, so a PreToolUse
// command hook in settings.local.json fires before a write tool runs. allowedPaths
// ride the exec-form `args` (no shell — no quoting hazard); the guard script reads
// them from argv + the worktree cwd. Derives from the SAME hooksConfig.pathGuard
// the supervisor uses (one source of truth).
const claudeNativeHookMaterializer: NativeHookMaterializer = {
  adapter: "claude",
  buildSettingsHooks({ hooksConfig, guardScriptPath }) {
    const allowedPaths = hooksConfig?.pathGuard?.allowedPaths;

    if (!allowedPaths || allowedPaths.length === 0) return undefined;

    return {
      PreToolUse: [
        {
          matcher: CLAUDE_WRITE_TOOL_MATCHER,
          hooks: [
            {
              type: "command",
              command: process.execPath,
              args: [guardScriptPath, ...allowedPaths],
            },
          ],
        },
      ],
    };
  },
};

// Adapter -> materializer registry. Only claude has a native backend (P4); every
// other adapter resolves to the no-op (the universal supervisor layer is its sole
// enforcer).
const REGISTRY: Partial<Record<AdapterId, NativeHookMaterializer>> = {
  claude: claudeNativeHookMaterializer,
};

function noopMaterializer(adapter: AdapterId): NativeHookMaterializer {
  return { adapter, buildSettingsHooks: () => undefined };
}

// Resolve the native materializer for an adapter. ALWAYS returns a materializer
// (the no-op when no native backend is registered) so callers never branch on
// undefined — the universal supervisor layer carries enforcement regardless.
export function resolveNativeHookMaterializer(
  adapter: AdapterId,
): NativeHookMaterializer {
  return REGISTRY[adapter] ?? noopMaterializer(adapter);
}

// Absolute path to the shipped native path-guard script (run via `node`). Resolved
// relative to the web app cwd; overridable for split-host topologies where the
// supervisor runs the adapter on a different machine.
export function nativeGuardScriptPath(): string {
  return (
    process.env.MAISTER_HOOK_GUARD_SCRIPT ??
    path.resolve(process.cwd(), "scripts/native-path-guard.mjs")
  );
}
