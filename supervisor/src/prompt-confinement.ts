import path from "node:path";
import { fileURLToPath } from "node:url";

// Defense-in-depth (ADR-041 trust boundary): the web tier already confines the
// resource URIs it assembles, but the supervisor is a SEPARATE process that may
// run on a different host and accept prompts from any caller. So it re-validates
// every content-block file reference against roots IT controls (bound to the
// session at creation), never trusting the request. A `resource_link` is a pure
// pointer the agent will READ → it MUST be a `file:` URI inside the sandbox; a
// remote scheme (http/ssh/…) is rejected outright. A `resource` block may carry
// inline content under a non-file logical uri → that is not a filesystem read
// and is left alone; only its `file:` uris are confined.

export type ConfinementRoots = {
  worktreePath: string;
  /** Project repo (file_path attachments may reference repo-absolute paths). */
  repoPath?: string;
  /** The run's `.maister/<slug>/runs/<runId>` dir — covers uploaded files. */
  runDir: string;
  /**
   * M36 Phase 5 (ADR-097): the SOLE filesystem root for a project-less
   * local-package assistant session (the local-package working dir). When set,
   * it REPLACES worktree ∪ repo as the allow-set (the run dir stays allowed for
   * uploaded files); a `file:` URI outside it is rejected.
   */
  confineRoot?: string;
};

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);

  return (
    relative.length === 0 ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** Resolve a `file:` URI to its filesystem path, or null for any other scheme. */
function fileUriToPath(uri: string): string | null {
  let parsed: URL;

  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== "file:") return null;

  try {
    return fileURLToPath(parsed);
  } catch {
    return null;
  }
}

/**
 * Return the first confinement violation message for a prompt's content blocks,
 * or null when every block is in-bounds. Pure — exported for the supervisor test
 * suite. `blocks` is the as-received array (validated for shape upstream).
 */
export function contentBlockUriViolation(
  blocks: ReadonlyArray<unknown> | undefined,
  roots: ConfinementRoots,
): string | null {
  if (!blocks || blocks.length === 0) return null;

  // ADR-097: a project-less session pins to its single working dir (+ run dir
  // for uploads); otherwise the worktree ∪ repo ∪ run-dir allow-set.
  const allowed = (
    roots.confineRoot
      ? [roots.confineRoot, roots.runDir]
      : [
          roots.worktreePath,
          roots.runDir,
          ...(roots.repoPath ? [roots.repoPath] : []),
        ]
  ).map((root) => path.resolve(root));

  for (const block of blocks) {
    const b = block as {
      type?: string;
      uri?: unknown;
      resource?: { uri?: unknown } | null;
    };
    const isLink = b.type === "resource_link";
    const isResource = b.type === "resource";

    if (!isLink && !isResource) continue;

    const uri = isLink ? b.uri : b.resource?.uri;

    if (typeof uri !== "string") continue;

    const fsPath = fileUriToPath(uri);

    if (fsPath === null) {
      // A resource_link to a non-file scheme is the remote-exfiltration vector.
      if (isLink) {
        return `resource_link must be a file: URI inside the run sandbox: ${uri}`;
      }

      continue;
    }

    const resolved = path.resolve(fsPath);

    if (!allowed.some((root) => isInside(root, resolved))) {
      return `resource URI escapes the run sandbox: ${uri}`;
    }
  }

  return null;
}
