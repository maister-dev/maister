import "server-only";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function reposRoot(): string {
  return (
    process.env.MAISTER_REPOS_ROOT ??
    path.join(os.homedir(), ".maister", "repos")
  );
}

export function worktreesRoot(): string {
  return (
    process.env.MAISTER_WORKTREES_ROOT ??
    process.env.MAISTER_WORKTREE_ROOT ??
    path.join(os.homedir(), ".maister", "worktrees")
  );
}

export function runtimeRoot(): string {
  return process.env.MAISTER_RUNTIME_ROOT ?? process.cwd();
}

const DEFAULT_GC_AGE_DAYS = 14;
const DEFAULT_GC_WARNING_DAYS = 2;

// M19 Phase 1 (T1.C): how long after a run's endedAt its Abandoned/Done
// workspace is scheduled for removal. Env override, sane default, floor at 1.
export function gcAgeDays(): number {
  const raw = process.env.MAISTER_GC_AGE_DAYS;

  if (!raw) return DEFAULT_GC_AGE_DAYS;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_GC_AGE_DAYS;

  return parsed;
}

// M19 Phase 1 (T1.C): pre-removal warning window. Env override, sane default,
// floor at 1.
export function gcWarningDays(): number {
  const raw = process.env.MAISTER_GC_WARNING_DAYS;

  if (!raw) return DEFAULT_GC_WARNING_DAYS;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_GC_WARNING_DAYS;

  return parsed;
}

export type HostTool = {
  name: string;
  available: boolean;
  version: string | null;
};

// gh is informational-only: absence does not block any flow, so a probe
// failure degrades to { available: false } rather than throwing.
export async function probeTool(name: string): Promise<HostTool> {
  try {
    const { stdout } = await execFileAsync(name, ["--version"], {
      signal: AbortSignal.timeout(5000),
    });

    return { name, available: true, version: stdout.trim().split("\n")[0] };
  } catch {
    return { name, available: false, version: null };
  }
}

export async function hostToolStatus(): Promise<HostTool[]> {
  return [await probeTool("git"), await probeTool("gh")];
}
