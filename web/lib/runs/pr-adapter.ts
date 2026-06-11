import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import pino from "pino";

import { MaisterError } from "@/lib/errors";
import { type Provider, redactUrl } from "@/lib/repo-source";
import { branchNameSchema } from "@/lib/worktree";

const execFileAsync = promisify(execFile);

const log = pino({
  name: "pr-adapter",
  level: process.env.LOG_LEVEL ?? "info",
});

const EXEC_TIMEOUT_MS = 60_000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

// Safety bound on the Gitea open-PR pagination sweep (see findOpenPr).
const PR_LOOKUP_MAX_PAGES = 200;

// A single safe URL path segment (mirrors repo-source's deriveRepoName guard).
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

export type CreateOrUpdatePrArgs = {
  repoPath: string;
  remote: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  body: string;
};

export type PrResult = { url: string; number: number };

export interface PrAdapter {
  preflight(): Promise<void>;
  createOrUpdatePr(args: CreateOrUpdatePrArgs): Promise<PrResult>;
}

export type PrAdapterContext = { remoteUrl?: string | null };

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// Scrub anything secret-bearing (creds in URLs + the active provider token)
// from a string that may surface in a thrown message or a log line.
function scrub(text: string, token: string | undefined): string {
  let out = redactUrl(text);

  if (token) out = out.split(token).join("***");

  return out;
}

function execEnv(
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
    const parsed = branchNameSchema.safeParse(value);

    if (!parsed.success) {
      throw new MaisterError(
        "PRECONDITION",
        `unsafe ${label} for pull request: ${parsed.error.issues[0]?.message ?? "invalid branch name"}`,
      );
    }
  }
}

// ---- CLI adapters (github / gitlab) ---------------------------------------

abstract class CliPrAdapter implements PrAdapter {
  protected abstract readonly bin: string;
  protected abstract readonly tokenVar: string;
  protected abstract readonly displayName: string;

  constructor(protected readonly remoteUrl: string | null | undefined) {}

  protected get token(): string | undefined {
    return process.env[this.tokenVar] || undefined;
  }

  // gh/glab infer the repository from the process CWD. A PR promotion MUST run
  // against the target project's checkout (args.repoPath), never the MAIster
  // server's own working directory — so every list/create call passes cwd. The
  // repo-independent `--version` preflight passes none.
  protected async exec(
    args: readonly string[],
    cwd?: string,
  ): Promise<{ stdout: string; stderr: string }> {
    log.debug({ bin: this.bin, cwd }, "pr cli exec");

    return execFileAsync(this.bin, args, {
      cwd,
      signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
      maxBuffer: EXEC_MAX_BUFFER,
      env: execEnv(this.token, this.tokenVar),
    });
  }

  async preflight(): Promise<void> {
    try {
      await this.exec(["--version"]);
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
  protected readonly tokenVar = "GH_TOKEN";
  protected readonly displayName = "gh";

  async createOrUpdatePr(args: CreateOrUpdatePrArgs): Promise<PrResult> {
    assertSafeBranchRefs(args);

    let listOut: string;

    try {
      const { stdout } = await this.exec(
        [
          "pr",
          "list",
          "--head",
          args.sourceBranch,
          "--base",
          args.targetBranch,
          "--state",
          "open",
          "--json",
          "url,number,baseRefName",
          "--end-of-options",
        ],
        args.repoPath,
      );

      listOut = stdout;
    } catch (err) {
      throw this.failed("pr list", err);
    }

    const existing = parsePrList(listOut, args.targetBranch);

    if (existing) return existing;

    try {
      const { stdout } = await this.exec(
        [
          "pr",
          "create",
          "--base",
          args.targetBranch,
          "--head",
          args.sourceBranch,
          "--title",
          args.title,
          "--body",
          args.body,
          "--end-of-options",
        ],
        args.repoPath,
      );

      return parseCreatedPrUrl(stdout);
    } catch (err) {
      throw this.failed("pr create", err);
    }
  }
}

export class GlabCliAdapter extends CliPrAdapter {
  protected readonly bin = "glab";
  protected readonly tokenVar = "GITLAB_TOKEN";
  protected readonly displayName = "glab";

  async createOrUpdatePr(args: CreateOrUpdatePrArgs): Promise<PrResult> {
    assertSafeBranchRefs(args);

    let listOut: string;

    try {
      const { stdout } = await this.exec(
        [
          "mr",
          "list",
          "--source-branch",
          args.sourceBranch,
          "--target-branch",
          args.targetBranch,
          "--output",
          "json",
          "--end-of-options",
        ],
        args.repoPath,
      );

      listOut = stdout;
    } catch (err) {
      throw this.failed("mr list", err);
    }

    const existing = parsePrList(listOut, args.targetBranch);

    if (existing) return existing;

    try {
      const { stdout } = await this.exec(
        [
          "mr",
          "create",
          "--source-branch",
          args.sourceBranch,
          "--target-branch",
          args.targetBranch,
          "--title",
          args.title,
          "--description",
          args.body,
          "--end-of-options",
        ],
        args.repoPath,
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
  ) {
    this.tokenVar = provider === "gitverse" ? "GITVERSE_TOKEN" : "GITEA_TOKEN";
  }

  private get token(): string | undefined {
    return process.env[this.tokenVar] || undefined;
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
      const res = await this.fetchOrThrow(url, { method: "GET" }, "PR lookup");
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
          return { url: pr.html_url, number: pr.number };
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
        headers: this.headers(),
        body: JSON.stringify({
          head: args.sourceBranch,
          base: args.targetBranch,
          title: args.title,
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

    return { url: created.html_url, number: created.number };
  }

  private async fetchOrThrow(
    url: string,
    init: RequestInit,
    action: string,
  ): Promise<Response> {
    const merged: RequestInit = {
      ...init,
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

    log.warn({ action, status: res.status }, "Gitea PR API non-2xx response");

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
      return { url, number };
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

  return { url, number: Number.parseInt(match[1], 10) };
}

// ---- dispatch -------------------------------------------------------------

export function selectPrAdapter(
  provider: Provider,
  ctx: PrAdapterContext,
): PrAdapter {
  switch (provider) {
    case "github":
      return new GhCliAdapter(ctx.remoteUrl);
    case "gitlab":
      return new GlabCliAdapter(ctx.remoteUrl);
    case "gitea":
      return new GiteaApiAdapter(ctx.remoteUrl, "gitea");
    case "gitverse":
      return new GiteaApiAdapter(ctx.remoteUrl, "gitverse");
    default:
      throw new MaisterError(
        "PRECONDITION",
        "PR mode unsupported for provider",
      );
  }
}
