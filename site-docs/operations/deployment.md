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
pnpm --filter @maister/mcp build
```

Run the supervisor and web application as separate systemd services under the
same trusted service account. Set a strong `AUTH_SECRET`, a production `DB_URL`,
and the supervisor URL in the service environment.

## Reverse proxy

Terminate TLS at nginx, Caddy, or an equivalent proxy. Preserve streaming for
server-sent events and forward the original host and protocol headers. Route
only the web port; keep port `7777` private.

## Upgrades

Pin the source revision or image tag. Back up Postgres and runtime state before
an upgrade, install with the frozen lockfile, run both migration lineages, build
the applications, then restart the supervisor before the web service. Confirm
adapter readiness and launch a non-critical smoke Run before restoring normal
traffic.
