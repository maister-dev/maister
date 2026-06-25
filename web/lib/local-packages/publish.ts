import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { eq } from "drizzle-orm";
import pino from "pino";

import {
  gitRemoteDefaultBranch,
  gitSetPublishBranchToHead,
  gitSetRemote,
} from "./git";
import { acquirePublishLock, releasePublishLock } from "./lock";
import { getLocalPackage } from "./service";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { detectProvider, type Provider } from "@/lib/repo-source";
import { selectPrAdapter } from "@/lib/runs/pr-adapter";
import { branchNameSchema, pushBranch } from "@/lib/worktree";

const log = pino({
  name: "local-packages/publish",
  level: process.env.LOG_LEVEL ?? "info",
});

type Db = NodePgDatabase<typeof schema>;

function resolveDb(db?: Db): Db {
  return db ?? (getDb() as unknown as Db);
}

const lp = schema.localPackages;
const ps = schema.packageSources;

// The named remote publish points the working dir at — replaced per publish so a
// retarget never reuses a stale URL.
const PUBLISH_REMOTE = "maister-publish";
// The default PR base. `package_sources` stores no per-source default branch, so
// the upstream's main is the pragmatic base (documented in configuration.md).
const DEFAULT_PR_BASE = "main";

export type PublishResult = {
  branch: string;
  pushed: boolean;
  prUrl: string | null;
  compareUrl: string | null;
  crossRepo: boolean;
};

export type PublishSourceOption = { id: string; url: string };

export type PublishOptions = {
  sources: PublishSourceOption[];
  // The registered source whose URL matches the package's fork origin, preselected.
  preselectedSourceId: string | null;
  // Prefilled stable, reusable branch `maister/<slug>`.
  defaultBranch: string;
};

