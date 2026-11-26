[← Getting started](getting-started.md) · [Back to README](../README.md)

> A/B stabilization is in progress. The [runtime floor, resource budgets and host-process wiring](configuration.md#ab-runtime-and-deployment-qualification-designed) are Designed until their validation gates pass. The [qualification topology](system-analytics/test-infrastructure.md#ab-stabilization-test-lanes-designed) defines executable evidence; earlier aggregate pass counts do not qualify this release.

# Deploying MAIster on a Linux VPS

Production deployment for a single host. Per [ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres),
**`web` and `supervisor` run as host processes** (they spawn agent CLIs and
operate on host git repos / worktrees); **only Postgres is containerized**.
This guide wires both as systemd services behind a TLS reverse proxy.

Ready-to-edit artifacts live in [`deploy/`](../deploy): `maister.env.example`,
`maister-supervisor.service`, `maister-web.service`, `maister-web.nginx.conf`.
Environment variables are documented in [`configuration.md`](configuration.md);
this guide does not restate them.

## Topology

```
            ┌─────────────── VPS (single host) ───────────────┐
 client ──TLS──▶ nginx :443 ──▶ web (application server) :3000  [systemd: maister-web]
            │                          │ HTTP+SSE                │
            │                          ▼                         │
            │                 supervisor :7777  [systemd: maister-supervisor]
            │                  │ spawns claude-agent-acp / codex-acp
            │                  ▼                                 │
            │        project git repos + worktrees (host FS)     │
            │                                                    │
            │        postgres :127.0.0.1:5432  [docker compose]  │
            └────────────────────────────────────────────────────┘
```

`:7777` (supervisor) and `:5432` (Postgres) are **loopback-only** — never
exposed publicly. Only `:443` (and `:22`) face the internet.

## 1. Prerequisites

- **OS**: any modern Linux with systemd.
- **Node >=24.15.0 <25** (qualified patches: 24.15.0 and 24.19.0; [ADR-015](decisions.md#adr-015-pnpm-workspace-node-24)) installed system-wide (e.g. NodeSource), then `corepack enable` to provide `pnpm`.
- **git** and **Docker** (Docker only runs Postgres here).
- **Agent adapters** ship as workspace dependencies — `pnpm install` provides `claude-agent-acp` and `codex-acp` under `node_modules/.bin`. **No `gh` or other provider CLI is required for core operation** (clone, worktree, `local_merge` promotion). **Optional (Implemented, [ADR-093](decisions.md#adr-093-project-onboarding--optional-maisteryaml-host-ambient-git-auth-onboarding-modes-advisory-clone-reasons)):** the `gh` CLI, when present and authed, enables auto-token for `github.com` HTTPS clones — best-effort, never required. **Exception (Implemented — ADR-049):** `pull_request` promotion runs in the web tier and needs, per the run's provider, `gh`/`glab` on `PATH` (github/gitlab) **or** `GITEA_TOKEN`/`GITVERSE_TOKEN` in the web-tier env (gitea/gitverse), **plus** a git push credential helper. The **default compose does not provision** these — it is a host-operator concern ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)). `local_merge` promotion needs none of them. See [`configuration.md`](configuration.md) for the per-provider table.
- A dedicated unprivileged user **`maister`** that owns the checkout, the agent credentials (`~/.claude`, `~/.codex`), and the git credentials.

```bash
sudo useradd --create-home --shell /bin/bash maister
sudo mkdir -p /opt/maister /etc/maister
sudo chown maister:maister /opt/maister
```

## 2. Install and build

As the `maister` user, into `/opt/maister`:

```bash
git clone <maister-repo-url> /opt/maister
cd /opt/maister
pnpm install --frozen-lockfile
pnpm --filter maister-web build          # builds the internal MCP facade, then the web app
```

Build each web release in its own directory. Start the new process from the completed build and keep the previous release directory, including its entire `web/.next` tree, until the old process has drained. A running server can still load a server chunk on its first request for a feature.

## 3. Postgres (Docker)

`compose.yml` defines only Postgres, published on `127.0.0.1:5432`:

```bash
cd /opt/maister
docker compose up -d postgres            # add: -f compose.yml -f compose.production.yml  for hardening
```

Enable Docker on boot (`sudo systemctl enable docker`) so Postgres restarts with
the host (`restart: unless-stopped` handles the container itself).

> **Project Brain (ADR-122).** The Postgres image is **`pgvector/pgvector:pg16`**
> (pgvector-enabled) — the Brain's `CREATE EXTENSION vector` + HNSW indexes require
> it. The swap from `postgres:16-alpine` is **data-compatible** (same PG16 data
> dir), so an existing dev volume upgrades in place. Note the alpine (musl) →
> Debian (glibc) switch can change collation behavior — check
> `SELECT datcollate FROM pg_database` and `REINDEX DATABASE` if it is not
> C/C.UTF-8. On an external/managed Postgres (not this compose file) the brain
> lineage's `CREATE EXTENSION vector` needs a role with extension-create rights
> (the compose `POSTGRES_USER` is the bootstrap superuser; on RDS use
> `rds_superuser`). If `db:migrate:brain` is never run, the web tier still
> boots: the boot guard warns, the Brain sweeps quietly no-op, and the Brain
> config/enable surfaces refuse with `PRECONDITION` naming the command.

## 4. Configure the environment

```bash
sudo cp deploy/maister.env.example /etc/maister/maister.env
sudo chown maister:maister /etc/maister/maister.env
sudo chmod 600 /etc/maister/maister.env
sudo -u maister "$EDITOR" /etc/maister/maister.env
```

Set at least:

- `AUTH_SECRET` — generate with `openssl rand -base64 32`.
- `AUTH_URL` — your public HTTPS URL.
- `POSTGRES_PASSWORD` / `DB_URL` — keep `@localhost:5432`.

The supervisor unit reads its own env file instead of the shared one — seed it:

```bash
sudo -u maister cp supervisor/.env.sample supervisor/.env
sudo chmod 600 supervisor/.env
sudo -u maister "$EDITOR" supervisor/.env   # set MAISTER_RUNTIME_ROOT=/opt/maister
```

Agent CLIs are configured separately on the supervisor host. Use their native
login/config flows for `claude-agent-acp`, `codex-acp`, `gemini --acp`, and
`opencode acp`, and `mimo acp`; put provider env vars in `supervisor/.env` only
when you intentionally want MAIster to supply an explicit compatible-provider,
gateway, model-discovery, or sidecar override (the supervisor spawns the
adapters, so its env is what they inherit).

`MAISTER_RUNTIME_ROOT` no longer has to be the same directory for both
services: since the Stage B cut-over the run event stream, costs, prompt
completion and runtime-object metadata are Postgres-owned, and the web never
reads a host runtime path (enforced by the operation-scoped filesystem guard in
`web/lib/execution-host/__tests__/runtime-data-boundary-inventory.test.ts`).
The supported single-host layout in this guide keeps `/opt/maister` for both
because the two units run as the same `maister` user; the AT-16 qualification
(`web/test-support/__tests__/execution-ab-isolation.integration.test.ts`)
runs them on disjoint private roots with only the worktrees root shared and the
web denied the supervisor's root at the kernel. This macOS proof uses distinct
sandbox security contexts, not distinct Unix users. The shipped same-user,
shared-root layout does not enforce that isolation boundary. What must stay true when the
roots differ: the supervisor identity must still read the web's runtime root
where read-only context mounts are materialized (ADR-157) and write the
shared worktrees root; `MAISTER_WORKSPACE_ROOTS` must list every root the web
creates worktrees or local packages under.

S5.3 qualifies a Linux container layout with distinct Web and supervisor
users. Give the supervisor a private `0700` runtime root with its SQLite
state inside it. Make the Stage B project repositories and worktrees
accessible through a shared service group and set-GID directories, with
`umask 0002` for both service processes. Both identities still need access
to the shared Git data they use. Keep operator Git trust and credentials
scoped to their intended service user. The packaged browser smoke exercises
the production application under Web UID 1001 and supervisor UID 1002
with those permissions and checks that Web receives `EACCES` when opening
the live supervisor SQLite store. It also checks the board launch, SSE,
permission checkpoint and resume, restart, cancellation and active content
download through the same two processes. Systemd installation below uses
the existing shared-user units.

**Execution-host state (Implemented — [ADR-166](decisions.md#adr-166-local-execution-host-contract--durable-host-identity-epoch-fenced-assignments-command-ledger-opaque-adopted-workspaces)).**
The supervisor keeps a private `node:sqlite` state store under
`MAISTER_EXECUTION_HOST_STATE_DIR` (default
`<MAISTER_RUNTIME_ROOT>/.maister/execution-host/` → `/opt/maister/.maister/execution-host/`;
the `maister` user must be able to create it). It holds the host identity
(`hostKey`), per-run epoch fences, adopted-workspace handles, and command
receipts — back it up with `.maister/`, and never share one state dir
between two supervisors. Optional pin `MAISTER_EXECUTION_HOST_KEY`: set it
only when you deliberately restore a state dir on another machine (it must
EQUAL the stored key); a conflicting pin refuses boot with
`execution-host-key-conflict` — unset the pin or wipe the state dir.
`MAISTER_WORKSPACE_ROOTS` (default
`~/.maister/worktrees:~/.maister/local:<MAISTER_RUNTIME_ROOT>/.maister`) is
the allow-list a run worktree / local-package dir must live under to be
adopted: **if you move `MAISTER_WORKTREES_ROOT` or
`MAISTER_LOCAL_PACKAGES_ROOT` in the web env, mirror the new path here** or
every launch fails at adoption with `PRECONDITION workspace_rejected /
outside_roots`. Repository/worktree compatibility files remain on this one
host, but the web tier does not mount or read supervisor runtime data. Browser
replay, events, costs, prompt completion, and runtime-object metadata are
Postgres-owned.

**Stage B data plane (Implemented — ADR-167).** No compose service,
volume, relay, object store, enrollment secret, or environment variable is
required. `GET /capabilities` is a local supervisor endpoint; protocol
capabilities are fixed rather than operator toggles. Upgrade a supervisor and
web to canonical support, run the staged import phases below with the explicit
legacy root, then apply migrations `0135` and `0136`. The migration fails before
destructive changes unless every legacy run has all preservation lanes proven.

The staged upgrade path for an existing Stage A installation is different and
is a runbook of its own: [§14](#14-stage-b-execution-data-cut-over-upgrade-from-stage-a);
a plain `db:migrate` on such an installation stops at `0135` by design. See
[execution data cutover](system-analytics/execution-data-cutover.md).

### Scheduler clock

Scheduler-owned periodic recovery is available only while the unified scheduler
clock ticks.
For the supported single-box systemd install, set this explicitly in
`/etc/maister/maister.env`:

```dotenv
MAISTER_SCHEDULER_TIMER_ENABLED=true
MAISTER_SCHEDULER_TICK_INTERVAL_SECONDS=60
```

An unset timer also defaults to the fallback when no cron token is configured,
but the explicit line makes deployment ownership reviewable. For multiple web
instances or an operator-owned external scheduler, configure instead:

```dotenv
MAISTER_SCHEDULER_TIMER_ENABLED=false
MAISTER_CRON_TOKEN=<random-server-only-secret>
```

Call `GET` or `POST /api/cron/tick` every minute with
`X-Maister-Cron-Token`. Database claims/leases serialize due work across web
instances. Never place the token in a URL or log. A configured token proves
only that the route is enabled; verify advancing `system_sweep.default` and
`domain_event_dispatch.default` attempt timestamps on `/admin/scheduler`.
Explicit false without a token is `missing_tick` and logs a WARN naming both
configuration variables. In that state scheduler recovery, checkpoint cleanup
and the scheduler's parked-parent wake backstop do not run; boot and continuation
workers retain their separate duties.

The [durable task-launch worker](system-analytics/task-launch-admission.md#durable-launch-worker-implemented)
is implemented to service accepted launch intents at web boot and database
deadlines, with one Flow and one Agent service slot in the existing runtime.
It requires no additional timer, secret or environment flag and does not depend
on HTTP `after` callbacks or cron ticks for launch progress. Its fourth mandatory
worker-health slot and joined shutdown are locally qualified with the owning
launch contract. Hosted and deployed acceptance remain separate. Keep the
60-second scheduler clock and host reconciliation backstops configured.

To roll back an external scheduler to the in-process single-box clock, stop the
external caller, set `MAISTER_SCHEDULER_TIMER_ENABLED=true`, remove
`MAISTER_CRON_TOKEN`, restart `maister-web`, and verify advancing durable
attempt timestamps on `/admin/scheduler`. To move in the other direction,
configure and test the authenticated external call before disabling the
fallback. Scheduler claims serialize a brief overlap during either handoff.

Apply migrations and seed the first admin:

```bash
cd /opt/maister
set -a; . /etc/maister/maister.env; set +a
pnpm --filter maister-web db:migrate         # main lineage (all shared tables)
pnpm --filter maister-web db:migrate:brain   # brain lineage (brain_* + pgvector)
pnpm --filter maister-web db:seed        # initial admin user — see getting-started.md for credentials
```

> **(ADR-122)** `db:migrate:brain` runs the separate Project-Brain migration
> lineage (own `_journal.json` + own ledger `__drizzle_brain_migrations`) AFTER
> the main lineage (`brain_*` FKs → `projects`/`runs`). A
> runtime embedding model/dimension switch is a non-destructive reindex generation,
> never a schema migration.

## 5. Connect project repositories

**Onboarding (Implemented, [ADR-025](decisions.md#adr-025-project-repo-onboarding--url-clone-or-local-path-host-credential-auth-configurable-roots)):**
a project source is a union — register a **git URL to clone** OR an **existing
local dir**. With a `repoUrl`, MAIster clones into `MAISTER_REPOS_ROOT`
(default `~/.maister/repos`); with a local path it uses the dir (and `git
init`-s it if it is not yet a repo). Run worktrees live under
`MAISTER_WORKTREES_ROOT` (default `~/.maister/worktrees`; the deprecated
`MAISTER_WORKTREE_ROOT` is accepted as a fallback). Both roots are surfaced
read-only on the admin `/settings` page. Installed Flow packages and git-pinned
capability imports are cached system-wide under `~/.maister/flows/` and
`~/.maister/capabilities/` (content-addressed by resolved git SHA); on the
host-run deployment these live on the operator's filesystem (no container
mount). Auto-trust policy for capability imports is set via
`MAISTER_TRUSTED_CAPABILITY_SOURCE_PREFIXES` (see `configuration.md`).
**Editable local packages (ADR-096)** keep their git-backed working dirs
under `MAISTER_LOCAL_PACKAGES_ROOT` (default `~/.maister/local`) — host-only,
**not** a container/compose mount
([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)),
exactly like the worktrees/flows roots; `MAISTER_LOCAL_PACKAGE_LOCK_MINUTES`
(default `30`) tunes the editor session-lock TTL. MAIster's git work (clone, worktree
create/remove, flow-finish merge) is **local and provider-neutral** — it never
contacts the provider beyond the clone/fetch. GitHub, GitLab, Gitea, and
GitVerse are all just git.

Provider authentication is the **operator's host git config** (it lets you clone
the project repo, and lets MAIster clone **private Flow plugin sources**). Two
options:

**SSH (recommended)** — keys are made with `ssh-keygen`, not openssl:

```bash
sudo -u maister ssh-keygen -t ed25519 -C "maister@vps" -f /home/maister/.ssh/id_ed25519
# add the PUBLIC key (id_ed25519.pub) to the provider, then trust the host:
sudo -u maister sh -c 'ssh-keyscan github.com gitlab.com gitverse.ru >> ~/.ssh/known_hosts'
```

> **`known_hosts` seeding is mandatory for SSH clones.** MAIster runs git
> non-interactively (`GIT_TERMINAL_PROMPT=0`, `ssh -o BatchMode=yes`), so an
> **unknown host key fails fast** instead of prompting — the clone errors with
> `PRECONDITION`. Run the `ssh-keyscan` line above for every provider host the
> `maister` user will clone from before registering a `repoUrl`.

**HTTPS + token** — use a Personal Access Token via a git credential helper
(`git config --global credential.helper store|cache`).

**`gh` CLI (optional)** — when the GitHub CLI is on `PATH` and logged in
(`gh auth login`), MAIster best-effort uses its token (`gh auth token`) for
`github.com` HTTPS clones (Implemented,
[ADR-093](decisions.md#adr-093-project-onboarding--optional-maisteryaml-host-ambient-git-auth-onboarding-modes-advisory-clone-reasons)).
`gh` is **not required** — absent or unauthed, onboarding degrades to the SSH /
HTTPS-token paths.

**One-off HTTPS token (no storage)** — the Add-project form accepts a transient
HTTPS token for a single clone (Implemented, ADR-093). It is injected via a `0700`
`GIT_ASKPASS` script for that one `git clone` and then discarded — it is **not**
persisted, not written to `.git/config`, and not read from any env var at
startup. Use it for a one-time private clone; for durable auth configure
ssh-agent/keys or the credential helper above.

Where to register the key / create the token:

| Provider | SSH public key | HTTPS token (PAT) |
| --- | --- | --- |
| GitHub | Settings → SSH and GPG keys | Settings → Developer settings → Personal access tokens |
| GitLab | Preferences → SSH Keys | Preferences → Access Tokens |
| Gitea / **GitVerse** | Settings → SSH / GPG Keys | Settings → Applications → Generate Token |

URL-based onboarding uses the **same host credentials** — paste a `repoUrl`
and MAIster clones it into `MAISTER_REPOS_ROOT` (no secrets stored in MAIster),
auto-detecting the provider from the URL host. The SSH key / credential helper
configured above is what authorizes that clone.

## 6. Agent CLI configuration

Configure each ACP tool on the supervisor host using that tool's own supported
auth flow before marking it ready in MAIster. Environment variables in the
supervisor's `supervisor/.env` are optional overrides: they are inherited by
spawned adapters (the supervisor process owns the spawn) and should be used for
explicit compatible-provider routing, gateway config, model discovery, or
sidecars rather than as the default source of truth for
Claude/Codex/Gemini/OpenCode/MiMo auth.

## 7. systemd services

```bash
sudo cp deploy/maister-supervisor.service deploy/maister-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now maister-supervisor
sudo systemctl enable --now maister-web
journalctl -u maister-supervisor -u maister-web -f      # pino logs land in journald
```

Both units run as `maister` and execute Node directly, from `/opt/maister/web`
and `/opt/maister/supervisor` respectively. Their explicit `PATH` includes
`node_modules/.bin` for the agent adapters. They read different env files:
`maister-web.service` reads
`/etc/maister/maister.env`; `maister-supervisor.service` reads its own
`/opt/maister/supervisor/.env` (seed it from `supervisor/.env.sample`). Runtime
data roots and host storage limits belong to the supervisor. Edit the unit
`PATH=` / paths if your layout differs.

After starting the units, open `/admin/scheduler` and confirm the clock card
shows `fallback_timer` and recent successful core-job attempts. External-clock
installs should invoke one authenticated tick, then confirm the durable attempt
timestamp. If the card reports `missing_tick`, correct the EnvironmentFile and
restart `maister-web`; restarting without an actual external invocation does
not repair the clock.

The main process receives SIGTERM and drains its work before exiting. Both
units use `KillMode=mixed`: systemd sends the initial signal to the main process
and kills remaining children after exit or the 30-second stop deadline. This
allows the supervisor to mark intentional shutdown and drain agent output
before child termination. See the [systemd kill contract](https://github.com/systemd/systemd/blob/main/man/systemd.kill.xml).

### Stand helper preflight

Install the helper unit and copy the example helper environment and target
JSON into `/etc/maister` on the disposable Linux stand. Run the helper under
one dedicated service account with one private `StateDirectory` for that
service namespace. Place all aliases for a unit in the same helper
configuration. Use Node 24, util-linux `flock`, `systemctl` and `journalctl`.
Start from the supplied configuration examples in `deploy/`.

1. Provision a reviewed target, component, runbook witness and separate
   operator recovery and restart grants. Copy the exact target ID,
   incarnation, configuration revision and component into the helper JSON.
2. Configure the Web authority listener in `/etc/maister/maister.env`. Set
   the target's helper credential there. Configure the supervisor target
   mapping in its own env file. Install the distinct platform-to-helper
   credential as a file on the supervisor and helper.
3. Give the helper account read access to the configured unit and its
   journal. For system scope, grant restart through a polkit rule matching
   the service account, exact unit and restart verb. For user scope, run the
   helper as the configured numeric UID and provision that user's manager
   and D-Bus session. Grant service-manager permissions only for the
   configured scope and units.
4. Run the helper unit on the disposable target. Its `ExecStartPre` checks
   config and readable credential files, opens the private journal, reads
   each systemd unit's state and binds the configured TCP address and port.
   Look for `stand_helper_preflight_passed` and
   `stand_helper_listening`. Web logs `stand authority listener ready`
   after its TLS listener binds successfully. Ensure firewalls permit the
   supervisor to reach the helper and the helper to reach the Web authority
   listener over the dedicated endpoints.
5. Read the helper's `/identity` with the pinned supervisor client and
   verify the reviewed target incarnation and revision. Exercise a live
   observation through MAIster to check both mTLS directions and current
   authority. Read bounded logs under the helper account. Perform a separately
   approved restart only on the disposable unit, then verify post-action
   health and inspect the two independent receipts.

The MAIster application images and Postgres-only Compose setup do not
provide a systemd environment for the helper. See
[stand configuration](configuration.md#company-specialist-and-stand-configuration)
and [recovery](system-analytics/stand-maintenance.md#recovery-and-current-responsibility).

## 8. Reverse proxy + TLS

```bash
sudo cp deploy/maister-web.nginx.conf /etc/nginx/sites-available/maister
sudo ln -s /etc/nginx/sites-available/maister /etc/nginx/sites-enabled/
sudo certbot --nginx -d maister.example.com       # provisions + renews TLS
sudo nginx -t && sudo systemctl reload nginx
```

The proxy disables buffering on `/api/runs/` — the run-event SSE stream stalls
behind a buffering proxy. (Caddy: `reverse_proxy 127.0.0.1:3000` with
`flush_interval -1` for that path.)

## 9. Firewall

```bash
sudo ufw allow 22/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Do **not** open `:7777` or `:5432` — they bind loopback and are reached only by
the local web/supervisor processes.

## 10. Smoke test

```bash
curl -fsS http://127.0.0.1:7777/health        # supervisor: {"status":"ready",..., "host":{"hostKey":"eh_…","bootId":"…","protocolVersion":1}}
curl -fsS http://127.0.0.1:3000/ >/dev/null    # web responds
pnpm --filter @maister/mcp verify:stdio-contract  # run from the release checkout on the execution host
journalctl -u maister-web -n 200 | grep execution-host-registered   # (ADR-166) the web tier registered the host
journalctl -u maister-supervisor -n 50 | grep execution-host-key-conflict  # MUST be empty — a hit means a MAISTER_EXECUTION_HOST_KEY pin conflicts with the stored identity (unset the pin or wipe the state dir)
```

Then open `https://maister.example.com/login` and sign in with the seeded admin.

The MCP check compares the running stdio server's `tools/list` with the release
schemas. For a split-host deployment, install the same revision on each
execution host and check its effective facade command. If
`MAISTER_MCP_FACADE_COMMAND` is set, pass that command and its actual arguments
after `verify:stdio-contract`. The check needs neither a project token nor a
running web service.

## 11. Updates

Build the selected revision in a separate release checkout. Keep repository storage, runtime data and service credentials at their configured persistent paths. After the build completes, drain the old processes and switch the units to the new release. Retain the old release until its processes have exited.

For an installation using the single checkout in the example units, schedule downtime before updating its files. Drain active work and settle accepted project configuration publications. Keep a database backup from the same release as the old application.

```bash
sudo systemctl stop maister-web maister-supervisor
cd /opt/maister
git pull --ff-only
pnpm install --frozen-lockfile
pnpm --filter maister-web build
set -a; . /etc/maister/maister.env; set +a
sudo systemctl stop maister-web
pnpm --filter maister-web db:migrate
sudo systemctl restart maister-supervisor
sudo systemctl start maister-web
```

Stop every Web replica on the database before the execution-plane cutover.
On its first boot after migration `0378`, the new Web rechecks the exact
released-session crashes before it starts its projectors. This also repairs
crashes an old Web projector skipped between migration and shutdown. The
repair and its completion marker commit together.

Migrations 0369–0371 transfer package export ownership to project declarations and validate stored dependency sources. Stop old CLI and web writers before applying them. When new declarations exist, rollback requires the matching pre-cutover database backup. If source validation fails, use the reported project, declaration or attachment ID to repair the stored coordinates and retry.

Run the MCP contract check from the smoke test before starting new agent runs.

Restart `maister-supervisor` during a quiet window: it drops its in-memory ACP
session registry, so `Running` runs orphan until startup reconciliation lands
(ADR-033..036). **(ADR-166)** The first start after the
execution-host upgrade mints the host identity into the state dir and the web
tier registers it. There is NO backfill: restart the supervisor FIRST (drain
recommended) — its pre-ADR-166 sessions die with the old process, and every
in-flight run follows the supervisor-restart semantics above (`Running` runs
are classified by the reconcile sweep — re-driven or `Crashed`; `NeedsInput`
runs are assigned lazily when the keep-alive sweeper checkpoints them, WARN
`legacy-run-assigned-lazily`). Runs that finished before the upgrade keep
`runs.execution_assignment_id = NULL` forever. A supervisor that was
unreachable when the web tier booted is picked up by the next command
resolution or the periodic system sweep.

## 12. Backup

```bash
docker compose exec -T postgres pg_dump -U maister maister | gzip > maister-$(date +%F).sql.gz
```

Also back up `/etc/maister/maister.env` and `supervisor/.env` (secrets) and the
project repos / `.maister/` run artifacts as needed.

## Agent memory vault cutover

Apply the main database migrations and back up the database and legacy runtime
root before activation. Stop services that still write legacy agent memory
files and drain their execution contexts. Set `MAISTER_RUNTIME_ROOT` to the
legacy root and use the web service database environment.

```bash
pnpm --filter maister-web agent-memory:import
pnpm --filter maister-web agent-memory:import --import --actor-user-id <admin-id>
pnpm --filter maister-web agent-memory:import --activate --actor-user-id <admin-id>
```

The first command previews the source inventory. The import can be retried.
Activation checks that every inventoried source has a retained receipt, refuses
file or owner drift and switches the compatible binary to the Postgres vault.
Keep the original project and agent identities resolvable until cleanup.
An interrupted inventory from before stable owner capture with no retained
destination cannot be verified. Restore the matching pre-import backup
before retrying that inventory. Review
the import counts and probe the Memory tab before cleaning up legacy files.
An optional and separately invoked `--cleanup --actor-user-id <admin-id>`
removes verified sources and leaves mismatched snapshots available for
investigation. After activation, use a vault-compatible binary for service
rollback or restore a consistent backup of the database and runtime root.

Vault caps belong in the web service environment. [Agent memory vault limits](configuration.md#agent-memory-vault-limits-adr-210)

## 13. Engine 3.0.0 Postgres/graph-only upgrade

This upgrade is intentionally non-rolling and irreversible after migration
0094 drops `step_runs`. The main-lineage sequence is 0094 followed by the
data-only 0095 stale-C2-claim closure and 0096 cut-over-event indexes. Complete
these steps in order:

1. Inventory every cached, stored and first-party Flow manifest. Republish any
   attached/enabled steps[] Flow as nodes[]; do not convert it in place.
2. Run the actionable-run identity preflight below. It **must return zero
   rows** before the maintenance window; migration 0094 aborts on the same
   predicate rather than guessing an authoritative manifest.
3. List unfinished legacy runs and finish them or explicitly accept that the
   upgrade will mark them Failed.
4. Back up Postgres and verify the dump can be read.
5. Stop both web and supervisor. Do not migrate while either process can write.
6. Run the main migration through 0096 (0094 D2/D1, then 0095 stale-C2-claim
   closure and 0096 indexes), then run/check the separate Brain migration lineage.
7. Start supervisor and web. Verify there is no actionable legacy run, every
   active package is graph-compatible, the 0095 stale-claim query below returns
   zero rows, D2 tasks are held rather than C2-auto-launched, and the scheduler
   admits other eligible graph work.
8. Retain the pre-upgrade backup. Restore it with both processes stopped if the
   release must be rolled back; there is no down-migration or reconstructed
   step history.

The following read-only SQL is the migration-0094 identity preflight. It mirrors
the migration's abort guard for every actionable Flow run. Resolve every row by
restoring its authoritative pinned revision/Flow relationship or by making the
run terminal before migration; do not proceed while this query returns rows.

~~~sql
WITH actionable AS (
  SELECT
    r.id,
    r.status,
    r.project_id,
    r.flow_id,
    r.flow_revision_id,
    fr.id AS resolved_revision_id,
    f.id AS resolved_flow_id,
    CASE
      WHEN r.project_id IS NULL THEN 'missing_project_id'
      WHEN r.flow_revision_id IS NOT NULL AND fr.id IS NULL
        THEN 'missing_pinned_revision'
      WHEN r.flow_revision_id IS NOT NULL AND f.id IS NULL
        THEN 'missing_flow_for_pinned_revision'
      WHEN r.flow_revision_id IS NOT NULL
        AND fr.flow_ref_id <> f.flow_ref_id
        THEN 'pinned_revision_flow_ref_mismatch'
      WHEN r.flow_revision_id IS NULL AND f.id IS NULL
        THEN 'missing_fallback_flow'
      WHEN r.flow_revision_id IS NOT NULL AND fr.manifest IS NULL
        THEN 'missing_pinned_manifest'
      WHEN r.flow_revision_id IS NULL AND f.manifest IS NULL
        THEN 'missing_fallback_manifest'
      ELSE NULL
    END AS identity_problem
  FROM runs r
  LEFT JOIN flow_revisions fr ON fr.id = r.flow_revision_id
  LEFT JOIN flows f ON f.id = r.flow_id
  WHERE r.run_kind = 'flow'
    AND r.status IN (
      'Pending', 'Running', 'NeedsInput', 'NeedsInputIdle',
      'HumanWorking', 'WaitingOnChildren', 'Review', 'Crashed'
    )
)
SELECT
  id,
  status,
  project_id,
  flow_id,
  flow_revision_id,
  resolved_revision_id,
  resolved_flow_id,
  identity_problem
FROM actionable
WHERE identity_problem IS NOT NULL
ORDER BY status, id;
~~~

The following read-only SQL identifies the D2 actionable legacy set. Pinned
revision manifests are authoritative; only unpinned rows use the flows cache.

~~~sql
WITH authoritative AS (
  SELECT
    r.id,
    r.status,
    CASE
      WHEN r.flow_revision_id IS NOT NULL THEN fr.manifest
      ELSE f.manifest
    END AS manifest
  FROM runs r
  LEFT JOIN flow_revisions fr ON fr.id = r.flow_revision_id
  LEFT JOIN flows f ON f.id = r.flow_id
  WHERE r.run_kind = 'flow'
)
SELECT id, status
FROM authoritative
WHERE manifest ? 'steps'
  AND status IN (
    'Pending', 'Running', 'NeedsInput', 'NeedsInputIdle',
    'HumanWorking', 'WaitingOnChildren', 'Review', 'Crashed'
  )
ORDER BY status, id;
~~~

After the main migration completes, the following read-only SQL verifies 0095.
It is the exact stale-C2-claim predicate: a claim that predates or equals its
task's durable D2 event must have been cleared; a later claim is intentionally
outside this query and remains untouched.

~~~sql
WITH cutover_tasks AS (
  SELECT
    de.task_id,
    MAX(de.occurred_at) AS cutover_occurred_at
  FROM domain_events de
  WHERE de.kind = 'run.failed'
    AND de.task_id IS NOT NULL
    AND de.payload->>'reason' = 'legacy_steps_engine_3_cutover'
    AND de.payload->>'source' = 'upgrade_cutover'
  GROUP BY de.task_id
)
SELECT
  t.id AS task_id,
  t.queue_claimed_at,
  c.cutover_occurred_at
FROM tasks t
JOIN cutover_tasks c ON c.task_id = t.id
WHERE t.queue_claimed_at IS NOT NULL
  AND t.queue_claimed_at <= c.cutover_occurred_at
ORDER BY c.cutover_occurred_at, t.id;
~~~

Before admitting traffic after 0094, verify that no actionable legacy Flow run
survived the D2 transaction. The result **must be empty**:

~~~sql
WITH authoritative AS (
  SELECT
    r.id,
    r.status,
    CASE
      WHEN r.flow_revision_id IS NOT NULL THEN fr.manifest
      ELSE f.manifest
    END AS manifest
  FROM runs r
  LEFT JOIN flow_revisions fr ON fr.id = r.flow_revision_id
  LEFT JOIN flows f ON f.id = r.flow_id
  WHERE r.run_kind = 'flow'
)
SELECT id, status
FROM authoritative
WHERE manifest ? 'steps'
  AND status IN (
    'Pending', 'Running', 'NeedsInput', 'NeedsInputIdle',
    'HumanWorking', 'WaitingOnChildren', 'Review', 'Crashed'
  )
ORDER BY status, id;
~~~

Restart **supervisor before web**. D2 clears persisted ACP handles, so an old
supervisor process cannot be recovered from the database after the migration.
The first web reconciliation sweep stops any still-live supervisor session whose
`runId` has the durable D2 event; confirm the supervisor session list contains
none of the D2 run ids before treating the upgrade as complete.

After restart, C2 reads a task's latest Flow run and exact D2 event. If the
task has no `launch_armed_at` after that event, it is atomically flagged with a
system explanation; C2 neither acquires another claim nor calls `launchRun`.
This one-time hold is expected and is not an automatic retry. Republish or
repair the Flow, then explicitly re-triage the task to create a later arm before
allowing a new automatic attempt.

Run this read-only D1 impact query **before** migration 0094. It intentionally
references `step_runs` to report the terminal legacy detail that will be lost;
it must not be run after 0094 drops that table:

~~~sql
WITH authoritative AS (
  SELECT
    r.id,
    r.status,
    CASE
      WHEN r.flow_revision_id IS NOT NULL THEN fr.manifest
      ELSE f.manifest
    END AS manifest
  FROM runs r
  LEFT JOIN flow_revisions fr ON fr.id = r.flow_revision_id
  LEFT JOIN flows f ON f.id = r.flow_id
  WHERE r.run_kind = 'flow'
),
terminal_legacy AS (
  SELECT id
  FROM authoritative
  WHERE manifest ? 'steps'
    AND status IN ('Done', 'Failed', 'Abandoned')
)
SELECT
  count(DISTINCT terminal_legacy.id) AS completed_legacy_runs,
  count(step_runs.id) AS step_detail_rows_lost
FROM terminal_legacy
LEFT JOIN step_runs ON step_runs.run_id = terminal_legacy.id;
~~~

Inventory logs contain counts and identifiers only. Never print manifest bodies
or database credentials.

- **Supervisor restart records lost turns; it does not prove adapter exit.**
  Startup converts accepted non-live prompt receipts to durable `turn_lost`;
  manager command and run reconciliation applies the checkpoint/crash policy.
  An adapter can survive supervisor process death. Replacement of an unfinished
  create and workspace cleanup require positive host retirement proof for the
  exact original command, run, assignment and epoch. A live or unknown process
  group, an empty new registry and unstamped historical receipts leave the
  original create unresolved. Follow the [supervisor receipt recovery contract](supervisor.md#command-envelope-fences-and-receipts-implemented--adr-166);
  restarting again or deleting the checkout does not establish retirement.
- **Default single-host deployment.** The web tier needs no supervisor runtime-data mount:
  events replay from the host outbox into canonical Postgres state and runtime
  bytes use opaque object APIs. The selected-supervisor pilot qualifies a
  limited path from board launch through Review. See the
  [local pilot configuration](#selected-supervisor-local-pilot) and
  [ADR-167](decisions/adr-167.md).
- **No managed git secrets.** Provider auth lives in the host's SSH/credential config, not in MAIster ([ADR-025](decisions.md#adr-025-project-repo-onboarding--url-clone-or-local-path-host-credential-auth-configurable-roots)). Git auth is **host-ambient** — ssh-agent/keys, the credential helper, optional `gh`, and the one-off Add-project token (Implemented, [ADR-093](decisions.md#adr-093-project-onboarding--optional-maisteryaml-host-ambient-git-auth-onboarding-modes-advisory-clone-reasons)). **Persist-config push and remote push/fetch reuse this same host-ambient auth** — there is no managed credential store, and on an auth failure the action returns an advisory without rolling back the local commit / DB state.

### Selected supervisor local pilot

The local Chrome fixture qualifies pinned checkout, project checks, Review,
publication, archive, cancellation and checkpoint recovery on one selected
supervisor. It starts production Web and the supervisor under separate Linux
service identities on a disposable instance. Keep the endpoint private to
the control plane.

For an endpoint beyond loopback, use a private network or VPN and restrict
ingress to the Web tier. The stable key is visible in `/health` and validates
routing identity. Protect the entire supervisor listener, including the
legacy session and runtime-object routes, at the network boundary.

1. Start the supervisor using `deploy/maister-supervisor.service` and its own
   `supervisor/.env`. Set `MAISTER_RUNTIME_ROOT` and
   `MAISTER_EXECUTION_HOST_STATE_DIR` to private durable directories. For an
   explicit `MAISTER_WORKSPACE_ROOTS`, include an existing private ancestor
   of the managed workspace root. The supervisor must be able to write there.
2. Put the project ID and the approved source in the supervisor's
   `MAISTER_WORKSPACE_REPOSITORIES` map. Set up Git access under its OS account.
   Record `host.hostKey` from its `GET /health` response.
3. Set the Web unit's `MAISTER_SUPERVISOR_URL` to that HTTP(S) origin and set
   `MAISTER_SELECTED_EXECUTION_HOST_KEY` to the recorded key. Use
   `MAISTER_SELECTED_EXECUTION_HOST_PROJECT_IDS` to select the pilot project
   IDs. Apply required PostgreSQL migrations before starting Web.
4. Launch an eligible project Flow from the board and select the supervisor.
   In the local fixture, Web received `EACCES` on the repository and host
   runtime directories and still displayed the sealed result and diff.

The PostgreSQL-only Compose files provide the database for these
service units. The [Stage C acceptance plan](../.ai-factory/plans/feature-stage-c-selected-supervisor.md)
records local qualification and the gates for a deployed instance.

#### Local two-supervisor pilot

Start a second supervisor with its own network namespace, service identity,
SQLite directory and workspace root. Give it a separate approved checkout
or Git source for the same project. Record its stable key from `/health` and
set `MAISTER_ADDITIONAL_EXECUTION_HOSTS` on Web. The operator supplies its
private origin, stable key, display name and optional project allowlist and
concurrency limit. The board can select either eligible supervisor. The admin
screen displays each registered identity, its last observation and drain state.

Before enabling the second supervisor, apply PostgreSQL migrations `0396`
and `0397` and drain Web processes using the older singleton registry writer.
Retain both endpoint descriptors while either host has retained work. To drain
new work on B, set its descriptor's `draining` field to `true` and reload Web.
Existing work stays with its owner. If the host becomes unreachable, restore
the configured endpoint with the original SQLite and workspace bytes to
reconcile delayed receipts. A new key requires operator review and cannot
take over retained work from the old key.

For a permanent loss, first isolate the original machine outside MAIster.
Power it off or revoke its access to every affected Git provider, runtime
credential and control-plane endpoint. Record the independent isolation
evidence in your incident system. An unreachable endpoint alone leaves the
host recoverable.

Use the stable key and `last_boot_id` from the Web database and the ID of an
active global administrator. Check the key and boot ID against the host you
isolated before recording loss.

```sql
SELECT host_key, last_boot_id, readiness, retired_at FROM execution_hosts;
```

Run the command from the Web deployment with its own database configuration.

```bash
pnpm --filter maister-web execution:host:declare-lost \
  --host-key "$lost_host_key" --observed-boot "$last_observed_boot" \
  --operator-id "$administrator_id" --isolation-evidence "$incident_reference" --apply
```

The permanent record retires the identity and moves its affected active Runs
to Abandoned. It preserves their assignments, workspaces, writer claims and
receipts. Inspect repository and PR effects separately. For a lost default,
point Web's default endpoint and key to the surviving supervisor and remove
that supervisor's additional-host descriptor. Its registered ID and ownership
carry over. Update any project defaults explicitly pinned to the lost host.
Launch fresh Runs through normal admission.

Take backups during a maintenance window after both hosts have drained and
Web and supervisors have stopped writing. Capture PostgreSQL and each host's
SQLite, repository, workspaces and runtime objects as one coordinated set.
Retain the original host names, paths and configuration with the backup.
Restore the set to an isolated network first. Verify both stable keys and
their distinct boot IDs, original assignments, command receipts, retained
Review and dirty work before resuming writes. Reconcile any external Git
publication before restoring an older set. The registry fences software that
only supports a singleton while a peer is active or retains ownership.

## 14. Stage B execution-data cut-over (upgrade from Stage A)

**(Implemented — S4.1–S4.7; procedure D9 in
[execution-data-cutover](system-analytics/execution-data-cutover.md).)** An
installation that already holds runs under the old file-based runtime root
(`<MAISTER_RUNTIME_ROOT>/.maister/<slug>/runs/<runId>/`) must preserve every
byte of that history on the execution host and prove it before migration
`0135` may flip the runs to the canonical event plane. A plain `db:migrate`
refuses at `0135` until that proof exists; this is the only supported path.
Every step is idempotent and resumable, every refusal carries a remediation
code, and no step deletes, moves or rewrites a source file. Source deletion is
a separate retention decision after acceptance — never part of generating
proof.

If the inventory (step 4) reports zero legacy runs — a Stage A installation
that never ran a flow — there is nothing to preserve: skip steps 5–9 and run
the finalize stage (step 10) directly; unchanged `0135` is satisfied vacuously,
exactly as on a fresh install.

Choose, once, an import id (`^[A-Za-z0-9._:-]{1,64}$`) and a durable,
operator-owned manifest directory (`0700`) outside the web process's OS
authority — never under `~/.maister` and never a temporary directory:

```bash
export IMPORT_ID=cutover-2026-09
export MANIFEST_DIR=/var/lib/maister-import/$IMPORT_ID
export MAISTER_LEGACY_RUNTIME_ROOT=/opt/maister/runtime   # the frozen Stage A root
export MAISTER_IMPORT_ADMISSION_DIR=$MANIFEST_DIR          # the CLI takes --manifest-dir from it
```

1. **Preliminary backup.** Postgres (§12), the supervisor state dir and
   runtime root, the legacy runtime root and the adapter journals. Record the
   digests, the software revision and the ledger high-water
   (`select max(created_at) from drizzle.__drizzle_migrations`).
2. **Drain and freeze.** Set `MAISTER_UPGRADE_MAINTENANCE=1` on every web
   process and restart them: no run is admitted, no agent turn starts, no
   scheduler job is claimed, no sweep runs, while cancel, checkpoint and HITL
   delivery stay open. Bring every legacy run to a terminal status through the
   ordinary controls — the importer and the destructive stages refuse
   `active_legacy_work` otherwise. Stop the old web binaries. Now take the
   **final coordinated snapshot**: the Postgres dump, the supervisor state dir
   and runtime root (supervisor stopped), the legacy root and — once it exists
   — the manifest directory. Restore that set to disposable storage and confirm
   it boots before continuing; AT-11 restores exactly this set and completes
   the cut-over from it.
3. **Additive stage** — everything through `0133`, nothing destructive:
   ```bash
   pnpm --filter maister-web db:migrate --stage execution-ab-additive
   ```
4. **Inventory** — no supervisor needed; freezes every source of every legacy
   run into `$MANIFEST_DIR/import-$IMPORT_ID.sqlite`, the only place a raw
   source path is written:
   ```bash
   pnpm --filter maister-web execution-data-plane:import-legacy inventory --import-id $IMPORT_ID
   ```
   A refusal names the run and the reason (`unclassified_source`,
   `non_regular_source`, `missing_association_payload`); fix the cause, never
   the manifest. Re-run it only before step 6.
5. **Supervisor in import mode, then copy.** Start the supervisor with
   `MAISTER_IMPORT_ADMISSION_DIR=$MANIFEST_DIR` and
   `MAISTER_IMPORT_ADMISSION_ID=$IMPORT_ID`; take the generation from its
   `import_admission_enabled` log line — every restart mints the next one and
   refuses the previous:
   ```bash
   pnpm --filter maister-web execution-data-plane:import-legacy copy --import-id $IMPORT_ID --generation <n>
   ```
   Interrupting it loses nothing: a re-run continues at the host's committed
   chunk offset and reports every already-sealed item as skipped.
6. **Associate** — catalogues every sealed object for the ordinary read path
   on the host that sealed it and repoints every artifact locator and scratch
   attachment at it, one row per transaction under an exact old-row CAS. The
   manager must already know the host by the key the supervisor reports (the
   web boot registered it); `execution_host_missing` means it does not — boot
   the current web tier once under the maintenance fence, then re-run:
   ```bash
   pnpm --filter maister-web execution-data-plane:import-legacy associate --import-id $IMPORT_ID --generation <n>
   ```
7. **Rows** — reconstructs each run's canonical `execution_events` from the
   frozen manifest (no host needed) and completes nothing:
   ```bash
   pnpm --filter maister-web execution-data-plane:import-legacy rows --import-id $IMPORT_ID
   ```
8. **Verify, then `0134`, then verify again** — the proof streams every
   sealed object back through the host, re-hashes the source freeze, reads
   every repointed row back and requires the reconstructed rows:
   ```bash
   pnpm --filter maister-web execution-data-plane:import-legacy verify --import-id $IMPORT_ID --generation <n>
   pnpm --filter maister-web db:migrate --stage execution-ab-associations
   pnpm --filter maister-web execution-data-plane:import-legacy verify --import-id $IMPORT_ID --generation <n>
   ```
9. **Finalize the proof** — the only writer of a `complete` lane record; it
   writes none unless every lane of every run holds:
   ```bash
   pnpm --filter maister-web execution-data-plane:import-legacy finalize-proof --import-id $IMPORT_ID --generation <n>
   ```
10. **Finalize stage** — unchanged `0135`–`0136`, then every forward migration
    including `0169`, the writer floor: a proven lane is final, an undeclared
    writer is refused by class, and a binary refuses a ledger ahead of its
    journal.
    ```bash
    pnpm --filter maister-web db:migrate --stage execution-ab-finalize
    ```
11. **Start the current web tier with the legacy root inaccessible** and
    without the import variables; qualify history, transcripts, cost,
    artifacts, HITL and resume through the ordinary UI/API. Then **revoke the
    import authority**: stop the supervisor, unset
    `MAISTER_IMPORT_ADMISSION_DIR` and `MAISTER_IMPORT_ADMISSION_ID`, restart
    it — admission is disabled at shutdown and no request can reopen it — and
    remove `$MANIFEST_DIR`, which holds the only copy of the raw source map.
    Clear `MAISTER_UPGRADE_MAINTENANCE`. Keep the sources and the snapshot set
    until retention allows their removal.

Rollback: before `0134`, restore the step-2 snapshot set as one fenced
installation and restart the old release. After `0134`/`0135` the default is
forward repair; a downgrade restores Postgres, host state and sources
together, never one side of the set.

## 15. Durable scratch reply projection (S5.2)

**Non-rolling.** Stop every old web instance before starting the new ones.
This release moves scratch reply content off the request-local writer onto the
canonical transcript projector; mixed versions would run BOTH writers against
the same run, which is not a qualified configuration. Retained messages stay in
place — the change rewinds no cursor and does not repair previously skipped
history. Supervisor and database need no coordinated step. See
[scratch runs](system-analytics/scratch-runs.md) and the
[event-plane ownership contract](system-analytics/execution-event-plane.md).

## Running the MCP facade

The `mcp/` package (`@maister/mcp`) is a standalone MCP server that wraps the
`/api/v1/ext/*` REST API. It is **separate from the web and supervisor
processes** and is only needed when you want to expose MAIster tools to an MCP
client (e.g. Claude Desktop, an agent harness).

### stdio (local, env token)

Suitable for local use where the MCP client and MAIster web tier run on the
same machine. The token is read from the environment — it must be a valid
project API token created in Project Settings or a personal access token
created from Account.

```bash
export MAISTER_API_BASE_URL=http://localhost:3000
export MAISTER_PROJECT_TOKEN=mai_<your-token>
pnpm --filter @maister/mcp start --stdio
```

For personal-agent workflows, use the fallback variable when no project token is
set:

```bash
export MAISTER_API_BASE_URL=http://localhost:3000
export MAISTER_ACCESS_TOKEN=mai_<your-personal-token>
pnpm --filter @maister/mcp start --stdio
```

Or force the transport via env: `MCP_TRANSPORT=stdio`.

**Security note:** `MAISTER_PROJECT_TOKEN` is scoped to a single project;
`MAISTER_ACCESS_TOKEN` follows the owning user's current project access and may
span multiple projects. Never use the stdio transport across a network boundary
— the token would be exposed in transit. For remote use, use Streamable-HTTP
instead.

### Streamable-HTTP (remote, per-request inbound bearer)

Default when `--stdio` / `MCP_TRANSPORT=stdio` is not set. The server listens
on `:3001` (override with `MCP_PORT`) at `POST /mcp` and `GET /health`.

```bash
export MAISTER_API_BASE_URL=https://maister.example.com
pnpm --filter @maister/mcp start
```

The MCP server **never holds an ambient token** under this transport. Each
`POST /mcp` request must carry an `Authorization: Bearer <token>` header, which
the server forwards verbatim to `/api/v1/ext`. A request without a bearer
header returns an MCP tool error with status 401 and makes zero REST calls
(ADR-042).

**Binding / exposure:** the server binds `0.0.0.0:3001`. Put it behind your
reverse proxy (e.g. nginx) and enforce TLS before exposing it externally. The
`Authorization` header must be forwarded by the proxy (`proxy_pass_header
Authorization` in nginx).

**Reject-unauthenticated guarantee:** the server never falls back to an env
token when the inbound bearer is missing. There is no `MAISTER_PROJECT_TOKEN` or
`MAISTER_ACCESS_TOKEN` fallback under HTTP.

## Linked artifacts

- [`deploy/`](../deploy) — systemd units, env template, nginx config.
- [`configuration.md`](configuration.md) — full environment variable reference.
- [`getting-started.md`](getting-started.md) — local dev setup + seeded credentials.
- ADR-023 (host-run topology), ADR-025 (repo onboarding), ADR-022 (run-data projection), ADR-049 (PR-mode promotion — host `gh`/`glab` / Gitea-API token prerequisites), ADR-166 (execution-host state dir + workspace roots).
