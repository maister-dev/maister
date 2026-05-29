# `aif` Flow Plugin

The `aif` plugin wraps the AI-Factory slash commands into a single
end-to-end Flow used to dogfood MAIster against its own task board.

Plugin source: `plugins/aif/` in this monorepo.

## What it wraps

| step      | type   | mode               | prompt                                          |
| --------- | ------ | ------------------ | ----------------------------------------------- |
| `explore` | agent  | slash-in-existing  | `/aif-explore {{ task.prompt }}`                |
| `plan`    | agent  | slash-in-existing  | `/aif-plan continue with the explored context`  |
| `implement` | agent | slash-in-existing | `/aif-implement`                                |
| `fix`     | agent  | slash-in-existing  | `/aif-fix any issues from /aif-implement`       |
| `review`  | human  | —                  | reviewer form (`schemas/review.json`)           |

The form has two fields: `approved: boolean (required)` + `comments: string`.
On reject the plan calls back to `implement` via
`on_reject.goto_step: implement` (the loop-back is recorded in
the HITL response; runner execution of the goto is designed).

## Why slash-in-existing matters

All four agent steps share one supervisor session, so each slash command
sees the prior turns' context (memory, tool state, last edits). Mixing
`new-session` here would force each step to re-establish context from
scratch — slower, more tokens, weaker results.

## `setup.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

if [ -n "${MAISTER_FLOW_SKIP_SETUP:-}" ]; then
  echo "[aif setup] MAISTER_FLOW_SKIP_SETUP set — skipping" >&2
  exit 0
fi
if [ ! -t 0 ]; then
  echo "[aif setup] non-interactive shell — skipping ai-factory init" >&2
  exit 0
fi
if command -v ai-factory >/dev/null 2>&1; then
  ai-factory init
else
  echo "[aif setup] ai-factory CLI not found on PATH — skipping init (plugin will still load)" >&2
fi
```

The script runs `ai-factory init` when invoked from a TTY with the CLI on
PATH. In CI / non-interactive contexts it skips cleanly. The integration
test (`web/lib/flows/__tests__/runner.integration.test.ts`) installs the
plugin in this non-interactive mode.

## Source location

For now `aif` lives in-repo. `installFlowPlugin()` accepts the absolute
path (or `file://` URL) as `source`:

```bash
pnpm --filter @maister/web install-flow \
  --project <slug> \
  --source /abs/path/to/mAIster/plugins/aif \
  --version local-dev \
  --flow-id aif
```

When the plugin extracts to its own repo, flip `source` to the
git URL and `version` to a real semver tag in `maister.yaml`:

```yaml
flows:
  - id: aif
    source: github.com/<org>/maister-flow-aif
    version: v0.1.0
```

`installFlowPlugin()` auto-detects the source kind:

- absolute path / `file://` URL pointing at a non-`.git` directory with
  `flow.yaml` → `fs.cp` into the system cache.
- absolute path inside a `.git` repo, or a `https://...` git URL → fall
  through to `git clone --branch <version>`.

The local-source path is the migration bridge: no code changes when the
plugin moves out of the monorepo, just a `maister.yaml` flip.

## Register against a project

```bash
pnpm install-flow \
  --project <slug> \
  --source /abs/path/to/plugins/aif \
  --version local-dev \
  --flow-id aif
```

After install:

- `~/.maister/flows/aif@local-dev/` holds the plugin contents.
- `<project>/.maister/<slug>/flows/aif` is a symlink to the above.
- `flows` row exists in the DB with `manifest` populated.

## Launch a run

Either the dev CLI or the Route Handler:

```bash
# Dev CLI (assumes a Pending run already exists for the task)
pnpm run-flow --task <task-id>

# OR Route Handler — creates the run, the workspace, the worktree:
curl -X POST http://localhost:3000/api/runs \
  -H 'content-type: application/json' \
  -d '{ "taskId": "<task-id>" }'
```

Response (when started): `202 { runId, status: "Running" }`. The run
proceeds through `explore → plan → implement → fix → review`, halting at
`review` with `runs.status = "NeedsInput"`.

## See also

- `docs/flow-dsl.md` — full step/templating/wire reference.
- `docs/flow-installer.md` — install pipeline + local-source detection.
- `docs/getting-started.md` — end-to-end recipe.
