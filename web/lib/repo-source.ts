import "server-only";

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { promisify } from "node:util";

import pino from "pino";
import { z } from "zod";

import { reposRoot } from "@/lib/instance-config";
import { MaisterError } from "@/lib/errors";
import { deriveRepoNameSafe } from "@/lib/repo-name";

const execFileAsync = promisify(execFile);

const log = pino({
  name: "repo-source",
  level: process.env.LOG_LEVEL ?? "info",
});

const GIT_TIMEOUT_MS = 60_000;
const CLONE_TIMEOUT_MS = 120_000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;
// ADR-093: cap the redacted stderr carried to the client as advisory `detail`.
const MAX_CLONE_DETAIL = 4096;

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const URL_SCHEME_ALLOWLIST = ["https://", "http://", "ssh://", "file://"];

export type Provider = "github" | "gitlab" | "gitea" | "gitverse" | "generic";
export type GitStatus = "remote" | "no-remote" | "initialized";
export type ResolvedSource = {
  dir: string;
  repoUrl: string | null;
  provider: Provider | null;
  gitStatus: GitStatus;
  clonedByUs: boolean;
  // ADR-093: the new-empty path created this dir; the route cleans it up on a
  // registration failure (mirrors clonedByUs for the clone path).
  createdByUs: boolean;
};

const absolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) => isAbsolute(p) && !p.split(sep).includes(".."),
    "must be absolute with no '..' segments",
  );

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// Hardened env so a missing credential / unknown host key fails fast instead of
// hanging on an interactive prompt.
function gitExecOptions(timeoutMs: number, signal?: AbortSignal) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  return {
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    maxBuffer: EXEC_MAX_BUFFER,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    },
  };
}

// Extract the host from both scp-like (git@host:org/repo) and URL forms.
function parseHost(url: string): string | null {
  const scp = /^[^/@]+@([^/:]+):/.exec(url);

  if (scp) return scp[1].toLowerCase();

  const schemed = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]+@)?([^/:]+)/i.exec(url);

  if (schemed) return schemed[1].toLowerCase();

  return null;
}

export function detectProvider(url: string): Provider {
  const host = parseHost(url);

  if (!host) return "generic";

  if (host === "github.com") return "github";
  if (host.includes("gitlab")) return "gitlab";
  if (host === "gitverse.ru") return "gitverse";
  if (host.includes("gitea")) return "gitea";

  return "generic";
}

// Thin throwing wrapper over the client-safe `deriveRepoNameSafe` — keeps the
// server contract (PRECONDITION on an underivable name) while single-sourcing
// the regex/segment logic in the client-importable `repo-name.ts`.
export function deriveRepoName(url: string): string {
  const name = deriveRepoNameSafe(url);

  if (name === null) {
    throw new MaisterError(
      "PRECONDITION",
      "cannot derive a safe repo name from URL",
    );
  }

  return name;
}

// Strip `://user:password@` credentials from anywhere in the string — git
// stderr embeds the full URL mid-message, so this must NOT be anchored.
export function redactUrl(url: string): string {
  return url.replace(
    /([a-z][a-z0-9+.-]*:\/\/[^/:@\s]+):[^/@\s]*@/gi,
    "$1:***@",
  );
}

// ADR-093: classify a (redacted) git stderr blob into an advisory reason. The
// UI maps the reason to a specific remediation; the thrown error KEEPS
// code: "PRECONDITION". Order matters — NOT_FOUND is checked before SSH_AUTH so
// a not-found-over-SSH ("Repository not found … Could not read from remote
// repository") is not swallowed by the SSH_AUTH "could not read" marker.
export type CloneFailureReason =
  | "SSH_AUTH"
  | "SSH_HOSTKEY"
  | "HTTPS_AUTH"
  | "NOT_FOUND"
  | "NETWORK"
  | "UNKNOWN";

export function classifyGitError(stderr: string): CloneFailureReason {
  const s = stderr.toLowerCase();

  if (
    s.includes("host key verification failed") ||
    s.includes("remote host identification has changed")
  ) {
    return "SSH_HOSTKEY";
  }
  if (
    s.includes("authentication failed") ||
    s.includes("could not read username") ||
    s.includes("could not read password") ||
    s.includes("terminal prompts disabled") ||
    s.includes("invalid username or password") ||
    s.includes("403")
  ) {
    return "HTTPS_AUTH";
  }
  if (
    s.includes("repository not found") ||
    s.includes("does not exist") ||
    s.includes("404")
  ) {
    return "NOT_FOUND";
  }
  if (
    s.includes("permission denied (publickey)") ||
    s.includes("could not read from remote repository")
  ) {
    return "SSH_AUTH";
  }
  if (
    s.includes("could not resolve host") ||
    s.includes("connection timed out") ||
    s.includes("connection refused") ||
    s.includes("network is unreachable") ||
    s.includes("unable to access") ||
    s.includes("timed out")
  ) {
    return "NETWORK";
  }

  return "UNKNOWN";
}

