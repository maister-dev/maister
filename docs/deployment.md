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
- **Agent adapters** ship as workspace dependencies — `pnpm install` provides `claude-agent-acp` and `codex-acp` under `node_modules/.bin`. **No `gh` or other provider CLI is required** by MAIster.
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
pnpm --filter maister-web build          # next build (required before `start`)
```

## 3. Postgres (Docker)

`compose.yml` defines only Postgres, published on `127.0.0.1:5432`:

```bash
cd /opt/maister
docker compose up -d postgres            # add: -f compose.yml -f compose.production.yml  for hardening
```

Enable Docker on boot (`sudo systemctl enable docker`) so Postgres restarts with
the host (`restart: unless-stopped` handles the container itself).

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
- `ANTHROPIC_API_KEY` (and/or `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`).
- `POSTGRES_PASSWORD` / `DB_URL` — keep `@localhost:5432`.

`MAISTER_RUNTIME_ROOT` MUST equal the checkout dir (`/opt/maister`) for both
services — supervisor and web resolve `.maister/` from it, so a mismatch breaks
the run event stream.

Apply migrations and seed the first admin:

```bash
cd /opt/maister
set -a; . /etc/maister/maister.env; set +a
pnpm --filter maister-web db:migrate
pnpm --filter maister-web db:seed        # initial admin user — see getting-started.md for credentials
```

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
`MAISTER_TRUSTED_CAPABILITY_SOURCE_PREFIXES` (see `configuration.md`). MAIster's git work (clone, worktree
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

## 6. Agent credentials (headless)

The supervisor passes its process environment to spawned agents, so the API
keys in `maister.env` reach `claude-agent-acp` / `codex-acp` — **no interactive
agent login is needed** on the VPS (env-router model,
[ADR-005](decisions.md#adr-005-model-routing-env-router-default-ccr-optional)).
Per-executor `env` in `maister.yaml` overrides these process-wide defaults.

## 7. systemd services

```bash
sudo cp deploy/maister-supervisor.service deploy/maister-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now maister-supervisor
sudo systemctl enable --now maister-web
journalctl -u maister-supervisor -u maister-web -f      # pino logs land in journald
```

Both units run as `maister`, `WorkingDirectory=/opt/maister`, read
`/etc/maister/maister.env`, and start through `pnpm` so `node_modules/.bin`
(the agent adapters) is on `PATH`. Edit the unit `PATH=` / paths if your layout
differs.

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
pnpm --filter maister-web build
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

Also back up `/etc/maister/maister.env` (secrets) and the project repos /
`.maister/` run artifacts as needed.

## Operational caveats

- **Supervisor restart orphans live runs** until M19 reconciliation. `Restart=always` recovers the process, not in-flight sessions.
- **Single host only.** Multi-host (supervisor on a separate machine) needs durable HTTP replay from `run.events.jsonl` — deferred ([ADR-022](decisions.md#adr-022-structured-run-data-projection--runeventsjsonl-is-the-event-log-postgres-holds-derived-read-models)).
- **No managed git secrets.** Provider auth lives in the host's SSH/credential config, not in MAIster ([ADR-025](decisions.md#adr-025-project-repo-onboarding--url-clone-or-local-path-host-credential-auth-configurable-roots)).

## Linked artifacts

- [`deploy/`](../deploy) — systemd units, env template, nginx config.
- [`configuration.md`](configuration.md) — full environment variable reference.
- [`getting-started.md`](getting-started.md) — local dev setup + seeded credentials.
- ADR-023 (host-run topology), ADR-025 (repo onboarding), ADR-022 (run-data projection).
