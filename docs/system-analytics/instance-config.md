# Instance configuration domain

## Purpose

Instance configuration is the host-level, read-only settings surface of a
single MAIster deployment: where cloned repos live, where worktrees live,
and which host CLI tools are present. It is resolved from environment
variables (with `os.homedir()` defaults) and surfaced on an admin-gated
`/settings` page. The domain boundary covers exposing these values for
inspection — it does NOT own project rows, secrets, or any write path.
See [ADR-025](../decisions.md#adr-025-project-repo-onboarding--url-clone-or-local-path-host-credential-auth-configurable-roots).

## Domain entities

- **`repo_home`** — the directory new clones land in
  (`MAISTER_REPOS_ROOT`, default `~/.maister/repos`). Resolved by
  `reposRoot()`.
- **`worktrees_root`** — the directory run worktrees live in
  (`MAISTER_WORKTREES_ROOT`, default `~/.maister/worktrees`). The
  deprecated `MAISTER_WORKTREE_ROOT` is accepted as a fallback. Resolved
  by `worktreesRoot()`.
- **Host-tool status** — presence + version of host CLIs `git` and `gh`,
  probed by `hostToolStatus()` → `HostTool[]`. `git` is required by the
  git-ops layer; `gh` is informational-only.

None of these are persisted in the database — they are env-derived at
request time. The canonical env-var reference lives in
[`../configuration.md`](../configuration.md).

## State machine

N/A — instance configuration is read-only, env-derived state. There is no
lifecycle to model: values are computed on each `/settings` render and never
transition. Editable roots are `(Phase 2)`.

## Process flows

### Render the read-only settings page (Implemented)

The `/settings` page resolves the roots and host-tool status only for an
admin caller, then renders them. Non-admins get a forbidden message and no
host details.

```mermaid
sequenceDiagram
    actor U as Operator
    participant P as /settings page
    participant AZ as lib/authz
    participant IC as lib/instance-config
    participant HOST as Host CLIs

    U->>P: GET /settings
    P->>AZ: getSessionUser()
    alt not admin
        P-->>U: render forbidden (no host details)
    else admin
        P->>IC: reposRoot()
        IC-->>P: MAISTER_REPOS_ROOT or ~/.maister/repos
        P->>IC: worktreesRoot()
        IC-->>P: MAISTER_WORKTREES_ROOT or fallback or ~/.maister/worktrees
        P->>IC: hostToolStatus()
        IC->>HOST: git --version
        IC->>HOST: gh --version
        IC-->>P: [{git, available, version}, {gh, available, version}]
        P-->>U: render reposRoot / worktreesRoot / host tools (read-only)
    end
```

Status: **Implemented** — `web/lib/instance-config.ts` +
`web/app/(app)/settings/page.tsx`.

## Expectations

- Instance config has NO DB table and NO write API; values are derived
  from environment variables on each read (Phase 2 adds editable roots).
- `reposRoot()` returns `MAISTER_REPOS_ROOT` when set, else
  `os.homedir()/.maister/repos`.
- `worktreesRoot()` returns `MAISTER_WORKTREES_ROOT`, else the deprecated
  `MAISTER_WORKTREE_ROOT`, else `os.homedir()/.maister/worktrees`.
- The `/settings` page renders host-tool and root details only for an
  `admin`; every other caller gets the forbidden branch with no host
  details.
- `hostToolStatus()` reports `git` and `gh` presence + version; a probe
  failure degrades to `{ available: false, version: null }` and never
  throws.
- `gh` is informational-only — its absence MUST NOT block any flow.
- No instance-config value is a secret; none is logged, streamed, or sent
  to a non-admin client.

## Edge cases

- **`git` missing on host** → `hostToolStatus()` reports `git` unavailable;
  any actual git operation fails downstream with `PRECONDITION`
  (`assertGitAvailable`, see [`git-integration.md`](git-integration.md)).
- **`gh` absent** → reported as unavailable in Settings; no impact — `gh`
  is never invoked.
- **Non-admin opens `/settings`** → forbidden branch; roots and host-tool
  status are not resolved or rendered.

## Linked artifacts

- ADR: [ADR-025 Project repo onboarding](../decisions.md#adr-025-project-repo-onboarding--url-clone-or-local-path-host-credential-auth-configurable-roots).
- Config reference: [`../configuration.md`](../configuration.md) §Environment
  variables.
- Related domains: [`projects.md`](projects.md),
  [`git-integration.md`](git-integration.md).
- Source: `web/lib/instance-config.ts`,
  `web/app/(app)/settings/page.tsx`.
