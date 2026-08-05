import "server-only";

import { readdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { and, inArray, isNull } from "drizzle-orm";
import pino from "pino";

import { atomicWriteJson } from "@/lib/atomic";
import { CONTEXT_MOUNT_LIVE_RUN_STATUSES } from "@/lib/context-mounts/terminal";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { runtimeRoot } from "@/lib/runtime-root";
import { listWorktrees, pruneWorktrees, removeWorktree } from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projects, runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "gc-context-mount",
  level: process.env.LOG_LEVEL ?? "info",
});

// Marker dir INSIDE `context/` so it dies with the run dir, and dot-prefixed so
// the candidate scan (which skips dot entries) can never mistake it for a mount.
// A project slug is kebab-cased from the project name and can never start with a
// dot, so no real mount is ever skipped.
const MARKER_DIR = ".gc";

// Explicit backoff schedule, not a formula — an operator reading the marker can
// tell exactly when the next attempt is due. Index = attemptCount - 1; past the
// end the item is permanently `failed`.
const RETRY_BACKOFF_MS = [
  60_000, // 1m
  5 * 60_000, // 5m
  15 * 60_000, // 15m
  60 * 60_000, // 1h
  6 * 60 * 60_000, // 6h
] as const;

// The schedule covers attempts 1..N; attempt N+1 has no slot left and becomes a
// permanent `failed`. So the cap is length + 1, not length — the last attempt is
// the one that exhausts the budget.
export const MAX_CONTEXT_MOUNT_GC_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;

// A deterministic failure can never succeed on a retry, so it is recorded as a
// permanent `failed` with evidence rather than burning the retry budget.
export type ContextMountGcFailureCode =
  | "sibling_project_absent"
  | "not_a_registered_worktree"
  | "removal_failed";

export type ContextMountGcMarker = {
  state: "retry_waiting" | "failed";
  attemptCount: number;
  nextRetryAt: string | null;
  lastErrorCode: ContextMountGcFailureCode | null;
  lastErrorMessage: string | null;
  firstSeenAt: string;
  lastAttemptAt: string;
};

export interface ContextMountGcSummary {
  scanned: number; // mount dirs found on disk
  removed: number; // orphans reaped
  live: number; // left in place (owning run still live)
  skipped: number; // backoff pending, or already permanently failed
  failed: number; // transient failures this tick (bounded retry armed)
  poisoned: number; // newly marked permanently failed
}

export interface RunContextMountGcSweepOptions {
  db?: Db;
  root?: string;
  now?: () => Date;
  // Injected for tests; defaults to the real git removal.
  removeWorktree?: typeof removeWorktree;
}

type MountCandidate = {
  consumingSlug: string;
  runId: string;
  siblingSlug: string;
  mountPath: string;
  markerPath: string;
};

function markerPathFor(contextDir: string, siblingSlug: string): string {
  return path.join(contextDir, MARKER_DIR, `${siblingSlug}.json`);
}

async function readMarker(
  markerPath: string,
): Promise<ContextMountGcMarker | null> {
  try {
    return JSON.parse(
      await readFile(markerPath, "utf8"),
    ) as ContextMountGcMarker;
  } catch {
    return null;
  }
}

function markerIsDue(marker: ContextMountGcMarker | null, now: Date): boolean {
  if (!marker) return true;
  if (marker.state === "failed") return false;
  if (!marker.nextRetryAt) return true;

  return new Date(marker.nextRetryAt).getTime() <= now.getTime();
}

async function recordAttemptFailure(args: {
  candidate: MountCandidate;
  marker: ContextMountGcMarker | null;
  now: Date;
  errorCode: ContextMountGcFailureCode;
  errorMessage: string;
  deterministic: boolean;
}): Promise<"retry_waiting" | "failed"> {
  const attemptCount = (args.marker?.attemptCount ?? 0) + 1;
  const backoff = RETRY_BACKOFF_MS[attemptCount - 1];
  const state: ContextMountGcMarker["state"] =
    args.deterministic || backoff === undefined ? "failed" : "retry_waiting";
  const next: ContextMountGcMarker = {
    state,
    attemptCount,
    nextRetryAt:
      state === "failed"
        ? null
        : new Date(args.now.getTime() + backoff).toISOString(),
    lastErrorCode: args.errorCode,
    lastErrorMessage: args.errorMessage.slice(0, 512),
    firstSeenAt: args.marker?.firstSeenAt ?? args.now.toISOString(),
    lastAttemptAt: args.now.toISOString(),
  };

  await atomicWriteJson(args.candidate.markerPath, next).catch(
    (err: unknown) => {
      // A marker we cannot persist means the item degrades to the pre-ADR-142
      // behaviour (retried every tick) — loud, but not fatal to the scan.
      log.error(
        {
          mountPath: args.candidate.mountPath,
          err: err instanceof Error ? err.message : String(err),
        },
        "context mount GC marker write failed — item will be re-attempted every tick",
      );
    },
  );

  return state;
}