export async function assertGitAvailable(): Promise<void> {
  try {
    await execFileAsync("git", ["--version"], gitExecOptions(GIT_TIMEOUT_MS));
  } catch (err) {
    throw new MaisterError("PRECONDITION", "git not found on host", {
      cause: asError(err),
    });
  }
}

// ADR-093: best-effort GitHub auth via the host `gh` CLI. classifyGhResult is
// the pure core; runGhAuthToken does the exec. A github.com http(s) clone with
// no explicit token auto-uses the gh token when the operator is logged in.
export function classifyGhResult(result: {
  ok: boolean;
  token: string;
  notFound: boolean;
}): "ok" | "unauthed" | "absent" {
  if (result.notFound) return "absent";

  return result.ok && result.token.trim() ? "ok" : "unauthed";
}

async function runGhAuthToken(): Promise<{
  ok: boolean;
  token: string;
  notFound: boolean;
}> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["auth", "token"],
      gitExecOptions(GIT_TIMEOUT_MS),
    );

    return { ok: true, token: stdout, notFound: false };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;

    return { ok: false, token: "", notFound: e.code === "ENOENT" };
  }
}

export async function detectGhAuth(): Promise<"ok" | "unauthed" | "absent"> {
  return classifyGhResult(await runGhAuthToken());
}

async function ghAuthToken(): Promise<string | null> {
  const result = await runGhAuthToken();

  return classifyGhResult(result) === "ok" ? result.token.trim() : null;
}

