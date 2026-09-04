---
title: "Quickstart"
description: "Run MAIster locally, sign in, register a repository, and launch a first governed task."
---

This guide starts MAIster from source on one host. Only Postgres runs in Docker;
the web and supervisor processes run on the host because they launch agent
adapters and operate on local git repositories.

## Prerequisites

- Node.js 24
- pnpm
- git with worktree support
- Docker with Compose
- A local git repository to manage
- Credentials for at least one configured agent runtime

## 1. Install

```bash
git clone https://github.com/kanischev/mAIster.git
cd mAIster
pnpm install --frozen-lockfile
cp .env.example .env
```

Set a strong `AUTH_SECRET` in `.env`. Keep provider tokens and agent credentials
on the host; never add them to a project manifest.

## 2. Start Postgres and prepare the database

```bash
docker compose up -d postgres
pnpm --filter maister-web db:migrate
pnpm --filter maister-web db:migrate:brain
pnpm --filter maister-web db:seed
```

The Brain migration requires the pgvector-enabled Postgres image from the
repository's Compose file.

## 3. Start MAIster

Run these commands in separate terminals:

```bash
pnpm --filter @maister/supervisor dev
```

```bash
pnpm --filter maister-web dev
```

Open `http://localhost:3000/login`. Sign in with the seeded administrator
credentials from `.env`.

## 4. Register a repository

Open **Projects → Add project**, choose an existing repository directory, and
submit it. If the repository has no `maister.yaml`, MAIster creates a minimal
manifest. A present but invalid manifest is rejected and never overwritten.

## 5. Launch a task

1. Open the project board.
2. Create a task with an outcome and a Flow.
3. Launch the task.
4. Follow the Run page until the Flow finishes or requests human input.
5. Inspect the diff, evidence, and readiness state before promotion.

Success means the Run has an isolated workspace, a recorded Flow revision, and
an observable outcome. Promotion remains a separate, explicit action.

## Next steps

- [Understand Flows and Runs](concepts/flows-and-runs.md).
- [Respond to human-in-the-loop requests](guides/human-in-the-loop.md).
- [Review and promote accepted work](guides/review-and-promote.md).
