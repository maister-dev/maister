import type { Logger } from "pino";

import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ADR-165 D7: the allow-list a `git_worktree` / `directory` adoption must live
// under. Mirrors the web tier's worktrees + local-packages roots by default; a
// moved web root MUST be mirrored here (documented in both env samples).

export const WORKSPACE_ROOTS_ENV = "MAISTER_WORKSPACE_ROOTS";

export function defaultWorkspaceRoots(
  runtimeRoot: string,
  home: string = os.homedir(),
): string[] {
  return [
    path.join(home, ".maister", "worktrees"),
    path.join(home, ".maister", "local"),
    path.resolve(runtimeRoot, ".maister"),
  ];
}

export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));

  return p;
}

export function parseWorkspaceRoots(
  raw: string | undefined,
  runtimeRoot: string,
  home: string = os.homedir(),
): string[] {
  const configured = raw
    ?.split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(expandHome(entry, home)));

  return configured && configured.length > 0
    ? configured
    : defaultWorkspaceRoots(runtimeRoot, home);
}

// Roots are realpath'd at boot so a symlinked root (macOS /tmp → /private/tmp)
// compares equal to the realpath of a candidate workspace. A missing root is
// kept lexically and WARNed — it may be created later (first worktree add).
export async function resolveWorkspaceRoots(opts: {
  runtimeRoot: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}): Promise<string[]> {
  const env = opts.env ?? process.env;
  const roots = parseWorkspaceRoots(env[WORKSPACE_ROOTS_ENV], opts.runtimeRoot);
  const resolved: string[] = [];

  for (const root of roots) {
    try {
      resolved.push(await realpath(root));
    } catch {
      opts.logger?.warn({ root }, "workspace-root-missing");
      resolved.push(root);
    }
  }

  opts.logger?.info({ roots: resolved }, "workspace-roots");

  return resolved;
}

export function isUnderRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);

  return (
    relative.length === 0 ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
