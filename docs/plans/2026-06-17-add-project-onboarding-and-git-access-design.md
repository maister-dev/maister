# Project onboarding + git-access redesign

- **Date:** 2026-06-17
- **Status:** Design — pending owner review (Q2 + phasing open, §14)
- **Scope:** the "Add project" screen ([new-project-form.tsx](../../web/components/projects/new-project-form.tsx)),
  its route ([POST /api/projects](../../web/app/api/projects/route.ts)), the clone
  helper ([repo-source.ts](../../web/lib/repo-source.ts)), and new per-project
  surfaces (config persist + git remotes in settings).

## 1. Problems

1. **No URL→field prefill.** Entering a Git URL leaves name/location and task-key
   blank; the server silently derives them. The user can't see what will be used.
2. **Task key not previewed.** Same — derived server-side, never shown live.
3. **Opaque clone failures + passphrase-only SSH.** Cloning
   `git@gitverse.ru:kaa/beauty-ai.git` returns a generic 409. Real cause hidden.
   **Diagnosed (reproduced via `git ls-remote`):** both default keys
   (`~/.ssh/id_ed25519`, `id_rsa`) are passphrase-encrypted, the ssh-agent is
   empty, and `gitExecOptions` forces `ssh -o BatchMode=yes`, which skips an
   encrypted key not in the agent → `Permission denied (publickey)`. The git
   stderr is computed but never reaches the UI ([new-project-form.tsx:99](../../web/components/projects/new-project-form.tsx)
   maps every code to one generic string).
4. **`maister.yaml` is mandatory to register — onboarding blocker.** `register()`
   calls `loadProjectConfig()` at [route.ts:195](../../web/app/api/projects/route.ts)
   **before any DB write**; missing/invalid → `CONFIG` 422, no row. A repo that
   doesn't already contain `maister.yaml` (every new/external repo) cannot be
   added — yet the code already half-supports bare repos (`gitStatus:
   "initialized" | "no-remote"`, [repo-source.ts:313](../../web/lib/repo-source.ts)).
5. **No greenfield onboarding, no remote management.** A new empty project can't
   be created from the form — a no-URL path that doesn't exist throws "directory
   not found" ([repo-source.ts:309](../../web/lib/repo-source.ts)). And a
   local-only project has no UI to add a remote later (the `warnNotGit` dead-end:
   PR promotion needs a remote).

> Issues 3 and 4 are **distinct stages**: a clone-auth failure (3) aborts before
> the manifest is ever read (4). The `errorClone` 409 the operator saw is
> clone-stage `PRECONDITION`, not the `CONFIG` 422 a missing manifest raises.
> `beauty-ai` hits the SSH wall first; even after `ssh-add`, its missing
> `maister.yaml` still blocks registration until P1. Onboarding it end-to-end
> needs **both** P2 (or `ssh-add`) and P1.

## 2. Goals / non-goals

**Goals**
- Live, editable prefill of project name + task key from the Git URL.
- Precise, actionable clone-failure messages (real git stderr, classified) + an
  HTTPS-token path + a GitHub `gh` path + SSH guidance.
- `maister.yaml` **optional** for manual registration; register from DB defaults
  when absent. Repo not mutated at registration.
- Onboard a **brand-new empty local project** (mkdir + git init, no remote).
- An opt-in, per-project **persist** of config to `maister.yaml` (commit to main).
- **Git remote management** in Project Settings (also unblocks PR promotion).

**Non-goals (this change)**
- A managed **platform git-credential store** (admin-configured per-provider
  tokens/keys) — deferred (Q2 resolved → host-ambient, §3). Auth is the host's
  ssh-agent/keys + `gh` + env, plus the ephemeral one-off token field. A managed
  store is a separate future phase.
- Auto-push on persist/registration — push is opt-in, lands with the remotes
  phase (§7B), reusing whatever auth Q2 picks.
- An in-app SSH key generator (guidance only).
- `MAISTER_PROJECTS_DIR` auto-discovery stays `maister.yaml`-gated (needs a
  marker; only the manual path becomes optional).

## 3. Owner decisions (locked in discussion)

- Issue 2: **fill the task-key field** with the derived value (sent; explicit
  wins server-side per ADR-078 D2).
