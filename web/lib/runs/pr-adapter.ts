import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import pino from "pino";

import {
  asError,
  execEnv,
  EXEC_MAX_BUFFER,
  EXEC_TIMEOUT_MS,
  parseGiteaRemote,
  scrub,
  selectPrAdapter as selectProviderAdapter,
  type PrAdapter,
  type PrAdapterContext,
} from "../../../runtime/pull-request";
import type { Provider } from "@/lib/repo-source";

export {
  EXEC_TIMEOUT_MS,
  GhCliAdapter,
  GlabCliAdapter,
  GiteaApiAdapter,
  parseGiteaRemote,
  type CreateOrUpdatePrArgs,
  type PrAdapter,
  type PrAdapterContext,
  type PrResult,
} from "../../../runtime/pull-request";

const execFileAsync = promisify(execFile);
const log = pino({
  name: "pr-adapter",
  level: process.env.LOG_LEVEL ?? "info",
});

export function selectPrAdapter(
  provider: Provider,
  ctx: PrAdapterContext,
): PrAdapter {
  return selectProviderAdapter(provider, { ...ctx, logger: log });
}

// ---- provider PR-state reads (getPrState) ---------------------------------
//
// A provider-read capability the pr_state_scan job (ADR-140) calls per row.
// Unlike createOrUpdatePr (open-PR-only, throws on failure), getPrState reports
// merge state and NEVER throws — a throw would fail the whole scan job. Every
// failure path returns a typed `skip`, and NO skip may ever be read as "the PR
// is closed": every provider deliberately answers permission-denied with the
// same 404/"could not resolve" it uses for a deleted PR (so private-repo
// existence cannot be probed), which makes an unreadable PR indistinguishable
// from a deleted one. `transient` is therefore diagnostic only — it says
// whether retrying could plausibly help, never what the PR's state is:
//   * transient=true  → retrying may help (missing CLI/token, network, provider
//                       5xx, timeout, malformed payload, 404/not-found — which
//                       may be a rotated token rather than a deleted PR).
//   * transient=false → deterministic until config changes (invalid or
//                       unparseable remote). Still not a statement about the PR.
// `generic` has no PR-state support → `unsupported` (mirrors selectPrAdapter's
// unsupported-provider path as a typed result, not a throw).
//
// `headSha` is the commit the PR itself carries (ADR-181), which a merged PR
// keeps after its branch is deleted: a finalize binds to it, never to whatever
// was published last.

export type PrStateReadResult =
  | {
      kind: "state";
      state: "open" | "merged" | "closed";
      mergedAt: string | null;
      mergeCommitSha: string | null;
      hasConflicts: boolean | null;
      headSha: string | null;
      baseRef: string | null;
    }
  | { kind: "skip"; transient: boolean; reason: string }
  | { kind: "unsupported" };

type GetPrStateArgs = {
  provider: Provider;
  remoteUrl: string;
  prNumber: number;
};

export async function getPrState(
  args: GetPrStateArgs,
): Promise<PrStateReadResult> {
  const { provider, prNumber } = args;
  const startedAt = Date.now();

  let result: PrStateReadResult;

  try {
    switch (provider) {
      case "github":
        result = await githubPrState(args);
        break;
      case "gitlab":
        result = await gitlabPrState(args);
        break;
      case "gitea":
        result = await giteaPrState(args, "GITEA_TOKEN");
        break;
      case "gitverse":
        result = await giteaPrState(args, "GITVERSE_TOKEN");
        break;
      default:
        result = { kind: "unsupported" };
    }
  } catch (err) {
    // Defensive net: a provider helper classifies internally and must not throw.
    // Any unexpected throw becomes a transient skip so getPrState NEVER throws.
    result = {
      kind: "skip",
      transient: true,
      reason: scrub(asError(err).message, undefined),
    };
  }

  log.debug(
    { provider, prNumber, durationMs: Date.now() - startedAt },
    "pr state read",
  );

  if (result.kind === "skip") {
    log.warn(
      {
        provider,
        prNumber,
        transient: result.transient,
        reason: result.reason,
      },
      "pr state read skipped",
    );
  }

  return result;
}

function skip(transient: boolean, reason: string): PrStateReadResult {
  return { kind: "skip", transient, reason };
}

// A success payload that parses but does not carry a resolvable state is a
// transient parse hiccup, not a terminal condition — retry next tick.
function malformedPayload(): PrStateReadResult {
  return skip(true, "unparseable PR-state payload");
}

