---
title: "Wait for CI and complete a Flow"
description: "Publish a Run branch, wait for checks on its exact commit, and decide when MAIster may finish delivery automatically."
---

Use `check` or `cli` for verification inside the Run. When CI runs on a Git
provider, add `publish` and `wait` after your local checks. The Run keeps its
worktree while it waits and releases its execution slot and agent process. Once
the condition resolves, the Run queues for an available slot. You can see the
condition and deadline on the Run graph and in the wait card.

## Publish and wait for checks

Use engine 3.14.0 or later and an enabled project Flow. Configure a Git origin
with push access and provider read access. MAIster can read checks from GitHub,
GitLab, and Gitea. When launching the Run, authorize the Flow revision to push
the branch and open any PR declared in the manifest. The branch name comes from
the project's public branch template.

Add these nodes after the local checks and point their success path at
`publish`. Replace `test` with the provider's exact check label and `github-main`
with the configured source identity. This example leaves the Run for review
after each CI outcome. Connect failure to bounded rework if you want the Run to
try again on a new commit.

```yaml
compat: { engine_min: "3.14.0" }
nodes:
  - id: publish
    type: publish
    pr: draft
    transitions: { success: await_ci }
  - id: await_ci
    type: wait
    on: { kind: ci, publication: publish, transport: pull, checks: [test], issuer: github-main }
    timeout: 1800
    transitions: { success: done, failure: done, cancelled: done, timeout: done, stale: done }
```

Omit `pr` to publish only the branch or use `pr: ready` to open a PR ready for
review. To wait for the PR lifecycle, use `on: { kind: pr, publication: publish }`
and give `merged`, `closed`, `conflict`, `timeout`, `cancelled`, and `stale` a
transition. CI and PR results are tied to the publication commit. If it changes,
route `stale` to review or to bounded rework that publishes fresh changes.

## Send a CI callback

For push delivery, set `transport: push`, give the wait a signal `name`, and set
`issuer` to the project token authorized for that signal. Use a project token
with `waits:signal`. If CI needs the callback address, request
`GET /api/v1/ext/projects/{slug}/waits/callback` with `signal`, `ref`, and `headSha`.
For repeated publications with the same tuple, retain the original address.
Post `name`, `outcome`, and `headSha` to
`/api/v1/ext/runs/{runId}/waits/{waitId}/signal`. Retry the same delivery with the
original `Idempotency-Key` and body. An accepted receipt can be applied after
the published ref is verified. A callback for the wrong commit cannot resolve
the wait.

## Operate a wait

In the Run's wait card, inspect the deadline, outcome, and delivery history. If
you have permission, supply a missing signal, resolve with a declared outcome,
extend the deadline, or cancel and follow the `cancelled` transition. Each action
records your reason. `timeout` is always required in seconds. The installation
sets a maximum wait duration through `MAISTER_MAX_WAIT_SECONDS`, which defaults
to seven days. An extension must stay within the original limit.

Other conditions include a timer, a new task comment, the settlement of a related
Run in the same project, and a named signal. See [Flow node types](/studio/node-types)
for their place in the graph. In an agent prompt,
`{{ steps.<id>.vars.waitData.content }}` inserts external payloads and comment
text as quoted data. A rework prompt can use `steps.<id>.vars.waitData.failedChecks`
for the names of required checks that did not pass.

## Allow the engine to finish delivery

With engine 3.15.0 or later, a reviewed Flow can declare `autonomous_completion`
with a CI wait, required blocking gates, and a blocking AI review. A project
admin approves CI sources and sets risk, confidence, and diff limits. Enable
the platform control and authorize autonomous completion at human launch.
For push CI, declare `provider_issuer` so MAIster can independently verify the
required checks on the same commit before completing delivery.

With eligible evidence, MAIster can promote a Run or finalize it after the
provider confirms the PR merged. A declared timeout or exhausted rework may
end in `Failed` when policy allows it. Missing or stale evidence leaves the Run
in `Review`. You can place a hold from the Run or disable autonomous completion
for the project or platform. The Run and Desk show the engine's decision, and
the regular [review and promotion controls](/guides/review-and-promote) remain
available.