- Prefill rule: explicit **Project name** field + **task key**, both prefilled
  from the URL and kept in sync **until the user edits** that field; a user edit
  always wins and stops auto-prefill for it.
- Issue 3: precise messages + real stderr (always) **+** HTTPS-token field **+**
  GitHub via `gh` (best-effort) **+** SSH guidance (no in-app keygen).
- `gh` path: absent → unified path; present & authed → auto-use its token;
  present but **not** authed → UI shows the fork (log in via `gh` *or* use the
  unified token/SSH path).
- `maister.yaml` absent → **DB defaults, repo untouched** + a per-project
  **persist banner** → write `maister.yaml` as a **commit to the main branch**.
- Persist banner is **dismissible** on home + project board (client-persisted);
  the durable entry point is **Project Settings → Git**; on dismiss, tell the
  user it stays there.
- New onboarding need: **create a brand-new empty local project** and **manage
  git remotes** in Project Settings.
- **Git auth = host-ambient (Q2 = A).** "Platform" means managed by this maister
  instance via the host's mechanisms — ssh-agent/keys, `gh` when available, env
  vars, and (future) key stores — which is exactly what this feature wires. No new
  managed credential store now; that is a separate future phase. Push (persist /
  remotes) reuses this.

## 4. Workstream 1 — Form prefill (issues 1 & 2), client only

File: [new-project-form.tsx](../../web/components/projects/new-project-form.tsx).

- Extract the pure name-deriver into a **client-safe** module
  `web/lib/repo-name.ts`: `deriveRepoNameSafe(url: string): string | null` (the
  regex/segment logic from [repo-source.ts:93](../../web/lib/repo-source.ts)
  `deriveRepoName`, minus the `MaisterError` throw). `repo-source.ts`'s
  `deriveRepoName` becomes a thin wrapper that throws `PRECONDITION` on `null`,
  so server behavior is unchanged and the rule is single-sourced. Rationale:
  `repo-source.ts` is `import "server-only"` + `node:*` — unimportable client-side.
- `deriveTaskKey` + `TASK_KEY_REGEX` are already pure
  ([task-key.ts](../../web/lib/social/task-key.ts)) → import directly.
- State: add `nameDirty`, `taskKeyDirty` booleans (default `false`).
  - On `repoUrl` change: if `!nameDirty` → `setName(deriveRepoNameSafe(url) ?? "")`;
    then if `!taskKeyDirty` → `setTaskKey(previewKey(name || deriveRepoNameSafe(url)))`.
  - On `name` change (manual): `nameDirty = true`; if `!taskKeyDirty` → recompute
    the key preview from the new name.
  - On `taskKey` change (manual): `taskKeyDirty = true` (keep the existing
    `toUpperCase().replace(/[^A-Z0-9]/g,"")` filter).
  - `previewKey(s)`: `deriveTaskKey(s)`, but emit `""` when the result fails
    `TASK_KEY_REGEX` (degenerate short inputs) so we never prefill an invalid key.

Connects to WS3: the prefilled **name** becomes the project name when there is no
`maister.yaml`; the prefilled **key** is sent and wins.

## 5. Workstream 2 — Git access (issue 3), server + client

### 5.1 Surface the real failure (always)

In [repo-source.ts](../../web/lib/repo-source.ts) `cloneRepo` catch, classify the
redacted git stderr and carry it to the client.

- New pure helper `classifyGitError(stderr): CloneFailureReason`:
  `"SSH_AUTH" | "SSH_HOSTKEY" | "HTTPS_AUTH" | "NOT_FOUND" | "NETWORK" | "UNKNOWN"`.
  - `SSH_AUTH` — `Permission denied (publickey)`, `Could not read from remote repository`.
  - `SSH_HOSTKEY` — `Host key verification failed`, `REMOTE HOST IDENTIFICATION HAS CHANGED`.
  - `HTTPS_AUTH` — `Authentication failed`, `could not read Username/Password`, `403`.
  - `NOT_FOUND` — `repository not found`, `does not exist`, `404`.
  - `NETWORK` — `Could not resolve host`, `Connection timed out`, `unable to access`, abort/timeout.
  - `UNKNOWN` — fallback.
