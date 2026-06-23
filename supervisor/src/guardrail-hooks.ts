import type {
  HookDisposition,
  HookLifecycle,
  HookRule,
  HooksConfig,
} from "./types";

import path from "node:path";

// ADR-104 (M40): the canonical write-class ACP toolCall kind set — the single
// source of truth for "is this tool call mutating?". Consumed here by path_guard
// / no_progress AND by the ADR-078 L2 read-only-turn auto-reject in acp-client.ts
// (it imports this set rather than re-declaring it). Reads, searches, and
// `execute` (bash, which can be read-only) are NOT write-class and pass.
export const WRITE_KINDS: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "create",
  "delete",
  "move",
]);

// The standardized ACP toolCall fields the guardrail reads. `kind` classifies
// the call; `locations[0].path` is the standardized write-path field (verified
// for claude, schema-backed for codex; absent for the kind-only-fallback
// adapters gemini / opencode / mimo). See the SDD spec §1.1.
export type GuardrailToolCall = {
  kind?: string;
  locations?: Array<{ path?: string; line?: number }>;
};

// Adapter-agnostic write-path extraction (SDD spec §1.1). `path` is undefined
// when the adapter omits `locations` → the caller applies the kind-only
// fallback (conservative deny for an armed path_guard).
export function extractWritePath(tc: GuardrailToolCall): {
  isWrite: boolean;
  path?: string;
} {
  const isWrite = tc.kind !== undefined && WRITE_KINDS.has(tc.kind);
  const writePath = tc.locations?.[0]?.path;

  return { isWrite, path: writePath };
}

// Minimal glob → RegExp for the path-guard allow-set. `*` matches a run of
// non-separator chars, `**` matches any chars including separators. The MVP
// allowedPaths are simple repo-relative globs ("src/**", "tests/**"); the "**"
// sentinel is handled by resolvePathGuardDecision as an in-tree check, NOT here
// (S5), so this never has to interpret a bare "**" specially.
function globToRegExp(glob: string): RegExp {
  let re = "";

  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];

    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 1;
      } else {
        re += "[^/]*";
      }
    } else if (/[.+?^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }

  return new RegExp(`^${re}$`);
}

// Resolve a toolCall path to a worktree-relative POSIX path, or null when it
// escapes the worktree (an absolute path outside it, or a `..` traversal, or the
// worktree root itself). An out-of-tree write is never in-lane.
function toWorktreeRelative(worktreePath: string, p: string): string | null {
  const abs = path.isAbsolute(p) ? p : path.resolve(worktreePath, p);
  const rel = path.relative(worktreePath, abs);

  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;

  return rel;
}

export type PathGuardDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: "out_of_lane" | "kind_only_fallback" }
  | null;

// Rule 2 — path_guard (deny-and-continue). Returns null when the rule is not
// armed or the call is not a write (pass through to repetition / HITL). A write
// outside `allowedPaths` (or with no extractable path) is denied; the run
// continues. The "**" sentinel = "any in-tree write allowed" (NOT a literal
// glob): the in-tree check below is the gate, out-of-tree is always denied.
export function resolvePathGuardDecision(args: {
  pathGuard: HooksConfig["pathGuard"];
  toolCall: GuardrailToolCall;
  worktreePath: string;
}): PathGuardDecision {
  const { pathGuard, toolCall, worktreePath } = args;

  if (!pathGuard) return null;

  const { isWrite, path: writePath } = extractWritePath(toolCall);

  if (!isWrite) return null;

  // Kind-only fallback: an armed path_guard cannot verify the lane → conservative
  // deny-and-continue (the adapter omitted toolCall.locations).
  if (writePath === undefined) {
    return { decision: "deny", reason: "kind_only_fallback" };
  }

  const rel = toWorktreeRelative(worktreePath, writePath);

  // Out-of-tree writes are never in-lane, regardless of the allow-set.
  if (rel === null) return { decision: "deny", reason: "out_of_lane" };

  // Sentinel "**" = any in-tree write allowed (the in-tree check already passed).
  if (pathGuard.allowedPaths.includes("**")) return { decision: "allow" };

  const allowed = pathGuard.allowedPaths.some((g) => globToRegExp(g).test(rel));

  return allowed
    ? { decision: "allow" }
    : { decision: "deny", reason: "out_of_lane" };
}

// ADR-104 (M40): a stable signature for the repetition breaker. The volatile
// per-call `toolCallId` is stripped; an identical repeated tool call (same kind,
// title, args, locations) yields an identical signature. A volatile non-id field
// (e.g. a per-call timestamp) would defeat the match — acceptable: a missed
// repeat is caught by the no_progress breaker, whereas a false match would halt a
// healthy run.
export function toolCallSignature(toolCall: unknown): string {
  if (toolCall === null || typeof toolCall !== "object") {
    return JSON.stringify(toolCall ?? null);
  }

  const rest: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(
    toolCall as Record<string, unknown>,
  )) {
    if (key !== "toolCallId") rest[key] = value;
  }

  return JSON.stringify(rest);
}

// Rule 1 — repetition. Increments the run of consecutive identical signatures;
// resets to 1 on a differing signature. Trips at EXACTLY `max` consecutive
// identical calls (repeatCount counts the current call inclusively).
export function repetitionTick(
  prev: { lastToolCallSig?: string; repeatCount: number },
  sig: string,
  max: number,
): { lastToolCallSig: string; repeatCount: number; tripped: boolean } {
  const repeatCount = sig === prev.lastToolCallSig ? prev.repeatCount + 1 : 1;

  return { lastToolCallSig: sig, repeatCount, tripped: repeatCount >= max };
}

// Classify a session.update for the no_progress watchdog (D5). Only a `tool_call`
// notification counts as a "turn" (a unit of agent work); a write-kind tool call
// is progress (resets the counter). Streaming chunks / plans / other updates are
// ignored — counting them would trip the watchdog almost instantly.
export function classifyProgressUpdate(update: unknown): {
  isTurn: boolean;
  isProgress: boolean;
} {
  const u = update as { sessionUpdate?: unknown; kind?: unknown } | null;

  if (!u || u.sessionUpdate !== "tool_call") {
    return { isTurn: false, isProgress: false };
  }

  const isProgress = typeof u.kind === "string" && WRITE_KINDS.has(u.kind);

  return { isTurn: true, isProgress };
}

// Rule 3 — no_progress. Resets to 0 on a progress turn (a write-kind tool call);
// otherwise increments. Trips at EXACTLY `maxTurns` turns since the last
// progress. Called once per "turn" (see classifyProgressUpdate).
export function noProgressTick(
  prev: { turnsSinceProgress: number },
  isProgress: boolean,
  maxTurns: number,
): { turnsSinceProgress: number; tripped: boolean } {
  if (isProgress) return { turnsSinceProgress: 0, tripped: false };

  const turnsSinceProgress = prev.turnsSinceProgress + 1;

  return { turnsSinceProgress, tripped: turnsSinceProgress >= maxTurns };
}

// The frozen rule × lifecycle × disposition matrix (SDD spec §2.4). The
// supervisor stamps every session.hook_trip from this map.
export const HOOK_RULE_META: Record<
  HookRule,
  { lifecycle: HookLifecycle; disposition: HookDisposition }
> = {
  path_guard: { lifecycle: "pre_tool_call", disposition: "deny" },
  repetition: { lifecycle: "pre_tool_call", disposition: "halt" },
  no_progress: { lifecycle: "post_turn", disposition: "halt" },
};