// Reuse parseGiteaRemote's scp/url derivation for owner/repo across ALL
// providers (it also validates single safe path segments). It throws on an
// unparseable remote — the caller maps that to a terminal skip.
function deriveOwnerRepo(
  remoteUrl: string,
): { apiBase: string; owner: string; repo: string } | null {
  try {
    return parseGiteaRemote(remoteUrl);
  } catch {
    return null;
  }
}

// Classify a gh/glab exec failure into a typed skip. A missing CLI, auth
// hiccup, timeout, or network blip is transient (retry next tick), and so is a
// not-found — the CLIs report a permission-denied repo as 404, so "not found"
// cannot be read as "deleted". The reason is scrubbed of the token AND any
// credential-bearing URL before it can surface in a log or a stored skip.
function classifyCliFailure(
  bin: string,
  err: unknown,
  token: string | undefined,
): PrStateReadResult {
  const e = err as NodeJS.ErrnoException & { stderr?: string };
  const reason = scrub((e.stderr ?? e.message ?? "").toString(), token).trim();
  const lower = reason.toLowerCase();

  if (
    e.code === "ENOENT" ||
    lower.includes("command not found") ||
    lower.includes("not on path")
  ) {
    return skip(true, `${bin} CLI not available`);
  }

  if (
    lower.includes("could not resolve") ||
    lower.includes("no pull request") ||
    lower.includes("not found") ||
    lower.includes("404")
  ) {
    return skip(
      true,
      reason || `${bin} pull request unreadable (deleted, or no access)`,
    );
  }

  return skip(true, reason || `${bin} PR-state read failed`);
}

async function githubPrState(args: GetPrStateArgs): Promise<PrStateReadResult> {
  const parsed = deriveOwnerRepo(args.remoteUrl);

  if (!parsed) return skip(false, "cannot derive owner/repo from remote URL");

  const githubHost = new URL(parsed.apiBase).host;
  const tokenVar =
    githubHost === "github.com" ? "GH_TOKEN" : "GH_ENTERPRISE_TOKEN";
  const token = process.env[tokenVar] || undefined;

  let stdout: string;

  try {
    ({ stdout } = await execFileAsync(
      "gh",
      [
        "pr",
        "view",
        String(args.prNumber),
        "--repo",
        `${githubHost}/${parsed.owner}/${parsed.repo}`,
        "--json",
        "state,mergedAt,mergeCommit,mergeable,mergeStateStatus,headRefOid,baseRefName",
      ],
      {
        signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
        maxBuffer: EXEC_MAX_BUFFER,
        env: execEnv(token, tokenVar),
      },
    ));
  } catch (err) {
    return classifyCliFailure("gh", err, token);
  }

  let payload: {
    state?: string;
    mergedAt?: string | null;
    mergeCommit?: { oid?: string | null } | null;
    mergeable?: string;
    mergeStateStatus?: string;
    headRefOid?: string | null;
    baseRefName?: string | null;
  };

  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    return malformedPayload();
  }

  if (!payload || typeof payload !== "object") return malformedPayload();

  const state = mapGithubState(payload.state);

  if (!state) return malformedPayload();

  return {
    kind: "state",
    state,
    mergedAt: isoTimestamp(payload.mergedAt),
    mergeCommitSha: nonEmptyString(payload.mergeCommit?.oid),
    hasConflicts: githubConflicts(payload.mergeable, payload.mergeStateStatus),
    headSha: nonEmptyString(payload.headRefOid),
    baseRef: branchRef(payload.baseRefName),
  };
}

function mapGithubState(
  state: string | undefined,
): "open" | "merged" | "closed" | null {
  switch (state) {
    case "OPEN":
      return "open";
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      return null;
  }
}

function githubConflicts(
  mergeable: string | undefined,
  mergeStateStatus: string | undefined,
): boolean | null {
  if (mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") return true;
  if (mergeable === "MERGEABLE") return false;

  return null;
}

async function gitlabPrState(args: GetPrStateArgs): Promise<PrStateReadResult> {
  const parsed = deriveOwnerRepo(args.remoteUrl);

  if (!parsed) return skip(false, "cannot derive owner/repo from remote URL");

  const token = process.env.GITLAB_TOKEN || undefined;

  let stdout: string;

  try {
    // getPrState has no repo cwd (unlike createOrUpdatePr), so target the repo
    // explicitly via -R with the full host URL, which carries the self-hosted
    // host that a bare owner/repo would lose.
    ({ stdout } = await execFileAsync(
      "glab",
      [
        "mr",
        "view",
        String(args.prNumber),
        "-R",
        `${parsed.apiBase}/${parsed.owner}/${parsed.repo}`,
        "-F",
        "json",
      ],
      {
        signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
        maxBuffer: EXEC_MAX_BUFFER,
        env: execEnv(token, "GITLAB_TOKEN"),
      },
    ));
  } catch (err) {
    return classifyCliFailure("glab", err, token);
  }

  let payload: {
    state?: string;
    merged_at?: string | null;
    merge_commit_sha?: string | null;
    has_conflicts?: boolean;
    detailed_merge_status?: string;
    sha?: string | null;
    target_branch?: string | null;
    diff_refs?: { head_sha?: string | null } | null;
  };

  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    return malformedPayload();
  }

  if (!payload || typeof payload !== "object") return malformedPayload();

  const state = mapGitlabState(payload.state);

  if (!state) return malformedPayload();

  return {
    kind: "state",
    state,
    mergedAt: isoTimestamp(payload.merged_at),
    mergeCommitSha: nonEmptyString(payload.merge_commit_sha),
    hasConflicts: gitlabConflicts(payload),
    baseRef: branchRef(payload.target_branch),
    headSha:
      nonEmptyString(payload.sha) ??
      nonEmptyString(payload.diff_refs?.head_sha),
  };
}