- The thrown `MaisterError` keeps `code: "PRECONDITION"` but gains structured
  context `{ reason, detail }` (`detail` = redacted stderr). `errorResponse`
  serializes the body as `{ code, reason?, detail? }`. The UI maps `reason` → a
  specific i18n remediation, shows `detail` in a collapsible "git output" block,
  leads `SSH_AUTH` with `ssh-add`, and includes the `gh` fork for `github.com`
  on `HTTPS_AUTH` (see 5.3).
- **Fix the untranslated ru keys** on this screen (`errorConflict`,
  `errorForbidden`, `successTitle`, verify `errorConfig`) in [ru.json](../../web/messages/ru.json).

`MaisterError` shape: confirm `errors.ts` carries structured context; if it only
holds `code`+`message`+`cause`, add an optional `details?: Record<string, unknown>`
(additive) and include it in `errorResponse`. UI keeps branching on `code`.

### 5.2 HTTPS token (optional, one-off override)

- Form: optional **Token** field (`type="password"`, `autoComplete="off"`), shown
  when the URL is `https://`/`http://`. Sent as `token` in the POST body.
- `postBodySchema` gains `token: z.string().min(1).optional()`.
- `cloneRepo` accepts an optional `token`. When present and the scheme is http(s):
  write a static **askpass** script to a `mkdtemp` dir (mode `0700`):
  `#!/bin/sh\nprintf '%s' "$MAISTER_GIT_TOKEN"`; clone the **plain** URL with env
  `GIT_ASKPASS=<script>`, `MAISTER_GIT_TOKEN=<token>`, `GIT_TERMINAL_PROMPT=0`;
  the script answers both Username and Password prompts with the token — works for
  gitverse (`https://<token>@…`, token-as-userinfo, **verified**) and GitHub
  (token valid in either field); remove the temp dir in `finally`.
  Token is never in argv, on disk in a key file, in the clone's `.git/config`, or
  logged.
- Token is **not persisted** (this is the one-off override; durable auth = Q2).
  `projects.repo_url` stores the plain URL.
- Keep the `urlHasCreds` warning ([new-project-form.tsx:142](../../web/components/projects/new-project-form.tsx))
  to nudge users to the token field over inlining creds in the URL.

### 5.3 GitHub via `gh` (best-effort)

