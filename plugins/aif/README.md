# AIF Flow package

Portable MAIster Flow package for AI-Factory-style planning, implementation,
checks, judgment, and human review. The package can be imported as an authored
Flow draft, exported to a git-ready directory, or installed through the
trust-gated Flow package lifecycle.

## Package inventory

| Path                  | Purpose                                                      |
| --------------------- | ------------------------------------------------------------ |
| `flow.yaml`           | Flow manifest and graph.                                     |
| `README.md`           | Package overview and operator notes.                         |
| `setup.sh`            | Optional setup hook; runs only after package trust.          |
| `schemas/review.json` | Human review form schema.                                    |
| `skills/aif/SKILL.md` | Package-scoped AIF usage guidance.                           |
| `rules/base.md`       | Portable operating rules for the package.                    |
| `agents/*.md`         | Coordinator, QA, implementor, and reviewer role definitions. |
| `scripts/aif-flow.sh` | Small helper CLI for package-local checks.                   |

## Register against a project

```bash
pnpm --filter maister-web install-flow \
  --project <slug> \
  --source file:///<abs-repo-path>/plugins/aif \
  --version local-dev \
  --flow-id aif
```

For authored package workflows:

```bash
pnpm --filter maister-web validate-authored-flow --source-dir ../plugins/aif
pnpm --filter maister-web import-flow-package-draft --project <slug> --source-dir ../plugins/aif
pnpm --filter maister-web export-authored-flow --project <slug> --slug aif --output-dir /tmp/aif-flow
pnpm --filter maister-web install-authored-flow-package --project <slug> --source-dir /tmp/aif-flow --version authored-aif-local --flow-id aif
```

When this plugin moves to its own repo, flip `--source` to the git URL
and bump `--version` to a semver tag. `installFlowPlugin()` auto-detects
the `file://` (or absolute-path) source and `fs.cp`s the directory
instead of `git clone`-ing — no other code change is required.

## Steps

| id          | type        | Purpose                                                                    |
| ----------- | ----------- | -------------------------------------------------------------------------- |
| `plan`      | `ai_coding` | Produce an implementation plan from the task prompt.                       |
| `implement` | `ai_coding` | Execute `/aif-implement` with package skills and instructed tool settings. |
| `checks`    | `check`     | Run the package check command and produce a lint report.                   |
| `judge`     | `judge`     | Produce an advisory JSON quality verdict.                                  |
| `review`    | `human`     | Gate final approval, rework, or takeover.                                  |

The review node can approve, loop back to `implement` for bounded rework, or
hand control to a local takeover path that resumes at `checks`.

## setup.sh

`setup.sh` runs `ai-factory init` if the CLI is on PATH; otherwise it
logs a notice and exits 0. MAIster never runs it during authored import/export
or package install; it runs only after the package is trusted and enabled.