export async function cloneRepo(opts: {
  url: string;
  target: string;
  signal?: AbortSignal;
  token?: string;
}): Promise<void> {
  log.debug(
    {
      url: redactUrl(opts.url),
      target: opts.target,
      token: opts.token ? "present" : "absent",
    },
    "git clone start",
  );

  // ADR-093: an optional one-off HTTPS token is answered to git's
  // Username/Password prompts via a transient askpass script — the token is
  // NEVER in argv, on disk as a key, in the clone's .git/config, or logged.
  const isHttp = /^https?:\/\//i.test(opts.url);
  // ADR-093: explicit token wins; otherwise a github.com http(s) clone tries the
  // host `gh` token (best-effort — absent/unauthed just proceeds tokenless).
  let effectiveToken = opts.token;

  if (!effectiveToken && isHttp && detectProvider(opts.url) === "github") {
    effectiveToken = (await ghAuthToken()) ?? undefined;
  }

  const useToken = Boolean(effectiveToken) && isHttp;
  let askpassDir: string | undefined;
  const base = gitExecOptions(CLONE_TIMEOUT_MS, opts.signal);
  let env: NodeJS.ProcessEnv = base.env;

  try {
    if (useToken) {
      askpassDir = await mkdtemp(join(tmpdir(), "maister-askpass-"));
      const script = join(askpassDir, "askpass.sh");

      // The script prints the token for BOTH the Username and Password prompts
      // (works for gitverse token-as-userinfo and GitHub token-in-either-field).
      await writeFile(script, `#!/bin/sh\nprintf '%s' "$MAISTER_GIT_TOKEN"\n`, {
        mode: 0o700,
      });
      env = {
        ...base.env,
        GIT_ASKPASS: script,
        MAISTER_GIT_TOKEN: effectiveToken,
        GIT_TERMINAL_PROMPT: "0",
      };
    }

    const { stdout, stderr } = await execFileAsync(
      "git",
      ["clone", opts.url, opts.target],
      { ...base, env },
    );

    log.debug(
      { stdout, stderr: redactUrl(stderr), target: opts.target },
      "git clone done",
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const stderrText = (e.stderr ?? e.message ?? "").toString();
    const redacted = redactUrl(stderrText);
    const reason = classifyGitError(redacted);

    log.debug({ reason }, "git clone failed — classified");

    throw new MaisterError("PRECONDITION", `git clone failed: ${redacted}`, {
      cause: asError(err),
      details: { reason, detail: redacted.slice(0, MAX_CLONE_DETAIL) },
    });
  } finally {
    if (askpassDir) {
      await rm(askpassDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function readRemoteOrigin(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", dir, "remote", "get-url", "origin"],
      gitExecOptions(GIT_TIMEOUT_MS),
    );

    return stdout.trim();
  } catch {
    return null;
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", dir, "rev-parse", "--is-inside-work-tree"],
      gitExecOptions(GIT_TIMEOUT_MS),
    );

    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function gitInit(dir: string): Promise<void> {
  try {
    // ADR-093: force the initial branch to "main" so a repo we create matches
    // the DB-default `main_branch` ("main"). Without `-b`, the branch follows
    // the host's `init.defaultBranch` (often "master" when unset), which would
    // make the persist-config "HEAD on main_branch" precondition fail on a
    // new-empty project — the primary persist scenario.
    await execFileAsync(
      "git",
      ["-C", dir, "init", "-b", "main"],
      gitExecOptions(GIT_TIMEOUT_MS),
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const stderrText = (e.stderr ?? e.message ?? "").toString();

    throw new MaisterError(
      "PRECONDITION",
      `git init failed: ${stderrText.trim()}`,
      { cause: asError(err) },
    );
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);

    return true;
  } catch {
    return false;
  }
}

// ADR-093: reused by git-remotes (remote url scheme allow-list). Cred-bearing
// remotes are accepted (host-ambient auth) — callers redact for display/storage.
export function validateUrl(url: string): void {
  const isScp = /^[^/@]+@[^/:]+:/.test(url);
  const isSchemed = URL_SCHEME_ALLOWLIST.some((s) => url.startsWith(s));

  if (!isScp && !isSchemed) {
    throw new MaisterError(
      "PRECONDITION",
      "repoUrl scheme not allowed (use https, http, ssh, scp git@host:..., or file)",
    );
  }
}

function resolveDir(reposRootDir: string, nameOrPath: string): string {
  if (isAbsolute(nameOrPath)) {
    const parsed = absolutePathSchema.safeParse(nameOrPath);

    if (!parsed.success) {
      throw new MaisterError(
        "PRECONDITION",
        `invalid target path: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }

    return parsed.data;
  }

  if (
    !SAFE_SEGMENT.test(nameOrPath) ||
    nameOrPath === "." ||
    nameOrPath === ".."
  ) {
    throw new MaisterError(
      "PRECONDITION",
      "target must be a single safe path segment (^[A-Za-z0-9._-]+$)",
    );
  }

  return join(reposRootDir, nameOrPath);
}

export async function resolveProjectSource(body: {
  repoUrl?: string;
  target?: string;
  mode?: "clone" | "existing" | "new";
  token?: string;
}): Promise<ResolvedSource> {
  const reposRootDir = reposRoot();

  await assertGitAvailable();

  if (body.repoUrl) {
    validateUrl(body.repoUrl);

    const name = body.target ?? deriveRepoName(body.repoUrl);
    const dir = resolveDir(reposRootDir, name);

    if (await pathExists(dir)) {
      throw new MaisterError(
        "PRECONDITION",
        "target path already exists — supply an override (target)",
      );
    }

    await mkdir(reposRootDir, { recursive: true });

    try {
      await cloneRepo({ url: body.repoUrl, target: dir, token: body.token });
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => {}); // we created it; safe to remove
      throw err;
    }

    return {
      dir,
      repoUrl: body.repoUrl,
      provider: detectProvider(body.repoUrl),
      gitStatus: "remote",
      clonedByUs: true,
      createdByUs: false,
    };
  }

  if (!body.target) {
    throw new MaisterError(
      "PRECONDITION",
      "target is required when no repoUrl is given",
    );
  }

  const dir = resolveDir(reposRootDir, body.target);

  if (!(await pathExists(dir))) {
    // ADR-093: greenfield onboarding — ONLY an explicit mode="new" creates the
    // directory (never on a typo'd existing-repo path). The route's deferred
    // gitInit turns it into a repo after the registration commits.
    if (body.mode === "new") {
      await mkdir(dir, { recursive: true });

      return {
        dir,
        repoUrl: null,
        provider: null,
        gitStatus: "initialized",
        clonedByUs: false,
        createdByUs: true,
      };
    }

    throw new MaisterError("PRECONDITION", "directory not found");
  }

  if (!(await isGitRepo(dir))) {
    // Defer `git init` to the route — it must not mutate the operator's
    // directory until the manifest is validated and the registration is
    // otherwise committed. gitStatus "initialized" signals the route to init.
    return {
      dir,
      repoUrl: null,
      provider: null,
      gitStatus: "initialized",
      clonedByUs: false,
      createdByUs: false,
    };
  }

  const remote = await readRemoteOrigin(dir);
  const provider = remote ? detectProvider(remote) : null;

  return {
    dir,
    repoUrl: remote,
    provider,
    gitStatus: remote ? "remote" : "no-remote",
    clonedByUs: false,
    createdByUs: false,
  };
}