- URL host `github.com`, scheme http(s), no `token`: probe
  `execFile("gh", ["auth", "token"])`. Exit 0 → use it via the askpass path. `gh`
  absent or not logged in → proceed without a token (likely → `HTTPS_AUTH`); the
  `HTTPS_AUTH` remediation for `github.com` surfaces the fork ("run `gh auth
  login`, or paste a token, or use SSH").
- `detectGhAuth(): "ok" | "unauthed" | "absent"` helper, used for both the happy
  path and the error copy.

### 5.4 SSH guidance (messages only)

`SSH_AUTH` remediation (en+ru): (1) `ssh-add --apple-use-keychain ~/.ssh/<key>`
(load your existing key — most likely fix); (2) switch to HTTPS + token; (3)
create a passphrase-less deploy key `ssh-keygen -t ed25519 -N "" -f
~/.ssh/maister_<host>` → add the printed `.pub` to the provider → load it.

## 6. Workstream 3 — `maister.yaml` optional at manual registration

File: [route.ts](../../web/app/api/projects/route.ts) `register()`.

- After `resolveProjectSource`, `stat` `maister.yaml` at `resolved.dir`:
  - **present** → today's path unchanged (`loadProjectConfig` → flows/packages
    install, `maisterYamlPath` set).
  - **absent** → **DB-default registration**:
    - `name = body.name?.trim() || path.basename(resolved.dir)` (`ResolvedSource`
      has no `target` field; `resolved.dir` is the clone folder or local path, so
      its basename is correct for both, no `.git` suffix on a clone folder);
    - `slug = deriveSlug(name)`; `taskKey = body.taskKey ?? deriveTaskKey(name, slug)`;
    - `mainBranch = await getDefaultBranch(resolved.dir)` (§6.2);
    - `branchPrefix = "maister/"`, `defaultRunnerId = null`, `promotionMode = null`,
      `repoUrl = resolved.repoUrl`, `provider = resolved.provider`,
      **`maisterYamlPath = null`**;
    - same uniqueness check (slug/repoPath/taskKey) → `CONFLICT` on collision;
    - insert `projects` row + owner membership (existing transaction), **no
      flow/package/import install** (none declared);
    - if `gitStatus === "initialized"`, still `gitInit` the dir (as today).
- Present-but-invalid `maister.yaml` still → `CONFIG` 422 (a malformed file is a
  user error, not "no config" — do not silently fall back). Only a **missing**
  file takes the DB-default branch.

### 6.1 Form reframe (project name)

- `target` → **"Local path or clone folder"** (the *where*).
- New optional **"Project name"** field (the *what*) — prefilled per WS1;
  authoritative only when the repo has no `maister.yaml` (precedence:
  `yaml.project.name` > `body.name` > `path.basename(resolved.dir)`).
- Keep **"Task key"**. Rewrite `addSub`: if the repo has `maister.yaml` it's used,
  otherwise the project is configured from these fields and you can persist a
  `maister.yaml` later.

### 6.2 Default-branch helper

Add to [worktree.ts](../../web/lib/worktree.ts) (mirrors `readRemoteOrigin`):
`getDefaultBranch(repo): Promise<string>` →
`git -C <repo> symbolic-ref --short refs/remotes/origin/HEAD` (strip `origin/`);
fall back to `git -C <repo> rev-parse --abbrev-ref HEAD`; final fallback `"main"`.

### 6.3 Data model

[schema.ts:127](../../web/lib/db/schema.ts) — drop `NOT NULL` on
`maister_yaml_path` (`NULL` = "config lives only in the DB" signal).
- **Migration:** next free number (verify against `web/lib/db/migrations` +
  `_journal.json`; keep `when` monotonic — repo journal-drift gotcha).
  `ALTER TABLE projects ALTER COLUMN maister_yaml_path DROP NOT NULL;` No backfill
  (existing rows keep their path → no banner).
- Guard the two readers for `null`: `loadProjectConfig` is only hit on the
  present-path branch (safe); `writeBackPackagesPin`
  ([yaml-writeback.ts](../../web/lib/packages/yaml-writeback.ts)) must early-return
  a benign `"skipped"` on `null` (DB is authoritative; nudge persist via banner) —
  it read-modifies an existing file and would otherwise fail.

## 7. Workstream 4 — Persist config to `maister.yaml` (per-project, opt-in)

### 7.1 Serializer (new)

`writeBackPackagesPin` only edits `packages[]` of an **existing** file — it does
not create one. Add `serializeProjectConfig(project, attachments): string` →
complete, **schema-valid** `maister.yaml` v2:

```yaml
schemaVersion: 2
project:
  name: <projects.name>
  main_branch: <projects.main_branch>      # omit if "main"
  branch_prefix: <projects.branch_prefix>  # omit if "maister/"
  default_runner: <…>                      # omit if null
  promotion: { mode: <…> }                 # omit if null
flows: []                                   # or the project's attached flows
```

`flows: []` is valid (no `.min(1)`, [config.schema.ts:261](../../web/lib/config.schema.ts)).
Round-trip through `maisterYamlV2Schema.parse` before writing (self-check). Emit
attached flows/packages so the file matches the DB.

### 7.2 Endpoint

`POST /api/projects/[slug]/persist-config` (admin / project-owner):
1. Load project; require `maisterYamlPath IS NULL` (else 409 — already persisted).
2. Preconditions on `repo_path`: git repo, **HEAD on `main_branch`**, clean tree,
   no `maister.yaml` on disk → else clear `PRECONDITION` (wrong branch / dirty /
   detached / file exists). Honors "commit to the main branch."
3. `atomicWriteText(repo/maister.yaml, serializeProjectConfig(...))`.
4. New web-tier helper `commitFile({ repo, file, message })` over `runGit`
   ([worktree.ts:131](../../web/lib/worktree.ts)): `git add` → `git commit -m`.
   No push (push is the §7B opt-in). Host git author config required → if unset,
   commit fails → surface remediation.
5. On success set `projects.maister_yaml_path`. Order: write → commit → DB flip;
   commit fails → keep the working-tree file, do NOT flip the DB (banner stays);
   best-effort remove the file only if it didn't pre-exist.

> **Pending (Q2, §14):** an opt-in **push** after the commit (reuses Q2 auth),
> landing with §7B. Commit message: `chore(maister): persist project config`
> (confirm).

### 7.3 Banner

`components/projects/config-persist-banner.tsx` (client island): renders when
`project.maisterYamlPath == null`, on **both** the portfolio home
([page.tsx](../../web/app/(app)/page.tsx)) and the project board
([projects/[slug]/page.tsx](../../web/app/(app)/projects/[slug]/page.tsx)). Action
→ confirm dialog (target path + branch + commit message) →
`POST …/persist-config` → success hides it + toast. **Dismiss** is
client-persisted (`localStorage` per project); on dismiss, a note points to
**Project Settings → Git** (§7B), which always offers the action while
`maisterYamlPath == null` — the durable entry; the banner is only the nudge.

## 7A. Workstream 5 — New empty local project + onboarding modes

`resolveProjectSource` rejects a no-URL `target` that doesn't exist
([repo-source.ts:309](../../web/lib/repo-source.ts)). Add a third mode for
greenfield.

Form: a top **mode selector** (segmented control) replacing the overloaded field:
- **Clone from URL** — Git URL (+ optional token, §5.2) → clone.
- **Existing local repo** — absolute path to an existing dir (git-init if not a
  repo, as today → `initialized`).
- **New empty project** — a bare name (→ `~/.maister/repos/<name>`) or an absolute
  path that does **not** exist → `mkdir -p` + `git init` → `gitStatus:
  "initialized"`, no remote.

Server: extend `resolveProjectSource`'s no-URL branch — if the path is absent
**and** `mode === "new"` (explicit intent; never create implicitly on a typo),
`mkdir` it and mark it created for cleanup-on-failure (mirror `clonedByUs`); reuse
the deferred `gitInit` in `register()`. Pairs with WS3: a new repo has no
`maister.yaml` → DB-defaults; `main_branch` = git's init default. Body gains
`mode: "clone" | "existing" | "new"` (server still validates the path against the
mode — intent, not blind trust).

## 7B. Workstream 6 — Git remotes in Project Settings

A local-only project (`no-remote` / new) needs to attach a remote later — this
clears `warnNotGit` (PR promotion needs a remote) and hosts the persist push.

Project Settings gains a **Git** section — the first project settings-write
surface (the page is read-only today per [web/CLAUDE.md](../../web/CLAUDE.md)):
- **List** — `git remote -v` (URLs redacted via `redactUrl`).
- **Add** — `git remote add <name> <url>`; if `name == "origin"`, update
  `projects.repo_url` + `provider` (`detectProvider`).
- **Edit URL** — `git remote set-url <name> <url>` (+ origin sync).
- **Remove** — `git remote remove <name>` (+ null `repo_url`/`provider` if origin).
- (With Q2 auth) **Fetch / Push** + set upstream.

All via `runGit` (config ops are network-free; fetch/push need Q2 auth). New
`web/lib/git-remotes.ts`; endpoints under `/api/projects/[slug]/remotes`
(admin/owner). Adding `origin` is the bridge from a no-remote/new project to
promotion-capable.

## 8. API / contract changes

- `POST /api/projects` body: `+ name?`, `+ mode?` (`clone|existing|new`),
  `+ token?`. Error body: `+ reason?`, `+ detail?` (clone `PRECONDITION`).
- `POST /api/projects/[slug]/persist-config` (new).
- `GET/POST/PATCH/DELETE /api/projects/[slug]/remotes` (new).
- Update `docs/api/web.openapi.yaml` + redocly lint.

## 9. i18n (en + ru, parity REQUIRED)

New/updated `projects.*`: `nameLabel/namePlaceholder`, `locationLabel`
(re-labeled), `modeClone/modeExisting/modeNew`, `tokenLabel/Placeholder/Hint`,
`addSub` (rewrite), per-reason clone errors
(`errorSshAuth/errorSshHostkey/errorHttpsAuth/errorNotFound/errorNetwork/errorCloneDetail`),
`ghLoginHint`, persist banner/dialog strings, settings Git-section strings. Fix
the untranslated ru values (§5.1).

## 10. Docs (canonical files per docs/CLAUDE.md glossary)

- [system-analytics/projects.md](../system-analytics/projects.md) — DB-default
  registration path, the three onboarding modes, `maisterYamlPath == null` signal.
- [system-analytics/git-integration.md](../system-analytics/git-integration.md) —
  clone-error classification, token/`gh`/SSH paths, remote management.
- [configuration.md](../configuration.md) — `maister.yaml` optional for manual
  registration; any new `MAISTER_GIT_*` env.
- [error-taxonomy.md](../error-taxonomy.md) — the advisory clone `reason`s (code
  stays `PRECONDITION`).
- [deployment.md](../deployment.md) — git auth options (ambient vs Q2 store).
- `CLAUDE.md` §6 + [web/CLAUDE.md](../../web/CLAUDE.md) — optionality + persist.
- [screens/](../screens/) — Add-project screen + Project Settings → Git.

## 11. Testing

- **Unit:** `deriveRepoNameSafe` (scp/https/ssh/path/garbage); `previewKey`
  invalid → `""`; `classifyGitError` per reason; `serializeProjectConfig`
  round-trips `maisterYamlV2Schema`; `getDefaultBranch` fallbacks.
- **Integration (testcontainers PG):** register with no `maister.yaml` → row with
  `maisterYamlPath null` + derived fields; with valid yaml → unchanged; invalid
  yaml → `CONFIG` 422; **new-empty mode** → dir created + git-init + row;
  `persist-config` happy path (file + commit + flip) + precondition failures;
  remotes add/edit/remove (origin syncs `repo_url`/`provider`);
  `writeBackPackagesPin` null-path → `"skipped"`.
- **Component:** mode selector field visibility; prefill (URL→name+key, dirty
  stops); error rendering per `reason` + collapsible detail.
- **E2E:** add a new-empty project with no `maister.yaml` → board → persist
  banner → persist → banner gone; add a remote in settings. (Token clone E2E:
  cover the askpass injection at integration level.)

## 12. Security

- Token only in child-process env + a `0700` askpass file (removed in `finally`);
  never argv / disk-key / `.git/config` / logs. `redactUrl` strips `://user:pass@`.
- `persist-config` + remotes shell git in the operator's repo — admin/owner only,
  path-confined to `repo_path`, preconditioned.
- New-empty mode `mkdir`: explicit `mode === "new"` only; path validated
  (`absolutePathSchema` / `SAFE_SEGMENT`); cleanup-on-failure.
- No new secret storage (unless Q2 picks the managed store — its own design).

## 13. Build order

Superseded by the phasing in §15 (the work grew past one plan).

## 14. Decisions & open questions

**Resolved (owner):** explicit Project-name field + task key, prefilled from URL
until edited (§3, WS1); persist banner dismissible on home + board, durable in
Project Settings → Git (§7.3); create-new-empty mode (WS5) + remotes in settings
(WS6); push reuses platform auth.

**Resolved (Q2/Q3):**
- **Q2 = A — host-ambient git auth** (see §3). Managed by the maister instance via
  host mechanisms (ssh keys, `gh`, env, future key stores). No managed credential
  store in this work.
- **Q3 = P1 → P2 → P3** (§15).

## 15. Phasing (each independently shippable)

- **P1 — Onboarding core.** WS3 (yaml optional) + WS5 (3 modes incl. new empty) +
  WS1 (prefill) + form reframe. Removes the registration blocker; greenfield +
  existing-local + clone all work without a pre-existing `maister.yaml`. Owns the
  `maister_yaml_path` migration.
- **P2 — Git access.** WS2 (clone error classification + real stderr + HTTPS token
  + `gh` + SSH guidance). Fixes the gitverse private-clone pain.
- **P3 — Git in settings.** WS6 (remotes CRUD) + WS4 (persist: commit, opt-in
  push). Depends on P1 (DB-default projects exist) and Q2 auth for push.

If Q2 picks a managed credential store, it is a separate cross-cutting phase
(touches clone, fetch, push, promotion) with its own design. Each Pn gets its own
implementation plan (writing-plans) after this spec is approved.
