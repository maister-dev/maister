import "server-only";

import { eq } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { detectProvider, redactUrl, validateUrl } from "@/lib/repo-source";
import {
  fetchRemote,
  getRemoteUrl,
  listRemoteUrls,
  pushBranch,
  remoteAdd,
  remoteRemove,
  remoteSetUrl,
} from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants (matches route usage).
const { projects } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "git-remotes",
  level: process.env.LOG_LEVEL ?? "info",
});

const ORIGIN = "origin";

export type RemoteItem = { name: string; url: string };

export type RemotesProject = {
  id: string;
  repoPath: string;
};

export type RemoteActionResult = { ok: true; warning?: string };

// `origin` is a denormalized cache in projects.repo_url/provider; the remotes
// list reads `git remote -v` (live truth). Adding/setting `origin` writes the
// cache, removing it nulls the cache (SET/CLEAR symmetry).
async function syncOriginToDb(
  db: any,
  projectId: string,
  url: string,
): Promise<void> {
  const redacted = redactUrl(url);

  await db
    .update(projects)
    .set({ repoUrl: redacted, provider: detectProvider(url) })
    .where(eq(projects.id, projectId));
  log.info(
    { projectId, repoUrl: redacted, provider: detectProvider(url) },
    "origin synced to projects.repo_url/provider",
  );
}

async function clearOriginInDb(db: any, projectId: string): Promise<void> {
  await db
    .update(projects)
    .set({ repoUrl: null, provider: null })
    .where(eq(projects.id, projectId));
  log.info({ projectId }, "origin removed — projects.repo_url/provider nulled");
}

// List with every URL credential-redacted (live from git).
export async function listProjectRemotes(
  repoPath: string,
): Promise<RemoteItem[]> {
  const rows = await listRemoteUrls(repoPath);

  return rows.map((r) => ({ name: r.name, url: redactUrl(r.url) }));
}

export async function addProjectRemote(opts: {
  db: any;
  project: RemotesProject;
  name: string;
  url: string;
}): Promise<void> {
  validateUrl(opts.url);
  await remoteAdd({
    projectRepoPath: opts.project.repoPath,
    name: opts.name,
    url: opts.url,
  });

  if (opts.name === ORIGIN) {
    await syncOriginToDb(opts.db, opts.project.id, opts.url);
  }
}

export async function setProjectRemoteUrl(opts: {
  db: any;
  project: RemotesProject;
  name: string;
  url: string;
}): Promise<void> {
  validateUrl(opts.url);
  await remoteSetUrl({
    projectRepoPath: opts.project.repoPath,
    name: opts.name,
    url: opts.url,
  });

  if (opts.name === ORIGIN) {
    await syncOriginToDb(opts.db, opts.project.id, opts.url);
  }
}

export async function removeProjectRemote(opts: {
  db: any;
  project: RemotesProject;
  name: string;
}): Promise<void> {
  await remoteRemove({
    projectRepoPath: opts.project.repoPath,
    name: opts.name,
  });

  if (opts.name === ORIGIN) {
    await clearOriginInDb(opts.db, opts.project.id);
  }
}

// Push / fetch / set-upstream reuse host-ambient auth. A failure
// (GitPushRejectedError / EXECUTOR_UNAVAILABLE — both MaisterError, already
// redacted) is an advisory; there is no DB state to roll back.
export async function pushProjectRemote(opts: {
  project: RemotesProject;
  name: string;
  branch: string;
  setUpstream?: boolean;
}): Promise<RemoteActionResult> {
  try {
    await pushBranch({
      projectRepoPath: opts.project.repoPath,
      remote: opts.name,
      branch: opts.branch,
      setUpstream: opts.setUpstream,
    });

    return { ok: true };
  } catch (err) {
    if (err instanceof MaisterError) {
      log.warn(
        { projectId: opts.project.id, warning: err.message },
        "push failed (advisory)",
      );

      return { ok: true, warning: err.message };
    }
    throw err;
  }
}

export async function fetchProjectRemote(opts: {
  project: RemotesProject;
  name: string;
}): Promise<RemoteActionResult> {
  try {
    await fetchRemote({
      projectRepoPath: opts.project.repoPath,
      name: opts.name,
    });

    return { ok: true };
  } catch (err) {
    if (err instanceof MaisterError) {
      log.warn(
        { projectId: opts.project.id, warning: err.message },
        "fetch failed (advisory)",
      );

      return { ok: true, warning: err.message };
    }
    throw err;
  }
}

// Self-heal the origin cache (invariant B): if git has an origin whose
// (redacted) URL differs from projects.repo_url, re-derive the cache from git;
// if git has no origin but the column is non-null, clear it. Best-effort —
// a DB error here never fails the caller. Returns the effective redacted URL.
export async function reconcileOriginRepoUrl(opts: {
  db: any;
  project: RemotesProject & { repoUrl?: string | null };
}): Promise<string | null> {
  const raw = await getRemoteUrl({
    projectRepoPath: opts.project.repoPath,
    name: ORIGIN,
  });

  try {
    if (raw !== null) {
      const redacted = redactUrl(raw);

      if (opts.project.repoUrl !== redacted) {
        await syncOriginToDb(opts.db, opts.project.id, raw);
      }

      return redacted;
    }

    if (opts.project.repoUrl != null) {
      await clearOriginInDb(opts.db, opts.project.id);
    }

    return null;
  } catch (err) {
    log.warn(
      { projectId: opts.project.id, err: (err as Error).message },
      "origin reconcile failed (best-effort)",
    );

    return raw === null ? null : redactUrl(raw);
  }
}
