import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";

import { branchNameViolation } from "./git-branch";
import { MaisterError } from "./maister-error";
import { redactUrl, type Provider } from "./repository-url";

const execFileAsync = promisify(execFile);

// The per-provider-call ceiling. Exported because `pr_state_scan` reserves it as
// lease headroom: if the two drift, a candidate started just under the scan's
// deadline can outlive the scheduler lease and be reaped mid-call.
export const EXEC_TIMEOUT_MS = 60_000;
export const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

// Safety bound on the Gitea open-PR pagination sweep (see findOpenPr).
const PR_LOOKUP_MAX_PAGES = 200;

// A single safe URL path segment (mirrors repo-source's deriveRepoName guard).
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

const providerTokenVar = {
  github: "GH_TOKEN",
  gitlab: "GITLAB_TOKEN",
  gitea: "GITEA_TOKEN",
  gitverse: "GITVERSE_TOKEN",
} as const;

export function configuredPrCredential(provider: Provider): string | undefined {
  if (provider === "generic") return undefined;

  return (
    process.env[providerTokenVar[provider]] ||
    (provider === "github" ? process.env.GITHUB_TOKEN : undefined)
  );
}

export type CreateOrUpdatePrArgs = {
  repoPath: string;
  remote: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  body: string;
  // ADR-181 D11: open the PR as a draft. Applied on CREATE only.
  draft?: boolean;
  providerRepository?: string;
  signal?: AbortSignal;
  beforeWrite?: () => Promise<void>;
};

// `reused` (C18): an open PR for the same head/base already existed and was
// returned UNTOUCHED — the request's title, body and draft were not applied.
export type PrResult = { url: string; number: number; reused: boolean };

export interface PrAdapter {
  preflight(signal?: AbortSignal): Promise<void>;
  createOrUpdatePr(args: CreateOrUpdatePrArgs): Promise<PrResult>;
}

type PrAdapterLogger = {
  debug(fields: object, message: string): void;
  warn(fields: object, message: string): void;
};
export type PrAdapterContext = {
  remoteUrl?: string | null;
  logger?: PrAdapterLogger;
  credential?: string;
};

export function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// Scrub anything secret-bearing (creds in URLs + the active provider token)
// from a string that may surface in a thrown message or a log line.
export function scrub(text: string, token: string | undefined): string {
  let out = redactUrl(text);

  if (token) out = out.split(token).join("***");

  return out;
}

export function execEnv(
  token: string | undefined,
  tokenVar: string,
): NodeJS.ProcessEnv {
  if (!token) return process.env;

  // The token rides the child env ONLY — never argv, never logged.
  return { ...process.env, [tokenVar]: token };
}

// Reject any branch ref that is not a safe git branch name BEFORE it reaches a
// gh/glab argv or the Gitea REST body. BOTH refs are swept (sibling-field rule):
// sourceBranch is server-generated, but targetBranch is request-derived and on
// the allowTargetDrift path bypasses the local-merge regex, so the PR boundary
// must guard it itself. Same `branchNameSchema` as worktree → one rule, all
// three adapters.
function assertSafeBranchRefs(args: CreateOrUpdatePrArgs): void {
  for (const [label, value] of [
    ["sourceBranch", args.sourceBranch],
    ["targetBranch", args.targetBranch],
  ] as const) {
    const violation = branchNameViolation(value);

    if (violation) {
      throw new MaisterError(
        "PRECONDITION",
        `unsafe ${label} for pull request: ${violation}`,
      );
    }
  }
}

// ---- CLI adapters (github / gitlab) ---------------------------------------

abstract class CliPrAdapter implements PrAdapter {
  protected abstract readonly bin: string;
  protected abstract readonly tokenVar: string;
  protected abstract readonly displayName: string;

  constructor(
    protected readonly remoteUrl: string | null | undefined,
    protected readonly logger?: PrAdapterLogger,
    protected readonly credential?: string,
  ) {}

  protected get token(): string | undefined {
    return this.credential ?? (process.env[this.tokenVar] || undefined);
  }

  protected environment(): NodeJS.ProcessEnv {
    return execEnv(this.token, this.tokenVar);
  }

