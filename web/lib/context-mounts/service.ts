import "server-only";

import type {
  ContextMountSnapshot,
  ContextRepoDecl,
} from "@/lib/context-mounts/types";

import path from "node:path";

import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { runtimeRoot } from "@/lib/runtime-root";
import {
  addDetachedWorktree,
  pruneWorktrees,
  removeWorktree,
  resolveRefSha,
} from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { projects } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "context-mounts",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-157 D9: mounts live under the RUN dir, never under `worktreesRoot()`.
// That is not cosmetic — the workspace reconciler scans exactly
// `worktreesRoot()/<slug>/<entry>` (two segments) and `loadTrustedProject`
// requires `project.repoPath === provenance.parentRepoPath`. A sibling mount's
// parent repo is by definition a DIFFERENT project's repo, so a mount placed
// under `worktreesRoot()` would be quarantined as an untrusted candidate on
// every sweep. The run dir is also already inside the prompt-confinement
// allow-set, so no supervisor confinement change is needed.
export function contextMountPath(
  consumingProjectSlug: string,
  runId: string,
  siblingSlug: string,
): string {
  return path.join(
    runtimeRoot(),
    ".maister",
    consumingProjectSlug,
    "runs",
    runId,
    "context",
    siblingSlug,
  );
}

// Resolve each declared slug to a live project + a concrete committish. Refuses
// rather than degrading: a mount the agent silently did not get is worse than a
// launch that says why. No auto-fetch (the ADR-090 v1 rule) — the ref must
// already exist in the sibling repo.
export async function resolveContextMounts(input: {
  consumingProjectSlug: string;
  runId: string;
  decls: ContextRepoDecl[];
  db?: Db;
}): Promise<ContextMountSnapshot[]> {
  if (input.decls.length === 0) return [];

  const _db = (input.db ?? getDb()) as unknown as { select: any };
  const snapshot: ContextMountSnapshot[] = [];

  for (const decl of input.decls) {
    const rows = (await _db
      .select({
        id: projects.id,
        slug: projects.slug,
        repoPath: projects.repoPath,
        mainBranch: projects.mainBranch,
      })
      .from(projects)
      .where(
        and(eq(projects.slug, decl.project), isNull(projects.archivedAt)),
      )) as Array<{
      id: string;
      slug: string;
      repoPath: string;
      mainBranch: string | null;
    }>;
    const sibling = rows[0];

    if (!sibling) {
      log.warn(
        { runId: input.runId, siblingSlug: decl.project },
        "context mount refused: unknown or archived sibling project",
      );
      throw new MaisterError(
        "PRECONDITION",
        `context_repos: project "${decl.project}" is not a registered active project`,
      );
    }

    const ref = decl.ref ?? sibling.mainBranch ?? "HEAD";

    let committish: string;

    try {
      committish = await resolveRefSha(sibling.repoPath, ref);
    } catch {
      log.warn(
        { runId: input.runId, siblingSlug: decl.project, ref },
        "context mount refused: ref does not resolve in the sibling repo",
      );
      throw new MaisterError(
        "PRECONDITION",
        `context_repos: ref "${ref}" does not resolve in project "${decl.project}" (no auto-fetch)`,
      );
    }

    snapshot.push({
      projectId: sibling.id,
      slug: sibling.slug,
      repoPath: sibling.repoPath,
      mountPath: contextMountPath(
        input.consumingProjectSlug,
        input.runId,
        sibling.slug,
      ),
      committish,
    });
  }

  log.debug(
    { runId: input.runId, mounts: snapshot.map((m) => m.slug) },
    "context mounts resolved",
  );

  return snapshot;
}

// Remove-first so a crashed prior spawn of the SAME run is recoverable rather
// than permanently wedged on an existing path (mirrors the ephemeral -ro
// checkout path in agents/launch.ts).
export async function materializeContextMounts(
  snapshot: ContextMountSnapshot[],
): Promise<void> {
  for (const mount of snapshot) {
    await removeWorktree({
      projectRepoPath: mount.repoPath,
      worktreePath: mount.mountPath,
      force: true,
    }).catch(() => {});

    await addDetachedWorktree({
      projectRepoPath: mount.repoPath,
      worktreePath: mount.mountPath,
      committish: mount.committish,
    });

    log.info(
      {
        siblingSlug: mount.slug,
        committish: mount.committish,
        mountPath: mount.mountPath,
      },
      "context mount materialized",
    );
  }
}

// Release against EACH SIBLING's repo, then prune it. Without the sibling-side
// removal the sibling repo accumulates stale `worktree list` registrations that
// nothing else will ever clean up.
export async function releaseContextMounts(
  snapshot: ContextMountSnapshot[] | null | undefined,
): Promise<void> {
  if (!snapshot || snapshot.length === 0) return;

  const touchedRepos = new Set<string>();

  for (const mount of snapshot) {
    try {
      await removeWorktree({
        projectRepoPath: mount.repoPath,
        worktreePath: mount.mountPath,
        force: true,
      });
      touchedRepos.add(mount.repoPath);
    } catch (err) {
      // Best-effort per mount: one stuck sibling must not strand the rest, and
      // the GC backstop reaps whatever is left by path shape.
      log.warn(
        {
          siblingSlug: mount.slug,
          mountPath: mount.mountPath,
          error: err instanceof Error ? err.message : String(err),
        },
        "context mount removal failed — leaving it to the GC backstop",
      );
    }
  }

  for (const repoPath of touchedRepos) {
    await pruneWorktrees(repoPath).catch(() => {});
  }
}
