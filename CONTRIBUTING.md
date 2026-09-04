# Contributing to MAIster

Thank you for helping improve MAIster. Contributions can be code,
documentation, bug reports, design feedback, or reproducible operating
experience.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md),
not through an issue, discussion, or pull request.

## Before opening an issue

1. Search [existing issues](https://github.com/kanischev/mAIster/issues) and
   [discussions](https://github.com/kanischev/mAIster/discussions).
2. Check the [public documentation](https://docs.imaister.dev) and the
   [engineering docs](docs/).
3. Reduce bug reports to the smallest reproducible case and remove source code,
   logs, credentials, paths, and other data you cannot publish.

Use a discussion for open-ended design questions. Use an issue when there is a
concrete problem or proposed outcome.

## Development setup

MAIster is a pnpm monorepo. It requires Node 24, pnpm, Git, Docker, PostgreSQL
16, and a supported Agent Client Protocol (ACP) adapter for live agent runs.

```bash
git clone https://github.com/kanischev/mAIster.git
cd mAIster
pnpm install --frozen-lockfile
cp .env.example .env
cp web/.env.sample web/.env.local
cp supervisor/.env.sample supervisor/.env
docker compose up -d postgres
```

Continue with [Getting Started](docs/getting-started.md) for migrations, seed
data, adapter setup, and the two development processes.

## Choose a change

- Keep each change focused on one problem.
- Discuss large product, architecture, schema, or protocol changes before
  implementation.
- Preserve the boundaries in `CLAUDE.md`, `AGENTS.md`, and the relevant nested
  instruction files.
- Distinguish implemented behavior from designed or deferred behavior in docs.
- Do not add secrets, private prompts, customer code, machine-specific paths,
  or personal email addresses to commits, fixtures, logs, or screenshots.

The `.ai-factory/` directory is part of the public engineering record. Plans and
reviews are welcome when they explain decisions, but they must meet the same
privacy standard as source code.

## Make the change

Create a branch, make the smallest coherent change, and use clear conventional
commit subjects such as `fix(web): ...`, `feat(supervisor): ...`, or
`docs: ...`.

Code changes should:

- use strict TypeScript and existing typed error contracts;
- keep agent processes in `supervisor/` and web-to-supervisor calls behind the
  existing HTTP/SSE boundary;
- preserve atomic writes for runtime artifacts;
- include EN and RU copy together for user-visible text;
- add only the minimum integration, end-to-end, or smoke coverage needed for
  the behavior.

Documentation changes should link to one source of truth instead of duplicating
large explanations across README, `docs/`, and `site-docs/`.

## Validate

Run the checks that cover the files you changed. Common commands are:

```bash
pnpm validate:docs
pnpm site-docs:validate
pnpm --filter @maister/site typecheck
pnpm --filter maister-web typecheck
pnpm --filter @maister/supervisor typecheck
pnpm --filter @maister/mcp typecheck
```

For behavior changes, also run the relevant package tests. Integration and E2E
tests require Docker; see [Getting Started](docs/getting-started.md) for their
environment and exact commands. Do not hide a failing check. Explain a known,
pre-existing failure and provide evidence that the change did not introduce it.

## AI-assisted contributions

AI assistance is welcome, but the contributor remains responsible for every
submitted line. In the pull request:

- disclose material AI assistance;
- describe the human verification performed;
- remove fabricated claims, irrelevant generated files, private context, and
  prompt transcripts;
- confirm that licenses and attribution permit any generated or adapted
  material.

## Open a pull request

A useful pull request includes:

- the problem and intended outcome;
- a focused description of the change;
- exact validation commands and results;
- documentation and migration impact;
- security, compatibility, and rollback considerations;
- screenshots only when they materially explain a UI change and contain no
  private information.

Maintainers may ask for a smaller scope, additional evidence, or a design note
before merging. Review comments should focus on the contribution and remain
constructive.

## License

By contributing, you agree that your contribution is licensed under the
project's [MIT License](LICENSE).
