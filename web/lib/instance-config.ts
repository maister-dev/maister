import "server-only";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import pino from "pino";

const execFileAsync = promisify(execFile);

const log = pino({
  name: "instance-config",
  level: process.env.LOG_LEVEL ?? "info",
});

const warnedInvalidEnv = new Set<string>();

function positiveIntFromEnv(envName: string, fallback: number): number {
  const raw = process.env[envName];

  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    if (!warnedInvalidEnv.has(envName)) {
      warnedInvalidEnv.add(envName);
      log.warn(
        { envName, raw, fallback },
        "invalid positive-integer env value — using default",
      );
    }

    return fallback;
  }

  return parsed;
}

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
const DEFAULT_WORKBENCH_MAX_FILE_BYTES = 524_288;
const DEFAULT_GC_WARNING_DAYS = 2;
const DEFAULT_GC_SWEEP_INTERVAL_SECONDS = 3600;
const DEFAULT_RECONCILE_SWEEP_INTERVAL_SECONDS = 60;
const DEFAULT_RECONCILE_GRACE_SECONDS = 90;
const DEFAULT_PROMOTION_CLAIM_TIMEOUT_SECONDS = 300;
const DEFAULT_ORCHESTRATOR_MAX_DEPTH = 3;

// M18 Phase 2 (§3.2, Codex F1): a durable `claiming` promotion claim older than
// this window is considered abandoned (crashed mid-promote) and is reclaimable
// by the next promote attempt. Env override, sane default, floor at 1.
export function promotionClaimTimeoutSeconds(): number {
  const raw = process.env.MAISTER_PROMOTION_CLAIM_TIMEOUT_SECONDS;

  if (!raw) return DEFAULT_PROMOTION_CLAIM_TIMEOUT_SECONDS;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_PROMOTION_CLAIM_TIMEOUT_SECONDS;
  }

  return parsed;
}

// M19 Phase 1 (T1.C): how long after a run's endedAt its Abandoned/Done
// workspace is scheduled for removal. Env override, sane default, floor at 1.
export function gcAgeDays(): number {
  const raw = process.env.MAISTER_GC_AGE_DAYS;

  if (!raw) return DEFAULT_GC_AGE_DAYS;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_GC_AGE_DAYS;

  return parsed;
}

// M22 Phase 4a (T4.1): max blob size the workbench file viewer will read;
// over-cap blobs surface as the `file-too-large` RSC page state (ADR-066)
// instead of being read into memory. Env override, sane default, floor at 1.
// Mirrors gcAgeDays.
export function workbenchMaxFileBytes(): number {
  const raw = process.env.MAISTER_WORKBENCH_MAX_FILE_BYTES;

  if (!raw) return DEFAULT_WORKBENCH_MAX_FILE_BYTES;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_WORKBENCH_MAX_FILE_BYTES;
  }

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

// M19 Phase 4 (T4.5): how often the background GC sweeper ticks. Env override,
// sane default, floor at 1. Mirrors gcAgeDays / reconcileSweepIntervalSeconds.
export function gcSweepIntervalSeconds(): number {
  const raw = process.env.MAISTER_GC_SWEEP_INTERVAL_SECONDS;

  if (!raw) return DEFAULT_GC_SWEEP_INTERVAL_SECONDS;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_GC_SWEEP_INTERVAL_SECONDS;
  }

  return parsed;
}

// M19 Phase 4 (T4.5): when true, GC preserve pushes the maister/archive/<runId>
// branch to the remote. Only the exact value "true" enables it; default false.
export function gcArchivePush(): boolean {
  return process.env.MAISTER_GC_ARCHIVE_PUSH === "true";
}

// M36 (ADR-095): max orchestrator delegation depth — the longest parent_run_id
// chain a delegated child may sit at. Bounds runaway recursive delegation. Env
// override, sane default, floor at 1.
export function orchestratorMaxDepth(): number {
  const raw = process.env.MAISTER_ORCHESTRATOR_MAX_DEPTH;

  if (!raw) return DEFAULT_ORCHESTRATOR_MAX_DEPTH;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_ORCHESTRATOR_MAX_DEPTH;
  }

  return parsed;
}

// M19 Phase 2 (T2.3): how often the periodic reconcile sweeper ticks. Env
// override, sane default, floor at 1.
export function reconcileSweepIntervalSeconds(): number {
  const raw = process.env.MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS;

  if (!raw) return DEFAULT_RECONCILE_SWEEP_INTERVAL_SECONDS;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_RECONCILE_SWEEP_INTERVAL_SECONDS;
  }

  return parsed;
}

// M19 Phase 2 (T2.3): grace window before a no-live-session agent run is
// crashed — protects launches/recovers still spinning up their ACP session.
// Env override, sane default, floor at 1.
export function reconcileGraceSeconds(): number {
  const raw = process.env.MAISTER_RECONCILE_GRACE_SECONDS;

  if (!raw) return DEFAULT_RECONCILE_GRACE_SECONDS;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_RECONCILE_GRACE_SECONDS;
  }

  return parsed;
}

const DEFAULT_NODE_OUTPUT_MAX_BYTES = 262_144;
const DEFAULT_HARNESS_NEVER_FIRED_MIN = 10;

// M26 P1 (ADR-063): max raw bytes of a structured node-output payload
// (sentinel block / MAISTER_OUTPUT_FILE) before it is rejected at the
// validate seam. Host env only per ADR-023 — never wired into compose.
export function nodeOutputMaxBytes(): number {
  return positiveIntFromEnv(
    "MAISTER_NODE_OUTPUT_MAX_BYTES",
    DEFAULT_NODE_OUTPUT_MAX_BYTES,
  );
}

// M29 (ADR-073): minimum terminal gate executions before the observatory
// never-fired heuristic may flag a gate. Host env only per ADR-023.
export function harnessNeverFiredMin(): number {
  return positiveIntFromEnv(
    "MAISTER_HARNESS_NEVER_FIRED_MIN",
    DEFAULT_HARNESS_NEVER_FIRED_MIN,
  );
}

export type HostTool = {
  name: string;
  available: boolean;
  version: string | null;
};

// Host CLI probes are informational: a probe failure degrades to
// { available: false } rather than throwing. The PR-mode prerequisite
// (gh/glab presence per provider) is enforced at promote time, not here.
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
  return [
    await probeTool("git"),
    await probeTool("gh"),
    await probeTool("glab"),
  ];
}
