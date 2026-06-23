import "server-only";

import type { HooksSettings } from "@/lib/config.schema";
import type { ExecutionPreset } from "@/lib/runs/execution-policy";

// ADR-108 (M40): the resolved, flat guardrail rule set delivered to the
// supervisor on `StartSessionRequest.hooksConfig`. Each key is optional; an
// absent key means that rule is NOT armed for the session.
export type HooksConfig = {
  repetition?: { max: number };
  noProgress?: { maxTurns: number };
  pathGuard?: { allowedPaths: string[] };
};

// The MAISTER_HOOK_* env defaults, read once and folded into the resolver. Kept
// separate from the pure resolver so resolution stays deterministic + testable.
export type HookEnvDefaults = {
  repetitionMax: number;
  noProgressTurns: number;
  defaultWritablePaths: string[] | undefined;
};

const DEFAULT_REPETITION_MAX = 5;
const DEFAULT_NO_PROGRESS_TURNS = 15;

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];

  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) return fallback;

  return parsed;
}

// Reads the MAISTER_HOOK_* env defaults. Host/service-env only (ADR-023) —
// web + supervisor run on the host, so these are not container/compose vars.
export function hookEnvDefaults(): HookEnvDefaults {
  const rawPaths = process.env.MAISTER_HOOK_DEFAULT_WRITABLE_PATHS;
  const paths = rawPaths
    ? rawPaths
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  return {
    repetitionMax: positiveIntEnv(
      "MAISTER_HOOK_REPETITION_MAX",
      DEFAULT_REPETITION_MAX,
    ),
    noProgressTurns: positiveIntEnv(
      "MAISTER_HOOK_NO_PROGRESS_TURNS",
      DEFAULT_NO_PROGRESS_TURNS,
    ),
    defaultWritablePaths: paths.length > 0 ? paths : undefined,
  };
}

// Pure two-tier resolution (D4): folds a node's authored `hooks` block + the
// run's execution preset + env defaults into the flat wire `hooksConfig`.
// Returns `undefined` when nothing is armed (the session-body builder then
// omits the field). No DB, no env reads, no logging — caller supplies defaults.
export function resolveHooksConfig(args: {
  hooks: HooksSettings | undefined;
  preset: ExecutionPreset | undefined;
  defaults: HookEnvDefaults;
}): HooksConfig | undefined {
  const { hooks, preset, defaults } = args;

  // Per-node opt-out suppresses everything, including the unattended auto-arm.
  if (hooks?.disabled === true) return undefined;

  const unattended = preset === "unattended";
  const config: HooksConfig = {};

  // Liveness breakers: explicit node value wins; else auto-seed ONLY under the
  // `unattended` preset; else unarmed. supervised/assisted and an absent preset
  // never auto-arm (fail-safe to opt-in).
  const repetitionMax =
    hooks?.repetition?.max ?? (unattended ? defaults.repetitionMax : undefined);

  if (repetitionMax !== undefined) config.repetition = { max: repetitionMax };

  const noProgressTurns =
    hooks?.noProgress?.maxTurns ??
    (unattended ? defaults.noProgressTurns : undefined);

  if (noProgressTurns !== undefined) {
    config.noProgress = { maxTurns: noProgressTurns };
  }

  // Path guard is ALWAYS opt-in (armed only when the node declares it). Paths:
  // explicit > env default > worktree root (the "**" sentinel = guard armed but
  // effectively in-tree-permissive; out-of-tree writes are still denied).
  if (hooks?.pathGuard) {
    config.pathGuard = {
      allowedPaths: hooks.pathGuard.allowedPaths ??
        defaults.defaultWritablePaths ?? ["**"],
    };
  }

  return Object.keys(config).length > 0 ? config : undefined;
}