async function listMountCandidates(
  root: string,
  consumingSlug: string,
): Promise<MountCandidate[]> {
  const runsDir = path.join(root, ".maister", consumingSlug, "runs");
  let runIds: string[];

  try {
    runIds = await readdir(runsDir);
  } catch {
    return []; // no run subtree for this project yet
  }

  const candidates: MountCandidate[] = [];

  for (const runId of runIds) {
    if (runId.startsWith(".")) continue;

    const contextDir = path.join(runsDir, runId, "context");
    let entries: Array<{ name: string; isDirectory: () => boolean }>;

    try {
      entries = await readdir(contextDir, { withFileTypes: true });
    } catch {
      continue; // this run declared no mounts
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

      candidates.push({
        consumingSlug,
        runId,
        siblingSlug: entry.name,
        mountPath: path.join(contextDir, entry.name),
        markerPath: markerPathFor(contextDir, entry.name),
      });
    }
  }

  return candidates;
}

/**
 * ADR-157 (T32) GC backstop. Reaps mounts at
 * `.maister/<slug>/runs/<runId>/context/<siblingSlug>` whose owning run is
 * terminal or absent, then prunes every touched sibling repo.
 *
 * Deliberately reaps by PATH SHAPE — the owning run id comes from the
 * `runs/<runId>` segment and the donor repo from resolving `<siblingSlug>` to
 * that project's `repo_path`, so the sweep needs no `runs.context_mounts`
 * snapshot. That is what lets it reach ADR-157's one accepted residual crash
 * window: a mount created before the snapshot commit is referenced by no row.
 *
 * Goes beyond the `-ro` sweep it is modeled on by carrying a DURABLE per-item
 * attempt marker (ADR-142 semantics: `state` / `attempt_count` / `next_retry_at`
 * plus sanitized error evidence) next to the mount, so a permanently-failing
 * item cannot starve the rest of the scan.
 */
