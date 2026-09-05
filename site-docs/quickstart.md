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
- At least one coding agent to run on the supervisor host: Codex, Claude Code,
  OpenCode, Gemini CLI, or MiMo

## 1. Install

```bash
git clone https://github.com/maister-dev/maister.git
cd mAIster
pnpm install --frozen-lockfile
cp .env.example .env
```

Set a strong `AUTH_SECRET` in `.env`. Keep provider tokens and agent credentials
on the host; never add them to a project manifest.

## 2. Prepare a coding agent

MAIster cannot execute a Flow until the supervisor host has an authenticated
coding agent. `pnpm install` provides the Claude and Codex ACP adapters. For
example, authenticate Codex with:

```bash
pnpm --filter @maister/supervisor exec codex-acp login
```

For Claude Code, OpenCode, Gemini CLI, or MiMo, complete the agent's native
sign-in under the same operating-system account that runs the supervisor. The
Gemini, OpenCode, and MiMo executables must also be available on that account's
`PATH`. Provider secrets may instead be exposed to the supervisor through
environment references; never store them in a project manifest.

## 3. Start Postgres and prepare the database

```bash
docker compose up -d postgres
pnpm --filter maister-web db:migrate
pnpm --filter maister-web db:migrate:brain
pnpm --filter maister-web db:seed
```

The Brain migration requires the pgvector-enabled Postgres image from the
repository's Compose file.

## 4. Start MAIster

Run these commands in separate terminals:

```bash
pnpm --filter @maister/supervisor dev
```

```bash
pnpm --filter maister-web dev
```

Open `http://localhost:3000/login`. Sign in with the seeded administrator
credentials from `.env`.

## 5. Register the coding agent

Open **Settings → ACP runners**, create a profile for the authenticated agent,
and keep it disabled until diagnostics report **Ready**. Enable the profile and,
if appropriate, make it the installation default. Do not launch the first task
until at least one runner is enabled and Ready. See [Configure ACP runners and
models](/administration/runners-and-models) for provider routes, environment
references, and readiness rules.

## 6. Register a repository

Open **Projects → Add project**, choose an existing repository directory, and
submit it. If the repository has no `maister.yaml`, MAIster creates a minimal
manifest. A present but invalid manifest is rejected and never overwritten.

## 7. Launch a task

1. Open the project board.
2. Create a task with an outcome and a Flow.
3. Launch the task.
4. Follow the Run page until the Flow finishes or requests human input.
5. Inspect the diff, evidence, and readiness state before promotion.

Success means the Run has an isolated workspace, a recorded Flow revision, and
an observable outcome. Promotion remains a separate, explicit action.

## Next steps

- Follow the [application map](/product-tour/application-map).
- [Configure runners and models](/administration/runners-and-models).
- [Build or fork a Flow](/studio/flow-studio-and-packages).
- [Respond to human-in-the-loop requests](/guides/human-in-the-loop).
- [Review, rework, or take over work locally](/guides/review-rework-and-takeover).
