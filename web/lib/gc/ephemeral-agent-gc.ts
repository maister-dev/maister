import "server-only";

import type { RemoveOwnedWorktreeArgs } from "@/lib/worktree";

import { readdir } from "node:fs/promises";
import path from "node:path";

import { and, inArray } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { worktreesRoot } from "@/lib/instance-config";
import { removeOwnedWorktree } from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projects, runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "gc-ephemeral-agent",
  level: process.env.LOG_LEVEL ?? "info",
});

const RO_SUFFIX = "-ro";

// A run still holding its ephemeral `-ro` checkout open. Any status OUTSIDE
// this set (or a missing run row) means the terminal choke point already ran
// — so a surviving `-ro` dir is an orphan to reap. Mirrors the in-flight run
// statuses the scheduler/keepalive treat as live.
const LIVE_AGENT_STATUSES = [
  "Pending",
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "HumanWorking",
];

export interface EphemeralAgentGcSummary {
  scanned: number; // `-ro` dirs found on disk
  removed: number; // orphans reaped
  live: number; // left in place (owning run still live)
  failed: number; // removal errors (retried next sweep)
}

export interface RunEphemeralAgentGcSweepOptions {
  db?: Db;
  // Injected for tests; defaults to the real path-guarded git removal.
  removeOwnedWorktree?: (args: RemoveOwnedWorktreeArgs) => Promise<void>;
}

// ADR-090 / RD6 backstop. `workspace_ref` runs create an EPHEMERAL detached
// read-only `<runId>-ro` worktree under worktreesRoot()/<slug>/. `finalize`
// removes it at the terminal choke point, but that removal is best-effort (a
// post-commit fs call) and the dir carries NO `workspaces` row — so the
// workspace GC never sees it. This sweep is the promised backstop: it reaps
// `-ro` dirs whose owning agent run is terminal or gone.
export async function runEphemeralAgentGcSweep(
  opts: RunEphemeralAgentGcSweepOptions = {},
): Promise<EphemeralAgentGcSummary> {
  const db = opts.db ?? getDb();
  const remove = opts.removeOwnedWorktree ?? removeOwnedWorktree;
  const root = worktreesRoot();

  const projectRows: Array<{ slug: string; repoPath: string }> = await db
    .select({ slug: projects.slug, repoPath: projects.repoPath })
    .from(projects);

  let scanned = 0;
  let removed = 0;
  let live = 0;
  let failed = 0;

  for (const project of projectRows) {
    const slugDir = path.join(root, project.slug);
    let entries: string[];

    try {
      entries = await readdir(slugDir);
    } catch {
      continue; // no worktree subtree for this project yet
    }

    const roDirs = entries.filter((e) => e.endsWith(RO_SUFFIX));

    if (roDirs.length === 0) continue;

    // The run id is the dir name with the `-ro` suffix stripped.
    const runIds = roDirs.map((d) => d.slice(0, -RO_SUFFIX.length));
    const liveRows: Array<{ id: string }> = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          inArray(runs.id, runIds),
          inArray(runs.status, LIVE_AGENT_STATUSES),
        ),
      );
    const liveIds = new Set(liveRows.map((r) => r.id));

    for (const dir of roDirs) {
      scanned += 1;
      const runId = dir.slice(0, -RO_SUFFIX.length);

      if (liveIds.has(runId)) {
        live += 1;
        continue;
      }

      const worktreePath = path.join(slugDir, dir);

      try {
        await remove({
          projectRepoPath: project.repoPath,
          worktreePath,
          force: true,
          allowedRoot: root,
        });
        removed += 1;
        log.info(
          { runId, slug: project.slug, worktreePath },
          "ephemeral -ro checkout reaped (owning run terminal/absent)",
        );
      } catch (err) {
        failed += 1;
        log.warn(
          {
            runId,
            slug: project.slug,
            worktreePath,
            err: err instanceof Error ? err.message : String(err),
          },
          "ephemeral -ro checkout removal failed — retried next sweep",
        );
      }
    }
  }

  const summary: EphemeralAgentGcSummary = { scanned, removed, live, failed };

  log.info(summary, "ephemeral agent GC sweep complete");

  return summary;
}