// Strip a trailing `.git` / slash and normalize ssh forms to an https web URL so
// two spellings of the same repo compare equal (preselect) and a compare URL is
// buildable.
export function webUrlFromGitUrl(url: string): string | null {
  let u = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const ssh = u.match(/^git@([^:]+):(.+)$/);

  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  u = u.replace(/^ssh:\/\/git@/, "https://").replace(/^git:\/\//, "https://");

  return /^https?:\/\//.test(u) ? u : null;
}

function normalizeForCompare(url: string): string {
  return (
    webUrlFromGitUrl(url) ??
    url
      .trim()
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
  ).toLowerCase();
}

// Best-effort compare / new-PR URL for the push-only fallback (no provider CLI /
// token). Null when the source URL is not a recognizable web URL.
export function buildCompareUrl(
  sourceUrl: string,
  provider: Provider,
  base: string,
  head: string,
): string | null {
  const web = webUrlFromGitUrl(sourceUrl);

  if (!web) return null;
  switch (provider) {
    case "github":
    case "gitea":
    case "gitverse":
      return `${web}/compare/${base}...${head}`;
    case "gitlab":
      return `${web}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(head)}`;
    default:
      return web;
  }
}

// The registered source whose URL matches `sourceRepoUrl` (the package's fork
// origin), for the publish dialog's preselect. Null when no source matches.
export function preselectPublishSourceId(
  sourceRepoUrl: string | null | undefined,
  sources: PublishSourceOption[],
): string | null {
  if (!sourceRepoUrl) return null;
  const target = normalizeForCompare(sourceRepoUrl);

  return sources.find((s) => normalizeForCompare(s.url) === target)?.id ?? null;
}

export async function getPublishOptions(
  id: string,
  db?: Db,
): Promise<PublishOptions> {
  const d = resolveDb(db);
  const pkg = await getLocalPackage(id, d);

  if (!pkg || pkg.status !== "active") {
    throw new MaisterError("PRECONDITION", "local package not found");
  }
  const rows = await d
    .select({ id: ps.id, url: ps.url, enabled: ps.enabled })
    .from(ps);
  const sources = rows
    .filter((r) => r.enabled)
    .map((r) => ({ id: r.id, url: r.url }));

  return {
    sources,
    preselectedSourceId: preselectPublishSourceId(pkg.sourceRepoUrl, sources),
    defaultBranch: `maister/${pkg.slug}`,
  };
}

// PR-to-source publish (ADR-113): push the package's committed working tree to a
// REGISTERED source (allow-list) on a stable `maister/<slug>` branch, then open /
// update a PR when a provider + token is available, else push-only + a compare
// URL. Two-phase: `last_pushed_branch` / `last_pr_url` are written only AFTER the
// push acks. Never logs tokens (the adapters scrub their own errors).
export async function publishLocalPackage(
  id: string,
  opts: { targetSourceId: string; branchName: string; db?: Db },
): Promise<PublishResult> {
  const d = resolveDb(opts.db);

  // Validate the branch at the contract boundary (pushBranch re-checks at the sink).
  const branchCheck = branchNameSchema.safeParse(opts.branchName);

  if (!branchCheck.success) {
    throw new MaisterError(
      "PRECONDITION",
      `invalid branch name: ${branchCheck.error.issues[0]?.message ?? "bad branch"}`,
    );
  }

  const pkg = await getLocalPackage(id, d);

  if (!pkg || pkg.status !== "active") {
    throw new MaisterError("PRECONDITION", "local package not found");
  }

  // Resolve the target ONLY from the registered allow-list (server-state) — a
  // body-supplied raw URL is never accepted.
  const [source] = await d
    .select({ id: ps.id, url: ps.url, enabled: ps.enabled })
    .from(ps)
    .where(eq(ps.id, opts.targetSourceId));

  if (!source || !source.enabled) {
    throw new MaisterError(
      "CONFLICT",
      "target source is not a registered, enabled package source",
    );
  }
  const sourceUrl = source.url;
  const crossRepo = Boolean(
    pkg.sourceRepoUrl &&
      normalizeForCompare(pkg.sourceRepoUrl) !== normalizeForCompare(sourceUrl),
  );

  // Serialize publish per package: two concurrent publishes would interleave on the
  // shared remote (committed content pushed to the wrong repo) and race the markers
  // below. Non-blocking — a CONFLICT surfaces "publish in progress", never a queue.
  const lockToken = await acquirePublishLock(id, d);

  try {
    // Point the remote at the target + force the stable branch to HEAD, then push.
    // pushBranch throws CONFLICT on a non-fast-forward, EXECUTOR_UNAVAILABLE else.
    await gitSetRemote(pkg.workingDir, PUBLISH_REMOTE, sourceUrl);
    await gitSetPublishBranchToHead(pkg.workingDir, opts.branchName);
    await pushBranch({
      projectRepoPath: pkg.workingDir,
      remote: PUBLISH_REMOTE,
      branch: opts.branchName,
      setUpstream: true,
    });

    // The PR base = the target's real default branch (master/develop/…); a
    // hardcoded "main" would open the PR / compare-url against a wrong/absent base.
    // Best-effort network lookup; falls back to DEFAULT_PR_BASE.
    const prBase =
      (await gitRemoteDefaultBranch(pkg.workingDir, PUBLISH_REMOTE)) ??
      DEFAULT_PR_BASE;

    // Try a PR; fall back to push-only. A failure here is classified (never the raw
    // message, which the adapters already scrub) so no token can leak.
    const provider = detectProvider(sourceUrl);
    let prUrl: string | null = null;
    let compareUrl: string | null = null;

    try {
      const adapter = selectPrAdapter(provider, { remoteUrl: sourceUrl });

      await adapter.preflight();
      const pr = await adapter.createOrUpdatePr({
        repoPath: pkg.workingDir,
        remote: PUBLISH_REMOTE,
        sourceBranch: opts.branchName,
        targetBranch: prBase,
        title: `Update ${pkg.name} from MAIster Flow Studio`,
        body: `Proposed by MAIster Flow Studio for local package \`${pkg.slug}\`.`,
      });

      prUrl = pr.url;
    } catch (err) {
      compareUrl = buildCompareUrl(
        sourceUrl,
        provider,
        prBase,
        opts.branchName,
      );
      log.info(
        {
          id,
          provider,
          reason: isMaisterError(err) ? err.code : "pr_unavailable",
        },
        "PR automation unavailable — push-only fallback",
      );
    }

    // Phase 2: persist the markers AFTER the push (and PR) succeeded.
    await d
      .update(lp)
      .set({
        lastPushedBranch: opts.branchName,
        lastPrUrl: prUrl,
        updatedAt: new Date(),
      })
      .where(eq(lp.id, id));

    log.info(
      {
        id,
        branch: opts.branchName,
        provider,
        hasPr: Boolean(prUrl),
        crossRepo,
      },
      "local package published",
    );

    return {
      branch: opts.branchName,
      pushed: true,
      prUrl,
      compareUrl,
      crossRepo,
    };
  } finally {
    // Best-effort: a failed release auto-clears on staleness (never wedges).
    await releasePublishLock(id, lockToken, d).catch((err) =>
      log.error(
        { id, err: (err as Error).message },
        "publish lock release failed (auto-clears on staleness)",
      ),
    );
  }
}
