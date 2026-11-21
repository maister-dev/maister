export type WorkspacePublicationTarget = {
  remote: string;
  headRef: string;
};

export type WorkspacePublicationRequest = WorkspacePublicationTarget &
  (
    | { action: "inspect" }
    | { action: "evidence" }
    | {
        action: "push";
        expectedHead: string;
        expectedRemoteHead: string | null;
        repoIdentity: string;
      }
    | {
        action: "open_pr";
        expectedHead: string;
        repoIdentity: string;
        baseRef: string;
        title: string;
        body: string;
        draft: boolean;
        credential?: string;
      }
  );

export type WorkspaceEvidenceFile = {
  path: string;
  oldPath?: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
};

export type WorkspacePublicationSnapshot = {
  headSha: string;
  remoteHeadSha: string | null;
  repoIdentity: string;
  pullRequest?: { url: string; number: number; reused: boolean };
  evidence?: {
    baseSha: string;
    clean: boolean;
    files: WorkspaceEvidenceFile[];
  };
};

/** Repository identity without credentials, for comparing an observed origin to its configured source. */
export function normalizePublicationOrigin(remote: string): string | null {
  if (remote.startsWith("/")) return remote;
  const scp = remote.includes("://")
    ? null
    : /^(?:[^@/:]+@)?([A-Za-z0-9.-]+):([^\s]+)$/.exec(remote);

  if (scp) return `${scp[1].toLowerCase()}/${scp[2].replace(/\.git$/, "")}`;
  let parsed: URL;

  try {
    parsed = new URL(remote);
  } catch {
    return null;
  }
  if (
    !["https:", "http:", "ssh:", "git:", "file:"].includes(parsed.protocol) ||
    parsed.search ||
    parsed.hash
  )
    return null;

  return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\.git$/, "")}`;
}