export async function runContextMountGcSweep(
  opts: RunContextMountGcSweepOptions = {},
): Promise<ContextMountGcSummary> {
  const db = opts.db ?? getDb();
  const root = opts.root ?? runtimeRoot();
  const now = opts.now ?? (() => new Date());
  const remove = opts.removeWorktree ?? removeWorktree;

  const projectRows: Array<{ slug: string; repoPath: string }> = await db
    .select({ slug: projects.slug, repoPath: projects.repoPath })
    .from(projects)
    .where(isNull(projects.archivedAt));
  const repoBySlug = new Map(projectRows.map((p) => [p.slug, p.repoPath]));

  const summary: ContextMountGcSummary = {
    scanned: 0,
    removed: 0,
    live: 0,
    skipped: 0,
    failed: 0,
    poisoned: 0,
  };
  const touchedRepos = new Set<string>();

  for (const project of projectRows) {
    const candidates = await listMountCandidates(root, project.slug);

    if (candidates.length === 0) continue;

    const runIds = [...new Set(candidates.map((c) => c.runId))];
    const liveRows: Array<{ id: string }> = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          inArray(runs.id, runIds),
          inArray(runs.status, [...CONTEXT_MOUNT_LIVE_RUN_STATUSES]),
        ),
      );
    const liveIds = new Set(liveRows.map((r) => r.id));

    for (const candidate of candidates) {
      summary.scanned += 1;

      if (liveIds.has(candidate.runId)) {
        summary.live += 1;
        continue;
      }

      const at = now();
      const marker = await readMarker(candidate.markerPath);

      if (!markerIsDue(marker, at)) {
        summary.skipped += 1;
        continue;
      }

      const repoPath = repoBySlug.get(candidate.siblingSlug);

      if (!repoPath) {
        // Deterministic: with no active sibling project row there is no repo to
        // deregister the worktree from, so a retry can never help.
        summary.poisoned += 1;
        await recordAttemptFailure({
          candidate,
          marker,
          now: at,
          errorCode: "sibling_project_absent",
          errorMessage: `sibling slug "${candidate.siblingSlug}" resolves to no active project`,
          deterministic: true,
        });
        log.error(
          {
            runId: candidate.runId,
            siblingSlug: candidate.siblingSlug,
            mountPath: candidate.mountPath,
          },
          "[FIX:context-mount-gc-poison] mount names no active sibling project — permanently failed, operator review",
        );
        continue;
      }

      let registered: boolean;

      try {
        const resolvedMount = await realpath(candidate.mountPath).catch(
          () => candidate.mountPath,
        );
        const worktrees = await listWorktrees(repoPath);

        registered = await isRegisteredWorktree(worktrees, resolvedMount);
      } catch (err) {
        // `git worktree list` failing is transient (busy/locked repo).
        const state = await recordAttemptFailure({
          candidate,
          marker,
          now: at,
          errorCode: "removal_failed",
          errorMessage: err instanceof Error ? err.message : String(err),
          deterministic: false,
        });

        if (state === "failed") summary.poisoned += 1;
        else summary.failed += 1;
        continue;
      }

      if (!registered) {
        // Deterministic: the dir exists but is not a worktree of the named
        // sibling, so `git worktree remove` cannot own it. Recorded with
        // evidence for operator review rather than deleted behind their back.
        summary.poisoned += 1;
        await recordAttemptFailure({
          candidate,
          marker,
          now: at,
          errorCode: "not_a_registered_worktree",
          errorMessage: `${candidate.mountPath} is not a registered worktree of ${repoPath}`,
          deterministic: true,
        });
        log.error(
          {
            runId: candidate.runId,
            siblingSlug: candidate.siblingSlug,
            mountPath: candidate.mountPath,
          },
          "[FIX:context-mount-gc-poison] mount is not a registered worktree of its sibling — permanently failed, operator review",
        );
        continue;
      }

      try {
        await remove({
          projectRepoPath: repoPath,
          worktreePath: candidate.mountPath,
          force: true,
        });
        touchedRepos.add(repoPath);
        await rm(candidate.markerPath, { force: true });
        summary.removed += 1;
        log.info(
          {
            runId: candidate.runId,
            consumingSlug: candidate.consumingSlug,
            siblingSlug: candidate.siblingSlug,
          },
          "context mount reaped (owning run terminal/absent)",
        );
      } catch (err) {
        // Transient by default (locked worktree, busy repo) — bounded retry.
        const state = await recordAttemptFailure({
          candidate,
          marker,
          now: at,
          errorCode: "removal_failed",
          errorMessage: err instanceof Error ? err.message : String(err),
          deterministic: false,
        });

        if (state === "failed") {
          summary.poisoned += 1;
          log.error(
            {
              runId: candidate.runId,
              siblingSlug: candidate.siblingSlug,
              attempts: MAX_CONTEXT_MOUNT_GC_ATTEMPTS,
            },
            "[FIX:context-mount-gc-poison] mount removal exhausted its retry budget — permanently failed",
          );
        } else {
          summary.failed += 1;
          log.warn(
            {
              runId: candidate.runId,
              siblingSlug: candidate.siblingSlug,
              errorType: err instanceof Error ? err.name : "unknown",
            },
            "context mount removal failed — bounded retry armed",
          );
        }
      }
    }
  }

  for (const repoPath of touchedRepos) {
    await pruneWorktrees(repoPath).catch(() => {});
  }

  log.info(summary, "context mount GC sweep complete");

  return summary;
}

async function isRegisteredWorktree(
  worktrees: Array<{ path: string }>,
  mountPath: string,
): Promise<boolean> {
  for (const worktree of worktrees) {
    if (worktree.path === mountPath) return true;

    // `git worktree list` reports realpaths; a candidate under a symlinked
    // runtime root (macOS /tmp) would otherwise read as unregistered.
    const resolved = await realpath(worktree.path).catch(() => worktree.path);

    if (resolved === mountPath) return true;
  }

  return false;
}
