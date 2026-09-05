# `.ai-factory/`: the engineering design record

This directory is the working memory of MAIster's AI-assisted development
process, published on purpose. The plans, reviews, and lessons here explain why
the code looks the way it does. Nothing in it is needed to build or run MAIster.

## What is here

| Path              | Content                                                                        |
| ----------------- | ------------------------------------------------------------------------------ |
| `DESCRIPTION.md`  | Full project specification that the planning skills read first.                |
| `ARCHITECTURE.md` | Architecture guidelines derived from the stack.                                |
| `ROADMAP.md`      | Milestone order. The only file here that carries current sequencing.           |
| `PLAN.md`         | The plan currently being executed.                                             |
| `plans/`          | One implementation plan per feature or fix. Historical once shipped.           |
| `specs/`          | Frozen specifications that plans implement.                                    |
| `patches/`        | Dated review outcomes: what a review found and what was fixed.                 |
| `evolutions/`     | Periodic distillation of patches into prevention rules.                        |
| `rules/`          | Area rules applied to every change: `base`, `backend`, `frontend`, `database`. |
| `skill-context/`  | Project-specific context injected into the `/aif-*` skills.                    |
| `references/`     | Reference material gathered for design work.                                   |
| `requests/`       | Feature requests captured before planning.                                     |
| `config.yaml`     | AI Factory configuration for this repository.                                  |

The root `.ai-factory.json` records which skills are installed for each agent.

## How it is produced

Work follows the AI Factory loop: request → `/aif-plan` (plan and spec) →
`/aif-implement` → `/aif-review` (findings become `patches/`) → `/aif-evolve`
(patches become `evolutions/` and rule updates). An agent writes every file
here under human review, in the same branch as the code it describes.

## Reading rules

- When a plan disagrees with `docs/` or the code, the code wins and `docs/` is
  the contract. Plans are history.
- Milestone labels such as `M11a` or `M43` are changelog vocabulary, not status.
- Product truth lives in [`docs/`](../docs/); the root [`CLAUDE.md`](../CLAUDE.md)
  and [`AGENTS.md`](../AGENTS.md) are the agent-facing operating contracts.

## Contributing

Plans and reviews are welcome in pull requests when they explain a decision.
They meet the same privacy bar as source code: no secrets, private source,
customer data, machine-specific paths, or personal email addresses. See
[CONTRIBUTING.md](../CONTRIBUTING.md).
