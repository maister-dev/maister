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
};

// Bounded so a manifest cannot ask a single session to check out an unbounded
// number of sibling repos.
export const CONTEXT_REPOS_MAX = 8;
