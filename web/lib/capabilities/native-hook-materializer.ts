import "server-only";

import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type { HooksConfig } from "@/lib/flows/hooks-config";

// ADR-104 D7 (M40): the per-adapter native-hook materializer seam. The universal
// supervisor ACP-seam interceptor enforces ALL three rules for every adapter;
// the OPTIONAL native backend (a claude `PreToolUse` hook written into the M14
// `.claude/settings.local.json`) is a defense-in-depth optimization covering
// ONLY `path_guard` (rules `repetition` / `no_progress` need cross-turn session
// state and stay supervisor-only). The interface ships now with a NO-OP
// registry; the claude materializer registers in P4 (spike-gated on the bundled
// adapter honoring settings-file hooks, with documented graceful degradation).
export type NativeHookMaterializer = {
  adapter: AdapterId;
  // Materialize the resolved path-guard rules into the adapter's native hook
  // surface. Returns `true` iff something was materialized; `false` means no
  // native backend for this adapter — the universal supervisor layer is the
  // sole enforcer. A real implementation MUST be idempotent and respect the M14
  // ownership-marker / reclaim / cleanup protocol.
  materialize(args: {
    hooksConfig: HooksConfig | undefined;
    worktreePath: string;
  }): boolean;
};

// Adapter -> materializer registry. Empty in P1: every adapter resolves to the
// no-op below. The claude PreToolUse materializer registers here in P4.
const REGISTRY: Partial<Record<AdapterId, NativeHookMaterializer>> = {};

function noopMaterializer(adapter: AdapterId): NativeHookMaterializer {
  return { adapter, materialize: () => false };
}

// Resolve the native materializer for an adapter. ALWAYS returns a materializer
// (the no-op when no native backend is registered) so callers never branch on
// undefined — the universal supervisor layer carries enforcement regardless.
export function resolveNativeHookMaterializer(
  adapter: AdapterId,
): NativeHookMaterializer {
  return REGISTRY[adapter] ?? noopMaterializer(adapter);
}
