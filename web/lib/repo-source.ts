import "server-only";

import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
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

export async function assertGitAvailable(): Promise<void> {
  try {
    await execFileAsync("git", ["--version"], gitExecOptions(GIT_TIMEOUT_MS));
  } catch (err) {
    throw new MaisterError("PRECONDITION", "git not found on host", {
      cause: asError(err),
    });
  }
}

export async function cloneRepo(opts: {
  url: string;
  target: string;
  signal?: AbortSignal;
}): Promise<void> {
  log.debug(
    { url: redactUrl(opts.url), target: opts.target },
    "git clone start",
  );

  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["clone", opts.url, opts.target],
      gitExecOptions(CLONE_TIMEOUT_MS, opts.signal),
    );

    log.debug(
      { stdout, stderr: redactUrl(stderr), target: opts.target },
      "git clone done",
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const stderrText = (e.stderr ?? e.message ?? "").toString();

    throw new MaisterError(
      "PRECONDITION",
      `git clone failed: ${redactUrl(stderrText)}`,
      { cause: asError(err) },
    );
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
    await execFileAsync(
      "git",
      ["-C", dir, "init"],
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

function validateUrl(url: string): void {
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
      await cloneRepo({ url: body.repoUrl, target: dir });
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
