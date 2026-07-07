# Graded Runner Resolution

## Goal

Allow a Flow runner slot to launch when the requested `capability_agent` matches
an enabled and ready host runner, even if soft intent fields (`model` and/or
`provider.kind`) differ. Exact matches stay silent. Soft mismatch fallbacks
launch with a durable warning. Capability mismatch remains a hard refusal.

## Hard Contract

- `capability_agent` is physical runtime compatibility, not a preference.
- A `claude` slot may never resolve to `codex`, `gemini`, `opencode`, or `mimo`.
- Existing `resolveAgentRunner()` refusals for subagent-mode, read-only
  enforcement, and permission policy compatibility remain strict.
- Explicit launch override, binding, or direct host-runner references do not use
  graded fallback. Missing, disabled, or not-ready named runners still fail.

## Resolution Rules

1. Select one exact enabled+ready match on
   `(capability_agent, model, provider.kind)` with no warning.
2. If more than one exact candidate exists, raise `CONFIG`; the project must bind
   the slot explicitly.
3. If no enabled+ready runner has the requested `capability_agent`, raise
   `EXECUTOR_UNAVAILABLE`.
4. If capability matches but no exact candidate exists, select a same-capability
   fallback by priority:
   - same base model, where one trailing bracket suffix is ignored
     (`claude-opus-4-8[1m]` equals `claude-opus-4-8`);
   - project default runner of the requested capability;
   - platform default runner of the requested capability.
5. Disabled, not-ready, and different-capability defaults are skipped.
6. A fallback emits one warning and proceeds.

## Warning Shape

```ts
type RunnerResolutionWarning = {
  readonly code: "runner_intent_soft_mismatch";
  readonly slotKey: string;
  readonly sessionName?: string;
  readonly requested: {
    readonly capabilityAgent: string;
    readonly model?: string;
    readonly providerKind?: string;
  };
  readonly launched: {
    readonly runnerId: string;
    readonly capabilityAgent: string;
    readonly model: string;
    readonly providerKind: string;
  };
  readonly message: string;
};
```

The warning payload is public metadata only. It must not contain provider
secrets, `env`, auth tokens, API keys, sidecar auth refs, or full provider
objects.

## Persistence And UI

- `GET /api/runs/launch-options` returns `selectedRunnerWarning` for the selected
  runner and per-session `warning` values when previews soft-fallback.
- `run_sessions.resolution_warning` stores the warning in the same transaction
  that creates the run/session rows.
- After commit, the web tier appends one `run.runner_resolution_warning` event
  per warning to `.maister/<projectSlug>/runs/<runId>/run.events.jsonl`.
- The run detail UI reads the DB column and shows the warning even if event-log
  append fails.

## Test Matrix

| Case | Expected result |
| --- | --- |
| Exact singleton | selected silently |
| More than one exact candidate | `CONFIG` |
| Model variant mismatch | same-capability fallback + warning |
| Provider kind mismatch | same-capability fallback + warning |
| Both model and provider differ | same-capability fallback + combined warning |
| Capability absent | `EXECUTOR_UNAVAILABLE` |
| Disabled/not-ready default | skipped |
| Default points at another capability | skipped |
| Explicit bad override/binding/direct host id | no fallback; existing refusal |
| `claude-opus-4-8[1m]` vs `claude-opus-4-8` | same base model |

## Acceptance Criteria

- Launching `aif-dev` with requested `claude-opus-4-8` succeeds against a catalog
  whose only Claude runner is `claude-opus-4-8[1m]`.
- The run carries a warning that says what model/provider the Flow requested and
  what runner/model/provider was launched.
- Capability-agent substitutions still fail before launch.
- Existing strict subagent/read-only/permission refusals remain green.