  // gh/glab infer the repository from the process CWD. A PR promotion MUST run
  // against the target project's checkout (args.repoPath), never the MAIster
  // server's own working directory — so every list/create call passes cwd. The
  // repo-independent `--version` preflight passes none.
  protected async exec(
    args: readonly string[],
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string }> {
    this.logger?.debug({ bin: this.bin, cwd }, "pr cli exec");

    return execFileAsync(this.bin, args, {
      cwd,
      signal: signal ?? AbortSignal.timeout(EXEC_TIMEOUT_MS),
      maxBuffer: EXEC_MAX_BUFFER,
      env: this.environment(),
    });
  }

  async preflight(signal?: AbortSignal): Promise<void> {
    try {
      await this.exec(["--version"], undefined, signal);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;

      if (e.code === "ENOENT") {
        throw new MaisterError("PRECONDITION", `${this.bin} CLI not on PATH`, {
          cause: asError(err),
        });
      }

      throw new MaisterError(
        "PRECONDITION",
        `${this.bin} CLI preflight failed`,
        { cause: asError(err) },
      );
    }

    if (!this.remoteUrl) {
      throw new MaisterError("PRECONDITION", "remote not configured");
    }
  }

  abstract createOrUpdatePr(args: CreateOrUpdatePrArgs): Promise<PrResult>;

  protected failed(action: string, err: unknown): MaisterError {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const raw = (e.stderr ?? e.message ?? "").toString();

    return new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `${this.displayName} ${action} failed: ${scrub(raw, this.token).trim()}`,
      { cause: asError(err) },
    );
  }
}

export class GhCliAdapter extends CliPrAdapter {
  protected readonly bin = "gh";
  protected readonly tokenVar = providerTokenVar.github;
  protected readonly displayName = "gh";

  protected override get token(): string | undefined {
    return this.credential ?? configuredPrCredential("github");
  }

  protected override environment(): NodeJS.ProcessEnv {
    const { GH_DEBUG: _ghDebug, DEBUG: _debug, ...env } = super.environment();

    return { ...env, GH_PROMPT_DISABLED: "1" };
  }

  override async preflight(signal?: AbortSignal): Promise<void> {
    await super.preflight(signal);

    // This is a local credential lookup, including gh's stored login. Git
    // transport credentials are independent. Never log the command's stdout.
    try {
      await this.exec(
        ["auth", "token", "--hostname", "github.com"],
        undefined,
        signal,
      );
    } catch (err) {
      const error = err as { code?: unknown; stderr?: string };

      if (
        error.code === 1 &&
        /^no oauth token found for github\.com\s*$/i.test(error.stderr ?? "")
      )
        throw githubAuthRequired();
      throw this.failed("auth token", err);
    }
  }

  protected override failed(action: string, err: unknown): MaisterError {
    const error = err as { code?: unknown; stderr?: string };
    const stderr = error.stderr ?? "";

    if (error.code === 4 || /\bHTTP 401\b/.test(stderr))
      return githubAuthRequired();

    // execFile's error message includes argv, including the PR title/body.
    // Only the first diagnostic line from gh is suitable for the UI.
    const diagnostic = scrub(stripVTControlCharacters(stderr), this.token)
      .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "***")
      .trim()
      .split(/\r?\n/, 1)[0]
      ?.slice(0, 400);

    return new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `gh ${action} failed${diagnostic ? `: ${diagnostic}` : ""}`,
      { details: { reason: "github_cli_failed" } },
    );
  }

  async createOrUpdatePr(args: CreateOrUpdatePrArgs): Promise<PrResult> {
    assertSafeBranchRefs(args);

    let listOut: string;

    try {
      const { stdout } = await this.exec(
        [
          "pr",
          "list",
          ...(args.providerRepository
            ? ["--repo", args.providerRepository]
            : []),
          "--head",
          args.sourceBranch,
          "--base",
          args.targetBranch,
          "--state",
          "open",
          "--json",
          "url,number,baseRefName",
        ],
        args.repoPath,
        args.signal,
      );

      listOut = stdout;
    } catch (err) {
      throw this.failed("pr list", err);
    }

    const existing = parsePrList(listOut, args.targetBranch);

    if (existing) return existing;
    await args.beforeWrite?.();

    try {
      const { stdout } = await this.exec(
        [
          "pr",
          "create",
          ...(args.providerRepository
            ? ["--repo", args.providerRepository]
            : []),
          "--base",
          args.targetBranch,
          "--head",
          args.sourceBranch,
          `--title=${args.title}`,
          `--body=${args.body}`,
          ...(args.draft ? ["--draft"] : []),
        ],
        args.repoPath,
        args.signal,
      );

      return parseCreatedPrUrl(stdout);
    } catch (err) {
      throw this.failed("pr create", err);
    }
  }
}