function mapGitlabState(
  state: string | undefined,
): "open" | "merged" | "closed" | null {
  switch (state) {
    case "opened":
      return "open";
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    default:
      return null;
  }
}

function gitlabConflicts(payload: {
  has_conflicts?: boolean;
  detailed_merge_status?: string;
}): boolean | null {
  if (typeof payload.has_conflicts === "boolean") return payload.has_conflicts;
  if (typeof payload.detailed_merge_status === "string") {
    return payload.detailed_merge_status === "conflict";
  }

  return null;
}

async function giteaPrState(
  args: GetPrStateArgs,
  tokenVar: "GITEA_TOKEN" | "GITVERSE_TOKEN",
): Promise<PrStateReadResult> {
  const token = process.env[tokenVar] || undefined;

  if (!token) return skip(true, `${tokenVar} is not set`);

  const parsed = deriveOwnerRepo(args.remoteUrl);

  if (!parsed) return skip(false, "cannot derive owner/repo from remote URL");

  const url = `${parsed.apiBase}/api/v1/repos/${parsed.owner}/${parsed.repo}/pulls/${args.prNumber}`;

  let res: Response;

  try {
    // The token rides the Authorization header ONLY — never the URL.
    // The timeout is REQUIRED, not defensive: this runs inside the
    // `pr_state_scan` batch, and an unbounded fetch against a hung Gitea would
    // hold the whole scan past its scheduler lease (the CLI adapters already
    // bound themselves with the same budget).
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `token ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
    });
  } catch (err) {
    return skip(
      true,
      `Gitea PR-state request failed: ${scrub(asError(err).message, token)}`,
    );
  }

  if (!res.ok) {
    if (res.status === 404) {
      return skip(true, "Gitea PR-state HTTP 404 (deleted, or no access)");
    }

    return skip(true, `Gitea PR-state failed with HTTP ${res.status}`);
  }

  let payload: {
    state?: string;
    merged?: boolean;
    merged_at?: string | null;
    merge_commit_sha?: string | null;
    mergeable?: boolean;
    base?: { ref?: string | null } | null;
    head?: { sha?: string | null } | null;
  };

  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    return malformedPayload();
  }

  if (!payload || typeof payload !== "object") return malformedPayload();

  const state =
    payload.merged === true ? "merged" : mapGiteaState(payload.state);

  if (!state) return malformedPayload();

  return {
    kind: "state",
    state,
    mergedAt: isoTimestamp(payload.merged_at),
    mergeCommitSha: nonEmptyString(payload.merge_commit_sha),
    hasConflicts:
      typeof payload.mergeable === "boolean" ? !payload.mergeable : null,
    headSha: nonEmptyString(payload.head?.sha),
    baseRef: branchRef(payload.base?.ref),
  };
}

function mapGiteaState(state: string | undefined): "open" | "closed" | null {
  switch (state) {
    case "open":
      return "open";
    case "closed":
      return "closed";
    default:
      return null;
  }
}

function branchRef(branch: unknown): string | null {
  return typeof branch === "string" && branch.length > 0
    ? `refs/heads/${branch}`
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// `mergedAt` is the one read field that flows into a `::timestamptz` cast, so a
// provider string that merely IS a string would abort the writing transaction
// server-side. Parse it here, at the boundary the payload enters through — an
// unparseable timestamp degrades to null (the PR is still merged) rather than
// poisoning the scan.
function isoTimestamp(value: unknown): string | null {
  const raw = nonEmptyString(value);

  if (raw === null) return null;

  return Number.isNaN(Date.parse(raw)) ? null : raw;
}
