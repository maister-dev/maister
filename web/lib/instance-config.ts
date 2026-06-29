import "server-only";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import pino from "pino";

export { runtimeRoot } from "@/lib/runtime-root";

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

// (ADR-096, Flow Studio Phase C) Root for editable local-package working dirs.
export function localPackagesRoot(): string {
  return (
    process.env.MAISTER_LOCAL_PACKAGES_ROOT ??
    path.join(os.homedir(), ".maister", "local")
  );
}

// (ADR-096) Session-scoped working-dir edit-lock TTL, in minutes.
export function localPackageLockMinutes(): number {
  return positiveIntFromEnv("MAISTER_LOCAL_PACKAGE_LOCK_MINUTES", 30);
}

const DEFAULT_IMPORT_MAX_BYTES = 52_428_800; // 50 MiB
const DEFAULT_IMPORT_MAX_ENTRIES = 2000;
const DEFAULT_IMPORT_MAX_FILE_BYTES = 10_485_760; // 10 MiB

// (M36 Phase 3) Batch-import caps, enforced PRE-WRITE: total archive bytes,
// total entry count, and per-file bytes. Host env only per ADR-023 — never
// wired into compose (a single-host knob, not a deploy var). Invalid → default
// + one WARN (positiveIntFromEnv).
export function importMaxBytes(): number {
  return positiveIntFromEnv(
    "MAISTER_IMPORT_MAX_BYTES",
    DEFAULT_IMPORT_MAX_BYTES,
  );
}

export function importMaxEntries(): number {
  return positiveIntFromEnv(
    "MAISTER_IMPORT_MAX_ENTRIES",
    DEFAULT_IMPORT_MAX_ENTRIES,
  );
}

export function importMaxFileBytes(): number {
  return positiveIntFromEnv(
    "MAISTER_IMPORT_MAX_FILE_BYTES",
    DEFAULT_IMPORT_MAX_FILE_BYTES,
  );
}

const DEFAULT_GC_AGE_DAYS = 14;
const DEFAULT_WORKBENCH_MAX_FILE_BYTES = 524_288;
const DEFAULT_GC_WARNING_DAYS = 2;
const DEFAULT_GC_SWEEP_INTERVAL_SECONDS = 3600;
const DEFAULT_RECONCILE_SWEEP_INTERVAL_SECONDS = 60;
const DEFAULT_RECONCILE_GRACE_SECONDS = 90;
const DEFAULT_RALPH_MAX_ATTEMPTS = 5;
const DEFAULT_AUTO_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_PROMOTION_CLAIM_TIMEOUT_SECONDS = 300;
const DEFAULT_ORCHESTRATOR_MAX_DEPTH = 3;
const DEFAULT_ORCHESTRATOR_MAX_FANOUT = 16;

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

// A.2/A1 ralph-loop (execution-policy axis A2): hard cap on TOTAL attempts per
// task (the original launch + auto-relaunches) before the loop holds the task
// in Backlog for a human. Env override, sane default, floor at 1.
export function ralphMaxAttempts(): number {
  const raw = process.env.MAISTER_RALPH_MAX_ATTEMPTS;

  if (!raw) return DEFAULT_RALPH_MAX_ATTEMPTS;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_RALPH_MAX_ATTEMPTS;

  return parsed;
}

// Execution-policy axis A2 (crashRetry=auto_retry): hard cap on TOTAL ledger
// attempts for a `retry_safe` node when the run policy auto-retries transient
// in-run failures (no per-node retry_policy declared). Mirrors the node-level
// retry_policy.attempts bound. Env override, sane default, floor at 1.
export function autoRetryMaxAttempts(): number {
  const raw = process.env.MAISTER_AUTO_RETRY_MAX_ATTEMPTS;

  if (!raw) return DEFAULT_AUTO_RETRY_MAX_ATTEMPTS;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_AUTO_RETRY_MAX_ATTEMPTS;
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

// ADR-117: lookback window (hours) for the system_sweep cost-rollup backstop
// reconcile — only runs whose ended_at is within this window are candidates.
// Default 168h = 7d, matching the GC horizon (DEFAULT_GC_AGE_DAYS).
export function costReconcileLookbackHours(): number {
  return positiveIntFromEnv("MAISTER_COST_RECONCILE_LOOKBACK_HOURS", 168);
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

// M37 (ADR-098): max orchestrator delegation depth — the longest parent_run_id
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

// M37 (ADR-098): max as-plan tasks a single run_plan emit may create — the
// orchestrator DAG fan-out cap. Bounds runaway plan emission. Env override,
// sane default, floor at 1.
export function orchestratorMaxFanout(): number {
  const raw = process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT;

  if (!raw) return DEFAULT_ORCHESTRATOR_MAX_FANOUT;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_ORCHESTRATOR_MAX_FANOUT;
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