function githubAuthRequired(): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "GitHub CLI needs valid credentials. Set GH_TOKEN in the MAIster web service or sign in with gh as the service user.",
    { details: { reason: "github_auth_required" } },
  );
}

export class GlabCliAdapter extends CliPrAdapter {
  protected readonly bin = "glab";
  protected readonly tokenVar = providerTokenVar.gitlab;
  protected readonly displayName = "glab";

  async createOrUpdatePr(args: CreateOrUpdatePrArgs): Promise<PrResult> {
    assertSafeBranchRefs(args);

    let listOut: string;

    try {
      const { stdout } = await this.exec(
        [
          "mr",
          "list",
          ...(args.providerRepository
            ? ["--repo", args.providerRepository]
            : []),
          "--source-branch",
          args.sourceBranch,
          "--target-branch",
          args.targetBranch,
          "--output",
          "json",
          "--end-of-options",
        ],
        args.repoPath,
        args.signal,
      );

      listOut = stdout;
    } catch (err) {
      throw this.failed("mr list", err);
    }

    const existing = parsePrList(listOut, args.targetBranch);

    if (existing) return existing;
    await args.beforeWrite?.();

    try {
      const { stdout } = await this.exec(
        [
          "mr",
          "create",
          ...(args.providerRepository
            ? ["--repo", args.providerRepository]
            : []),
          "--source-branch",
          args.sourceBranch,
          "--target-branch",
          args.targetBranch,
          "--title",
          args.title,
          "--description",
          args.body,
          ...(args.draft ? ["--draft"] : []),
          "--end-of-options",
        ],
        args.repoPath,
        args.signal,
      );

      return parseCreatedPrUrl(stdout);
    } catch (err) {
      throw this.failed("mr create", err);
    }
  }
}

// ---- Gitea REST adapter (gitea / gitverse) --------------------------------

type ParsedRemote = { apiBase: string; owner: string; repo: string };

