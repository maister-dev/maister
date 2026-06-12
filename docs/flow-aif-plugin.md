# `aif` Flow Package

The AIF package wraps the AI-Factory framework (skills, subagents, slash
commands) into five MAIster flow graphs used to dogfood MAIster against its
own task board.

**Package source: the external `maister-plugins` repo** —
`packages/aif/`, versioned by the per-package tag `aif/v2.0.0` (ADR-087).
The package was extracted from this repo's former `plugins/aif/` on
2026-06-12; a verbatim fixture snapshot of the five flow graphs remains at
`web/test-fixtures/aif-flows/` for engine-behavior tests.

## What it ships

```
packages/aif/
  maister-package.yaml      # package manifest (flows + capability bundle)
  flows/{dev,bugfix,evolve,roadmap,init}/flow.yaml (+ schemas/)
  capability/skills/aif-*/  # 27 vendored AIF skills
  capability/agents/*.md    # 19 vendored subagents
  config/ai-factory.config.yaml   # template for projects without one
  setup.sh                  # inert no-op (capability materialization delivers content)
```

| flow id       | route_when |
| ------------- | ---------- |
| `aif-dev`     | Feature/enhancement/refactor with a clear spec (intake → plan → improve → plan_review → implement → checks → code_review → review → commit). |
| `aif-bugfix`  | A reported bug/error to fix (fix → checks → code_review → review → commit). |
| `aif-evolve`  | Periodic: distill fix-patches into better skills. |
| `aif-roadmap` | Large/multi-milestone initiative needing a roadmap. |
| `aif-init`    | One-time: project not yet AIF-initialized. |

All five are typed-node **graphs** (engine ≥ 1.4.0 since `aif/v2.0.0`):
`retry_policy` on every `ai_coding` node, explicit
`defaults.session_policy: resume`, reviewer-selectable
`workspacePolicies: [keep, rewind-to-node-checkpoint]` on the dev/bugfix fix
loops, and `must_touch` mutation gates on the evolve/roadmap/init commit
nodes. Interactivity is MAIster-native HITL (form intake, human review,
permission requests) — the AIF `AskUserQuestion` tool stays disabled.

## How a project consumes it

**Today (per-flow wiring, pre-P1):** six `maister.yaml` entries — five
`flows[]` sources + one `capability_imports[]` bundle, all pointing into a
local checkout:

```yaml
capability_imports:
  - id: aif-bundle
    source: file:///…/maister-plugins/packages/aif/capability
    version: local-dev
flows:
  - id: aif-dev
    source: file:///…/maister-plugins/packages/aif/flows/dev
    version: local-dev
  # … ×5
```

**After P1 (`packages[]`, ADR-087):** one entry —

```yaml
packages:
  - id: aif
    source: github.com/<org>/maister-plugins   # or file:///…/maister-plugins
    version: aif/v2.0.0
    path: packages/aif
```

`installFlowPlugin()` auto-detects the source kind (local dir → `fs.cp` into
the content-addressed cache; git URL → `git clone --branch <tag> --depth 1`).
See [`flow-installer.md`](flow-installer.md) for the pipeline and
[`system-analytics/packages.md`](system-analytics/packages.md) for the
package-level lifecycle.

## `setup.sh`

Inert no-op: prints a one-line notice and exits `0`. MAIster delivers AIF
skills + subagents through capability materialization into the run worktree
(repo-local copies win), so there is nothing to install at setup time —
no `ai-factory init`, no npm.

## Register + launch (dev recipe)

```bash
# per-flow install (pre-P1), one flow at a time:
pnpm install-flow \
  --project <slug> \
  --source /abs/path/to/maister-plugins/packages/aif/flows/dev \
  --version local-dev \
  --flow-id aif-dev

# launch through the Route Handler (creates run + workspace + worktree):
curl -X POST http://localhost:3000/api/runs \
  -H 'content-type: application/json' \
  -d '{ "taskId": "<task-id>" }'
```

`aif-dev` halts first at the `intake` form HITL, then proceeds
plan → … → review → commit, with the commit node's `command_check` gate
asserting a clean tree + a Conventional Commits subject.

## See also

- `docs/flow-dsl.md` — graph DSL / templating / wire reference.
- `docs/flow-installer.md` — install pipeline + local-source detection.
- `docs/system-analytics/packages.md` — package management (ADR-087).
- `docs/pv/package-management.md` — design + follow-up briefs.
- The package's own `README.md` in `maister-plugins/packages/aif/` —
  provenance + the `aif/v2.0.0` bump notes.
