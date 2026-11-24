import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import type { WorkspaceSourceRefPage } from "../../runtime/workspace-prepare";

import { GIT_OBJECT_ID } from "../../runtime/wait-head";
import { isWorkspaceSourceRef, workspaceEvidenceDigest } from "../../runtime/workspace-prepare";

import { SupervisorError } from "./types";

const exec = promisify(execFile);
const SOURCE_READ_TIMEOUT_MS = 8_000;
const WORKSPACE_GIT_TIMEOUT_MS = 60_000;
const GIT_ENVIRONMENT = [
  "PATH",
  "HOME",
  "SSH_AUTH_SOCK",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;
const OpaqueId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const UpstreamRef = z.string().refine(isWorkspaceSourceRef);

export const WorkspaceSourceQuery = z
  .object({ repositoryId: OpaqueId, ref: UpstreamRef })
  .strict();
export const WorkspaceRefListingQuery = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
export const WorkspaceRepositoryId = OpaqueId;

export async function executeWorkspaceGit(
  args: readonly string[],
  timeout = WORKSPACE_GIT_TIMEOUT_MS,
): Promise<string> {
  return (await executeWorkspaceGitBytes(args, { timeout }))
    .toString("utf8")
    .trim();
}

export async function executeWorkspaceGitBytes(
  args: readonly string[],
  options: Readonly<{ timeout?: number; indexFile?: string }> = {},
): Promise<Buffer> {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0" };
  if (options.indexFile !== undefined) env.GIT_INDEX_FILE = options.indexFile;
  for (const name of GIT_ENVIRONMENT) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const result = await exec(
    "git",
    [
      "-c",
      "protocol.ext.allow=never",
      "-c",
      "http.followRedirects=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    {
      env,
      timeout: options.timeout ?? WORKSPACE_GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      encoding: "buffer",
    },
  );

  return result.stdout;
}

function isApprovedSourceAddress(value: string): boolean {
  if (isAbsolute(value)) return true;
  const url = URL.parse(value);

  return (
    url !== null &&
    (url.protocol === "https:" || url.protocol === "ssh:") &&
    !url.password &&
    !url.search &&
    !url.hash &&
    (url.protocol !== "https:" || !url.username)
  );
}

/** Repository addresses are operator configuration and are never taken from a request. */
export function configuredWorkspaceSources(): ReadonlyMap<string, string> {
  const configured = process.env.MAISTER_WORKSPACE_REPOSITORIES;
  if (!configured) return new Map();

  try {
    const sources = z
      .record(
        OpaqueId,
        z.string().min(1).max(4_096).refine(isApprovedSourceAddress),
      )
      .parse(JSON.parse(configured));

    return new Map(Object.entries(sources));
  } catch {
    throw new SupervisorError(
      "PRECONDITION",
      "MAISTER_WORKSPACE_REPOSITORIES must map approved repository IDs to credential-free Git addresses",
      { details: { reason: "invalid_request" } },
    );
  }
}

export async function observeWorkspaceSource(
  source: string,
  ref: string,
): Promise<string> {
  let output: string;
  try {
    output = await executeWorkspaceGit(
      ["ls-remote", "--refs", "--heads", "--", source, ref],
      SOURCE_READ_TIMEOUT_MS,
    );
  } catch {
    throw new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      "The approved Git source did not return a revision",
      { details: { reason: "source_commit_unavailable" } },
    );
  }
  const [commit, advertisedRef] = output.split("\t");
  if (!GIT_OBJECT_ID.test(commit) || advertisedRef !== ref)
    throw new SupervisorError(
      "PRECONDITION",
      "The approved Git source does not advertise this ref",
      { details: { reason: "source_ref_unapproved" } },
    );

  return commit;
}

export async function listWorkspaceSourceRefs(
  source: string,
  scope: Readonly<{ repositoryId: string; hostKey: string; cursor?: string }>,
): Promise<WorkspaceSourceRefPage> {
  const { cursor } = scope;
  const domain = `${workspaceEvidenceDigest([scope.hostKey, scope.repositoryId])}:`;
  let after: string | null = null;
  if (cursor !== undefined) {
    const decoded = Buffer.from(cursor, "base64url");
    const position = decoded.toString("utf8");
    after = position.slice(domain.length);
    if (
      decoded.toString("base64url") !== cursor ||
      !position.startsWith(domain) ||
      !UpstreamRef.safeParse(after).success
    )
      throw new SupervisorError(
        "PRECONDITION",
        "Invalid repository ref cursor",
        {
          details: { reason: "invalid_request" },
        },
      );
  }
  let advertised: string;
  try {
    advertised = await executeWorkspaceGit(
      ["ls-remote", "--symref", "--", source, "HEAD", "refs/heads/*"],
      SOURCE_READ_TIMEOUT_MS,
    );
  } catch {
    throw new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      "The approved Git source did not return its refs",
      {
        details: { reason: "source_commit_unavailable" },
      },
    );
  }
  const all: string[] = [];
  let defaultRef: string | null = null;
  for (const entry of advertised.split("\n")) {
    const [object, ref] = entry.split("\t");
    if (ref === "HEAD" && object.startsWith("ref: ")) {
      const parsed = UpstreamRef.safeParse(object.slice(5));
      if (parsed.success) defaultRef = parsed.data;
    } else if (
      GIT_OBJECT_ID.test(object) &&
      UpstreamRef.safeParse(ref).success
    ) {
      all.push(ref);
    }
  }
  const remaining = [...new Set(all)]
    .sort()
    .filter((ref) => after === null || ref > after);
  const refs = remaining.slice(0, 100);
  const last = refs.at(-1);

  return {
    refs,
    defaultRef: defaultRef && all.includes(defaultRef) ? defaultRef : null,
    nextCursor:
      remaining.length > refs.length && last
        ? Buffer.from(domain + last).toString("base64url")
        : null,
  };
}
