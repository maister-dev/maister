// ADR-104 (M40) T4.3 — native claude PreToolUse path-guard hook.
//
// Registered into <worktree>/.claude/settings.local.json by the P4 native
// materializer for a claude flow session whose node arms `hooks.pathGuard`. The
// claude-agent-acp adapter loads settings.local.json (settingSources includes
// "local") and fires this PreToolUse command hook before a write tool runs;
// this script denies a write whose target escapes the allowed lane
// (deny-and-continue — the agent adapts).
//
// DEFENSE-IN-DEPTH ONLY. The universal supervisor ACP-seam interceptor
// (guardrail-hooks.ts) is the authoritative backstop and the SOLE enforcer of
// `repetition` / `no_progress` and of every non-claude adapter. `allowedPaths`
// derives from the SAME resolved hooksConfig.pathGuard the supervisor uses.
//
// Invocation (settings-hook exec form, no shell):
//   node native-path-guard.mjs <allowedPath...>
// allowedPaths are worktree-relative globs; the sentinel "**" = any in-tree
// write allowed. cwd is the agent worktree.

import path from "node:path";
import { pathToFileURL } from "node:url";

// Minimal glob → RegExp (mirrors supervisor/src/guardrail-hooks.ts globToRegExp):
// `*` matches a run of non-separator chars, `**` matches across separators.
export function globToRegExp(glob) {
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

// Resolve a tool path to a worktree-relative POSIX path, or null when it escapes
// the worktree (absolute outside it, `..` traversal, or the root itself).
export function toWorktreeRelative(worktreePath, p) {
  const abs = path.isAbsolute(p) ? p : path.resolve(worktreePath, p);
  const rel = path.relative(worktreePath, abs);

  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;

  return rel.split(path.sep).join("/");
}

const PATH_KEYS = ["file_path", "notebook_path", "path"];

export function extractToolPath(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return undefined;
  for (const key of PATH_KEYS) {
    const v = toolInput[key];

    if (typeof v === "string" && v.length > 0) return v;
  }

  return undefined;
}

// Returns { deny: boolean, reason?: string }. The matcher is gated on the
// settings-hook `matcher` to write tools (Edit|Write|MultiEdit|NotebookEdit), so
// every call here is a write — a missing path is the kind-only-fallback deny.
export function evaluatePathGuard({ toolInput, allowedPaths, cwd }) {
  const writePath = extractToolPath(toolInput);

  if (writePath === undefined) {
    return {
      deny: true,
      reason: "no extractable write path (kind-only fallback)",
    };
  }

  const rel = toWorktreeRelative(cwd, writePath);

  if (rel === null) {
    return { deny: true, reason: `write outside the worktree: ${writePath}` };
  }
  // Sentinel "**" = any in-tree write allowed (the in-tree check already passed).
  if (allowedPaths.includes("**")) return { deny: false };

  const allowed = allowedPaths.some((g) => globToRegExp(g).test(rel));

  return allowed
    ? { deny: false }
    : { deny: true, reason: `write outside the allowed lane (${rel})` };
}

async function readStdin() {
  const chunks = [];

  for await (const chunk of process.stdin) chunks.push(chunk);

  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const allowedPaths = process.argv.slice(2);
  let payload;

  try {
    payload = JSON.parse((await readStdin()) || "{}");
  } catch {
    // Unparseable payload → fail-open (the supervisor interceptor backstops every
    // write). Never block on a payload we cannot read.
    process.exit(0);
  }

  const decision = evaluatePathGuard({
    toolInput: payload?.tool_input,
    allowedPaths,
    cwd: process.cwd(),
  });

  if (decision.deny) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Guardrail path_guard: ${decision.reason}`,
        },
      }),
    );
  }

  process.exit(0);
}

// Run main only when invoked directly (`node native-path-guard.mjs`), never when
// imported by a test.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
