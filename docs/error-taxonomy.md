[← Database Schema](database-schema.md) · [Back to README](../README.md) · [Configuration →](configuration.md)

# Error Taxonomy

`MaisterError extends Error` with a discriminated `code` field. UI branches
on `code`, never on string matching. Source: `web/lib/errors.ts`.

```ts
import { MaisterError, isMaisterError } from "@/lib/errors";

throw new MaisterError("CONFIG", "DB_URL env is required");
```

## Why a typed taxonomy

- **UI rendering.** Components switch on `code` to pick the right action
  ("Recover" for `CRASH`, "Resolve manually" for `CONFLICT`, "Reset config"
  for `CONFIG`).
- **Observability.** Codes are stable identifiers that survive message
  rewrites; logs and metrics can group by them.
- **Discipline.** No string-matching on `err.message` anywhere. If a new
  failure mode emerges, extend the union — do not invent a new ad-hoc
  `Error` class.

## Codes

Eleven codes, all defined as a string union in `web/lib/errors.ts`.

| Code | Meaning | Where thrown | UI action |
| ---- | ------- | ------------ | --------- |
| `PRECONDITION` | A precondition for an action is not met (dirty repo, branch taken, worktree path occupied, global concurrency cap hit, executor not registered). | `POST /api/runs` validation before spawn. | Show the specific blocker, link to fix. |
| `SPAWN` | Subprocess could not be launched (binary not on PATH, exec perm denied, OOM). | `supervisor/` when spawning `claude-agent-acp` or `codex-acp`. | "Executor failed to start" with stderr tail. |
| `NEEDS_INPUT` | The run paused for human input (ACP `session/request_permission` or `needs-input.json` artifact). | Supervisor on ACP notification or artifact appearance. | Render HITL form / approve-deny prompt. |
| `HITL_TIMEOUT` | 24h elapsed in `NeedsInputIdle` without user response. | Reconcile loop / GC cron. | Move run to `Abandoned`, return task to Backlog. |
| `CRASH` | Worker died mid-`Running` without a graceful checkpoint. | Supervisor heartbeat watcher; startup reconcile. | "Recover or discard" panel with `acpSessionId` resume option. |
| `CONFLICT` | `git merge --no-ff` could not auto-merge. | `POST /api/runs/[id]/merge`. | "Resolve manually" with parent repo path. |
| `CONFIG` | A config file or env var is missing or malformed (`maister.yaml`, `flow.yaml`, `form_schema`, `DB_URL`). | `lib/config.ts` validators; `lib/db/client.ts`. | Show the offending field path; refuse to start. |
| `EXECUTOR_UNAVAILABLE` | The executor named in run launcher / project override / Flow recommendation is not registered for this project. | Run-launch override resolution. | "Pick a different executor" with the registered list. |
| `FLOW_INSTALL` | `git clone --branch <tag>` of a Flow plugin failed, or the manifest was rejected. | Project registration (`POST /api/projects`); Flow loader. | Show the failing source URL + tag, link to the manifest error. |
| `ACP_PROTOCOL` | Supervisor received an ACP message it cannot decode, or saw an unexpected state transition. | Supervisor ACP client. | "Executor sent an unexpected message" with the raw payload. |
| `CHECKPOINT` | Graceful checkpoint failed (couldn't persist session state on idle-timeout). | Supervisor checkpoint path. | Worker stays live; UI surfaces a "couldn't checkpoint — keep tab open" warning. |

## Construction

```ts
new MaisterError(code, message)
new MaisterError(code, message, { cause: originalError })
```

`cause` is the standard `ErrorOptions` shape; it survives JSON
serialization across the SSE bridge so the UI can show the underlying
error too. `name` is always `"MaisterError"` and `stack` is preserved.

## Detection

Use the `isMaisterError` type guard everywhere:

```ts
try {
  await loadProjectConfig(path);
} catch (err) {
  if (isMaisterError(err) && err.code === "CONFIG") {
    return res.status(400).json({ error: "BAD_CONFIG", detail: err.message });
  }
  throw err;
}
```

Plain `err instanceof MaisterError` works too, but the type guard makes
the discriminated `code` field available on the narrowed branch.

## What NOT to do

- ❌ `throw new Error("DB_URL is required")` — use `MaisterError("CONFIG", …)`.
- ❌ `if (err.message.includes("conflict")) { … }` — switch on `err.code === "CONFLICT"` instead.
- ❌ Wrapping a third-party error to "look typed" without picking a real code. If a new failure mode is real, extend the union; if it isn't, let the underlying error propagate.
- ❌ Throwing a `MaisterError` for an _impossible_ scenario. Validate at system boundaries (user input, external APIs, subprocess exits, file reads). Trust internal invariants.

## Adding a new code

1. Add the string to the `MaisterErrorCode` union in `web/lib/errors.ts`.
2. Update this page with the new row + UI action.
3. Update `web/lib/errors.test.ts` exhaustiveness assertion (the
   `satisfies readonly MaisterErrorCode[]` const array must include it).
4. Update every `switch` / `if/else` that branches on `code`.

The `satisfies` assertion in the test prevents the test from silently
ignoring a newly added code.

## See Also

- [Database Schema](database-schema.md) — `runs.status` enum the UI
  surfaces alongside error codes
- [Configuration](configuration.md) — `CONFIG` is thrown on every
  malformed `maister.yaml` / `flow.yaml` / `form_schema`
