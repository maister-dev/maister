# aif plugin

In-repo Flow plugin that wraps the AI-Factory slash commands
(`/aif-explore`, `/aif-plan`, `/aif-implement`, `/aif-fix`) into a single
session-shared workflow ending in a human review form.

## Register against a project

```bash
pnpm --filter @maister/web install-flow \
  --project <slug> \
  --source file:///<abs-repo-path>/plugins/aif \
  --version local-dev \
  --flow-id aif
```

When this plugin moves to its own repo, flip `--source` to the git URL
and bump `--version` to a semver tag. `installFlowPlugin()` auto-detects
the `file://` (or absolute-path) source and `fs.cp`s the directory
instead of `git clone`-ing — no other code change is required.

## Steps

| id        | type   | mode                 | prompt                                                |
| --------- | ------ | -------------------- | ----------------------------------------------------- |
| explore   | agent  | slash-in-existing    | `/aif-explore {{ task.prompt }}`                      |
| plan      | agent  | slash-in-existing    | `/aif-plan continue with the explored context`        |
| implement | agent  | slash-in-existing    | `/aif-implement`                                      |
| fix       | agent  | slash-in-existing    | `/aif-fix any issues from /aif-implement`             |
| review    | human  | —                    | reviewer form (`schemas/review.json`)                 |

All four agent steps share the same supervisor session so they accumulate
context. The `review` step writes `needs-input.json` and inserts an
`hitl_requests` row; rejecting the review loops back to `implement` per
`on_reject.goto_step`.

## setup.sh

`setup.sh` runs `ai-factory init` if the CLI is on PATH; otherwise it
logs a notice and exits 0 (the plugin still loads cleanly).
