---
title: "Single-host deployment"
description: "Deploy MAIster on a Linux host with systemd, a local execution supervisor, Postgres, and a TLS reverse proxy."
---

This is the supported production topology: the web process and execution
supervisor run as unprivileged host services, Postgres runs locally, and a TLS
reverse proxy exposes only the web application.

## Topology

```text
client → TLS proxy → web :3000 → supervisor :7777
                         │              │
                         └→ Postgres    └→ agent adapters + git worktrees
```

Bind the supervisor and Postgres to loopback. Do not expose either port to the
public network.

## Host requirements

- Modern Linux with systemd
- Node.js 24, pnpm, git, and Docker
- Dedicated unprivileged service account
- Persistent directories for the checkout, repositories, runtime state, and
  agent credentials
- Provider authentication for any enabled pull-request promotion mode

## Build and database

```bash
pnpm install --frozen-lockfile
docker compose up -d postgres
pnpm --filter maister-web db:migrate
pnpm --filter maister-web db:migrate:brain
pnpm --filter maister-web build
```

The web build also builds the internal MCP facade used by agents.

Run the supervisor and web application as separate systemd services under the
same trusted service account. Set a strong `AUTH_SECRET`, a production `DB_URL`,
and the supervisor URL in the service environment.

## Reverse proxy

Terminate TLS at nginx, Caddy, or an equivalent proxy. Preserve streaming for
server-sent events and forward the original host and protocol headers. Route
only the web port; keep port `7777` private.

## Upgrades

Pin the source revision or image tag. Back up Postgres and runtime state before
an upgrade, install with the frozen lockfile, run both migration lineages, and
run `pnpm --filter maister-web build`. Restart the supervisor before the web
service. On each execution host, check the deployed facade with
`pnpm --filter @maister/mcp verify:stdio-contract`. Confirm adapter readiness and
launch a non-critical smoke Run before restoring normal traffic.

## Activate the agent memory vault

Apply the main database migrations. During a maintenance window, drain running
agents and stop services that can write legacy memory files. Back up Postgres
and the runtime directory together. Run the following from the checkout with
the web service’s database configuration and `MAISTER_RUNTIME_ROOT` pointing
to the original runtime directory. Set `ADMIN_ID` to an active global
administrator’s user ID.

```bash
pnpm --filter maister-web agent-memory:import
pnpm --filter maister-web agent-memory:import --import --actor-user-id "$ADMIN_ID"
pnpm --filter maister-web agent-memory:import --activate --actor-user-id "$ADMIN_ID"
```

The first command previews the inventory. Check for unresolved owners or
changed files before activation. Activation switches writes to Postgres after
verifying the imported files. Start the upgraded services and verify that you
can read an imported note and save an edit from the agent’s **Memory** tab.
Keep the originals until then. To return to a pre-vault release, restore the
matching database and runtime backups together. That restores notes to the
time of the backup.
