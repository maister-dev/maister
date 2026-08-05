// ADR-157: read-only sibling-repo context mounts.
//
// Two distinct shapes, deliberately not one. The DECLARATION is what an author
// or a project admin writes (a project slug, resolved at launch). The SNAPSHOT
// is what a launch actually materialized, and it is the ONLY thing the terminal
// and crash-recovery paths read — re-deriving from the declaration would let a
// manifest edit or an attachment change after launch point cleanup at the wrong
// paths.

export type ContextRepoDecl = {
  // Project SLUG, resolved to a project id at launch. A slug rather than an id
  // because the declaration travels inside portable flow packages and
  // `recommended` agent bindings, neither of which can know an installation's
  // project ids.
  project: string;
  // Optional; absent means that project's default branch.
  ref?: string;
};

export type ContextMountSnapshot = {
  projectId: string;
  slug: string;
  repoPath: string;
  mountPath: string;
  committish: string;
  // The ref the launch ASKED for (`decl.ref`, else the sibling's default
  // branch). Distinct from `committish`, which is what that ref resolved to.
  // Kept because the supervisor wire contract and the agent-facing prompt
  // preamble both report `ref` and `commit` separately — a reader needs to know
  // it got `main`, not only the sha `main` happened to point at. Optional for
  // rows written before this field existed; readers fall back to `committish`.
  ref?: string;
};

// The supervisor's `POST /sessions` contract (`ContextMountSchema` in
// `supervisor/src/types.ts`) is `.strict()` and names its fields
// `{slug, path, ref, commit}` — NOT the snapshot's
// `{projectId, repoPath, mountPath, committish}`. Sending a snapshot verbatim is
// rejected outright (unknown keys + missing required ones), so this projection is
// mandatory at the wire boundary and lives here, beside the type it maps from.
export type ContextMountWire = {
  slug: string;
  path: string;
  ref: string;
  commit: string;
};

export function contextMountsToWire(
  snapshot: readonly ContextMountSnapshot[],
): ContextMountWire[] {
  return snapshot.map((mount) => ({
    slug: mount.slug,
    path: mount.mountPath,
    ref: mount.ref ?? mount.committish,
    commit: mount.committish,
  }));
}

// Bounded so a manifest cannot ask a single session to check out an unbounded
// number of sibling repos.
export const CONTEXT_REPOS_MAX = 8;