// Derive {apiBase, owner, repo} from an scp-like or URL remote, reusing the
// scp/url forms deriveRepoName() relies on. owner = the path segment before the
// repo; apiBase = scheme+host (HTTPS for scp/host-only forms).
export function parseGiteaRemote(remoteUrl: string): ParsedRemote {
  const scp = /^[^/@]+@([^/:]+):(.+)$/.exec(remoteUrl);
  let host: string;
  let pathPart: string;

  if (scp) {
    host = scp[1];
    pathPart = scp[2];
  } else {
    const schemed =
      /^([a-z][a-z0-9+.-]*):\/\/(?:[^/@]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(
        remoteUrl,
      );

    if (!schemed) {
      throw new MaisterError(
        "PRECONDITION",
        "cannot derive API base from remote URL",
      );
    }
    host = schemed[2];
    pathPart = schemed[3];
  }

  const segments = pathPart
    .replace(/\.git$/, "")
    .split("/")
    .filter((s) => s.length > 0);

  if (segments.length < 2) {
    throw new MaisterError(
      "PRECONDITION",
      "cannot derive owner/repo from remote URL",
    );
  }

  const repo = segments[segments.length - 1];
  const owner = segments[segments.length - 2];

  // owner/repo are interpolated raw into the API URL — reject anything that is
  // not a single safe path segment (mirrors deriveRepoName in repo-source.ts) so
  // `.`/`..`/slashes/metacharacters can never traverse or inject into the path.
  for (const [label, segment] of [
    ["owner", owner],
    ["repo", repo],
  ] as const) {
    if (segment === "." || segment === ".." || !SAFE_SEGMENT.test(segment)) {
      throw new MaisterError(
        "PRECONDITION",
        `cannot derive a safe ${label} from remote URL`,
      );
    }
  }

  return { apiBase: `https://${host}`, owner, repo };
}

export class GiteaApiAdapter implements PrAdapter {
  private readonly tokenVar: string;

  constructor(
    private readonly remoteUrl: string | null | undefined,
    provider: "gitea" | "gitverse",
    private readonly logger?: PrAdapterLogger,
    private readonly credential?: string,
  ) {
    this.tokenVar = providerTokenVar[provider];
  }

  private get token(): string | undefined {
    return this.credential ?? (process.env[this.tokenVar] || undefined);
  }

  async preflight(): Promise<void> {
    if (!this.token) {
      throw new MaisterError("PRECONDITION", `${this.tokenVar} is not set`);
    }
    if (!this.remoteUrl) {
      throw new MaisterError("PRECONDITION", "remote not configured");
    }
    parseGiteaRemote(this.remoteUrl);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token ?? ""}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  async createOrUpdatePr(args: CreateOrUpdatePrArgs): Promise<PrResult> {
    assertSafeBranchRefs(args);

    if (!this.remoteUrl) {
      throw new MaisterError("PRECONDITION", "remote not configured");
    }

    const { apiBase, owner, repo } = parseGiteaRemote(this.remoteUrl);
    const collection = `${apiBase}/api/v1/repos/${owner}/${repo}/pulls`;

    const existing = await this.findOpenPr(collection, args);

    if (existing) return existing;

    await args.beforeWrite?.();

    return this.createPr(collection, args);
  }

  private async findOpenPr(
    collection: string,
    args: CreateOrUpdatePrArgs,
  ): Promise<PrResult | null> {
    // Gitea's pulls list has no head/base filter, so page through open PRs
    // (limit=50 is the per-page max) until the (head,base) match is found or a
    // short page signals the last one. A single page can otherwise omit the
    // existing PR on a busy repo, causing a duplicate POST.
    //
    // PR_LOOKUP_MAX_PAGES bounds a server that never returns a short page (a bug
    // or a hostile remote would otherwise loop forever, with no per-request
    // timeout on `fetch`). 200 pages = 10k open PRs, far beyond any real repo.
    // Hitting the cap is a REFUSAL, not a "no match": returning null here would
    // re-open the duplicate-POST gap pagination closes, so we throw instead of
    // creating blind — Promote stays retryable, no duplicate.
    const limit = 50;

    for (let page = 1; page <= PR_LOOKUP_MAX_PAGES; page++) {
      const url = `${collection}?state=open&limit=${limit}&page=${page}`;
      const res = await this.fetchOrThrow(
        url,
        { method: "GET", signal: args.signal },
        "PR lookup",
      );
      const list = (await res.json()) as unknown;

      if (!Array.isArray(list)) return null;

      for (const item of list) {
        const pr = item as {
          html_url?: string;
          number?: number;
          head?: { ref?: string };
          base?: { ref?: string };
        };

        if (
          pr.head?.ref === args.sourceBranch &&
          pr.base?.ref === args.targetBranch &&
          typeof pr.html_url === "string" &&
          typeof pr.number === "number"
        ) {
          return { url: pr.html_url, number: pr.number, reused: true };
        }
      }

      if (list.length < limit) return null;
    }

    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `Gitea PR lookup exceeded ${PR_LOOKUP_MAX_PAGES} pages without a conclusive result — refusing to create to avoid a duplicate`,
    );
  }

  private async createPr(
    collection: string,
    args: CreateOrUpdatePrArgs,
  ): Promise<PrResult> {
    const res = await this.fetchOrThrow(
      collection,
      {
        method: "POST",
        signal: args.signal,
        headers: this.headers(),
        body: JSON.stringify({
          head: args.sourceBranch,
          base: args.targetBranch,
          // The Gitea family's API has no draft flag: a `WIP: ` title is its
          // draft convention, and `findOpenPr` matches head/base only, so the
          // PR is still found on the next call.
          title: args.draft ? `WIP: ${args.title}` : args.title,
          body: args.body,
        }),
      },
      "PR create",
    );

    const created = (await res.json()) as {
      html_url?: string;
      number?: number;
    };

    if (
      typeof created.html_url !== "string" ||
      typeof created.number !== "number"
    ) {
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "PR create returned an unexpected payload",
      );
    }

    return { url: created.html_url, number: created.number, reused: false };
  }

  private async fetchOrThrow(
    url: string,
    init: RequestInit,
    action: string,
  ): Promise<Response> {
    const merged: RequestInit = {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(EXEC_TIMEOUT_MS),
      headers: { ...this.headers(), ...(init.headers ?? {}) },
    };

    let res: Response;

    try {
      res = await fetch(url, merged);
    } catch (err) {
      // Network-level failure is transient/retryable.
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        `Gitea ${action} request failed: ${scrub(asError(err).message, this.token)}`,
        { cause: asError(err) },
      );
    }

    if (res.ok) return res;

    // 5xx is transient (retryable); 4xx is a config error.
    const code = res.status >= 500 ? "EXECUTOR_UNAVAILABLE" : "PRECONDITION";

    this.logger?.warn(
      { action, status: res.status },
      "Gitea PR API non-2xx response",
    );

    throw new MaisterError(
      code,
      `Gitea ${action} failed with HTTP ${res.status}`,
    );
  }
}

