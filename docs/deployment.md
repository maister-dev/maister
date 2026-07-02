[← Getting started](getting-started.md) · [Back to README](../README.md)

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
 client ──TLS──▶ nginx :443 ──▶ web (next start) :3000  [systemd: maister-web]
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
- **Node 24** ([ADR-015](decisions.md#adr-015-pnpm-workspace-node-24)) installed system-wide (e.g. NodeSource), then `corepack enable` to provide `pnpm`.
- **git** and **Docker** (Docker only runs Postgres here).
- **Agent adapters** ship as workspace dependencies — `pnpm install` provides `claude-agent-acp` and `codex-acp` under `node_modules/.bin`. **No `gh` or other provider CLI is required for core operation** (clone, worktree, `local_merge` promotion). **Optional (Implemented, [ADR-093](decisions.md#adr-093-project-onboarding--optional-maisteryaml-host-ambient-git-auth-onboarding-modes-advisory-clone-reasons)):** the `gh` CLI, when present and authed, enables auto-token for `github.com` HTTPS clones — best-effort, never required. **Exception (Implemented, M18 — ADR-049):** `pull_request` promotion runs in the web tier and needs, per the run's provider, `gh`/`glab` on `PATH` (github/gitlab) **or** `GITEA_TOKEN`/`GITVERSE_TOKEN` in the web-tier env (gitea/gitverse), **plus** a git push credential helper. The **default compose does not provision** these — it is a host-operator concern ([ADR-023](decisions.md#adr-023-run-web--supervisor-on-the-host-containerize-only-postgres)). `local_merge` promotion needs none of them. See [`configuration.md`](configuration.md) for the per-provider table.
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
pnpm --filter maister-web build          # cleans .next, then next build (required before `start`)
```

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
> dir), so an existing dev volume upgrades in place. If the Brain is never enabled
> the extension is simply never created; in SQLite mode the Brain is disabled (D3).

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

`MAISTER_RUNTIME_ROOT` MUST equal the checkout dir (`/opt/maister`) for both
services — supervisor and web resolve `.maister/` from it, so a mismatch breaks
the run event stream.

Apply migrations and seed the first admin:

```bash
cd /opt/maister
set -a; . /etc/maister/maister.env; set +a
pnpm --filter maister-web db:migrate         # main lineage (all shared tables)
pnpm --filter maister-web db:migrate:brain   # brain lineage (brain_* + pgvector); no-op under SQLite (ADR-122)
pnpm --filter maister-web db:seed        # initial admin user — see getting-started.md for credentials
```

> **(ADR-122)** `db:migrate:brain` runs the separate Project-Brain migration
> lineage (own `_journal.json` + own ledger `__drizzle_brain_migrations`) AFTER
> the main lineage (`brain_*` FKs → `projects`/`runs`). It no-ops under SQLite. A
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
**Editable local packages (M36, ADR-096)** keep their git-backed working dirs
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

Both units run as `maister`, `WorkingDirectory=/opt/maister`, and start through
`pnpm` so `node_modules/.bin` (the agent adapters) is on `PATH`. They read
**different** env files: `maister-web.service` reads the shared
`/etc/maister/maister.env`; `maister-supervisor.service` reads its own
`/opt/maister/supervisor/.env` (seed it from `supervisor/.env.sample`; keep
`MAISTER_RUNTIME_ROOT` equal to the web unit's). Edit the unit `PATH=` / paths
if your layout differs.

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
curl -fsS http://127.0.0.1:7777/health        # supervisor: {"status":"ready",...}
curl -fsS http://127.0.0.1:3000/ >/dev/null    # web responds
```

Then open `https://maister.example.com/login` and sign in with the seeded admin.

## 11. Updates

```bash
cd /opt/maister && git pull
pnpm install --frozen-lockfile
pnpm --filter maister-web build          # cleans stale Next.js artifacts before rebuilding
set -a; . /etc/maister/maister.env; set +a
pnpm --filter maister-web db:migrate
sudo systemctl restart maister-supervisor maister-web
```

Restart `maister-supervisor` during a quiet window: it drops its in-memory ACP
session registry, so `Running` runs orphan until startup reconciliation lands
(ROADMAP M19).

## 12. Backup

```bash
docker compose exec -T postgres pg_dump -U maister maister | gzip > maister-$(date +%F).sql.gz
```

Also back up `/etc/maister/maister.env` and `supervisor/.env` (secrets) and the
project repos / `.maister/` run artifacts as needed.

## Operational caveats

- **Supervisor restart orphans live runs** until M19 reconciliation. `Restart=always` recovers the process, not in-flight sessions.
- **Single host only.** Multi-host (supervisor on a separate machine) needs durable HTTP replay from `run.events.jsonl` — deferred ([ADR-022](decisions.md#adr-022-structured-run-data-projection--runeventsjsonl-is-the-event-log-postgres-holds-derived-read-models)).
- **No managed git secrets.** Provider auth lives in the host's SSH/credential config, not in MAIster ([ADR-025](decisions.md#adr-025-project-repo-onboarding--url-clone-or-local-path-host-credential-auth-configurable-roots)). Git auth is **host-ambient** — ssh-agent/keys, the credential helper, optional `gh`, and the one-off Add-project token (Implemented, [ADR-093](decisions.md#adr-093-project-onboarding--optional-maisteryaml-host-ambient-git-auth-onboarding-modes-advisory-clone-reasons)). **Persist-config push and remote push/fetch reuse this same host-ambient auth** — there is no managed credential store, and on an auth failure the action returns an advisory without rolling back the local commit / DB state.

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
- ADR-023 (host-run topology), ADR-025 (repo onboarding), ADR-022 (run-data projection), ADR-049 (PR-mode promotion — host `gh`/`glab` / Gitea-API token prerequisites).