// ---- shared parsing -------------------------------------------------------

type PrListEntry = {
  url?: string;
  web_url?: string;
  number?: number;
  iid?: number;
  // gh `--json baseRefName`; glab `targetBranch`/`target_branch`.
  baseRefName?: string;
  targetBranch?: string;
  target_branch?: string;
};

function entryBaseRef(entry: PrListEntry): string | undefined {
  return entry.baseRefName ?? entry.targetBranch ?? entry.target_branch;
}

// gh/glab `list --json`/`--output json` emit a JSON array; the first entry whose
// base/target ref matches `expectedBase` (or carries no base field — the CLI was
// already scoped via --base/--target-branch) identifies the existing PR/MR.
//
// Defense-in-depth for the wrong-target bug: `gh pr list --head` / `glab mr list
// --source-branch` return PRs for the head REGARDLESS of base, so an entry that
// reports a base which differs from `expectedBase` is NOT the PR we want and is
// skipped — never blindly returned as list[0].
function parsePrList(stdout: string, expectedBase: string): PrResult | null {
  const trimmed = stdout.trim();

  if (!trimmed) return null;

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { items?: unknown[] }).items;

  if (!Array.isArray(list) || list.length === 0) return null;

  for (const item of list) {
    const entry = item as PrListEntry;
    const base = entryBaseRef(entry);

    // Reject an entry that explicitly reports a different base; tolerate an
    // entry with no base field (the CLI --base/--target-branch already scoped).
    if (base !== undefined && base !== expectedBase) continue;

    const url = entry.url ?? entry.web_url;
    const number = entry.number ?? entry.iid;

    if (typeof url === "string" && typeof number === "number") {
      return { url, number, reused: true };
    }
  }

  return null;
}

// `gh pr create` / `glab mr create` print the created PR/MR URL on stdout. The
// PR number is the trailing path segment.
function parseCreatedPrUrl(stdout: string): PrResult {
  const url = (stdout.match(/https?:\/\/\S+/)?.[0] ?? "").trim();
  const match = url.match(/(\d+)\/?$/);

  if (!url || !match) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "could not parse the created PR URL from CLI output",
    );
  }

  return { url, number: Number.parseInt(match[1], 10), reused: false };
}

// ---- dispatch -------------------------------------------------------------

export function selectPrAdapter(
  provider: Provider,
  ctx: PrAdapterContext,
): PrAdapter {
  switch (provider) {
    case "github":
      return new GhCliAdapter(ctx.remoteUrl, ctx.logger, ctx.credential);
    case "gitlab":
      return new GlabCliAdapter(ctx.remoteUrl, ctx.logger, ctx.credential);
    case "gitea":
      return new GiteaApiAdapter(
        ctx.remoteUrl,
        "gitea",
        ctx.logger,
        ctx.credential,
      );
    case "gitverse":
      return new GiteaApiAdapter(
        ctx.remoteUrl,
        "gitverse",
        ctx.logger,
        ctx.credential,
      );
    default:
      throw new MaisterError(
        "PRECONDITION",
        "PR mode unsupported for provider",
      );
  }
}
