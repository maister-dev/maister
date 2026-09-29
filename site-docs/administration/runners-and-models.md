---
title: "Configure ACP runners and models"
description: "Create host runner profiles, preserve provider authentication, verify readiness, and bind Flow session slots."
---

An ACP runner is a host-scoped launch profile for a coding-agent adapter, model,
provider route, environment references, and permission policy. Projects and
Flows select these profiles; they do not spawn arbitrary commands.

## Prerequisites

- Global `admin` access.
- The target coding-agent CLI installed on the execution host.
- Provider authentication already configured for that CLI, or provider secrets
  available in the supervisor process environment.

![ACP runner catalog and readiness settings](/assets/screens/en/runner-settings.png)

## Supported adapter families

MAIster keeps Claude, Codex, Gemini, OpenCode, and MiMo in one runner catalog.
Provider routing includes Anthropic, OpenAI, Google routes, agent-native routes,
and compatible endpoints such as OpenRouter. Each concrete profile still has
its own readiness result.

| Runner field | Meaning |
| --- | --- |
| ID and label | Stable identity used by project defaults and Flow bindings. |
| Adapter | Coding-agent CLI that the supervisor starts through ACP. |
| Model | Model requested from the adapter or provider. |
| Provider | Native or compatible provider route, including base URL and wire settings where required. |
| Environment | Values or `env:NAME` references passed to the adapter process. Prefer references for secrets. |
| Permission policy | Normal interactive policy or the adapter's explicitly supported unattended mode. |
| Enabled | Whether new launches may select the profile. |
| Default | Installation-wide fallback when a project or Flow slot does not bind another compatible runner. |

## Create a runner

1. Open **Settings → ACP runners**.
2. Add a runner and select its adapter family.
3. Set the model and provider route.
4. Put secret values in the supervisor host environment. Enter `env:NAME` in
   the runner field that should resolve that variable at launch.
5. Keep the runner disabled until diagnostics are available.
6. Enable it after the row reports **Ready**.
7. Set a platform default only if the runner is a safe fallback for normal work.

Native CLI authentication remains useful. For example, a runner can use the
operator's existing Codex, Claude Code, or Gemini CLI login instead of copying a
provider key into MAIster. The supervisor preserves the adapter's native home or
authentication files according to that adapter's launch contract.

## Understand readiness

Readiness combines configuration and live host diagnostics. A row can be
unavailable because the binary is missing, an executable override is invalid,
the provider kind is unsupported, an environment reference is absent, or an ACP
initialization probe failed.

Normal **Ready** and read-only eligibility are separate signals. Standalone
agents that use `workspace: none` or `repo_read` require a runner whose adapter
supports read-only sessions and, when required, has current read-only probe
evidence. A runner can therefore be ready for a normal Flow and still refuse a
read-only platform agent.

## Configure the personal librarian

In **Settings → ACP runners**, open the **Librarian** card, select its runner,
enable it, and click **Save**. The librarian is disabled by default and has its own selection;
changing the platform default does not configure it. Open the top-nav
**Librarian** panel and send a read-only question to verify the setup.

Currently, only an enabled, Ready Claude runner with read-only capability is
eligible. Permission-skipping mode and runner overrides for `HOME`,
`CLAUDE_CONFIG_DIR`, or `CODEX_HOME` are refused. Codex is refused specifically
for this role because denial of its built-in tools has not been verified;
read operations may bypass ACP permission requests. This does not affect its
eligibility for ordinary Flow or scratch work. Other adapter families are not
eligible for the librarian.

The MAIster MCP facade must be runnable by the supervisor, and its API URL must
reach Web. A missing facade is a setup failure. The librarian uses its restricted
MAIster toolset instead of inheriting arbitrary project MCP servers.

Disabling it stops admission of new responses. Personal history stays readable,
and already admitted operations still reconcile. See the
[personal librarian guide](/guides/personal-librarian) for task creation,
confirmation cards, privacy, and memory controls.

### Librarian limits

Set these variables in the Web service environment. Values must be positive
integers; invalid values are configuration errors. The response pool is separate
from Flow/scratch and platform-agent capacity.

| Variable | Default | Controls |
| --- | --- | --- |
| `MAISTER_MAX_CONCURRENT_LIBRARIAN_TURNS` | `3` | Concurrent librarian turns across users. |
| `MAISTER_LIBRARIAN_TURN_MAX_MINUTES` | `10` | Maximum duration of one turn. |
| `MAISTER_LIBRARIAN_CONTEXT_MAX_CHARS` | `60000` | Context character budget. |
| `MAISTER_LIBRARIAN_DAILY_TURNS_PER_USER` | `200` | Daily turn limit per user. |
| `MAISTER_LIBRARIAN_OPERATION_RECONCILE_SECONDS` | `120` | Age threshold for reconciling interrupted operations. |
| `MAISTER_LIBRARIAN_HISTORY_RETENTION_DAYS` | `365` | Message retention. |
| `MAISTER_LIBRARIAN_SNAPSHOT_RETENTION_DAYS` | `30` | Retention of per-turn context snapshots. |
| `MAISTER_LIBRARIAN_CONFIRMATION_TTL_MINUTES` | `60` | Confirmation-card lifetime. |

## ACP is a two-way control channel

The supervisor does more than start a terminal command. ACP carries prompts and
session events in both directions. It allows MAIster to:

- surface a coding agent's permission question to a person instead of forcing a
  YOLO-style session;
- send the selected permission response back to the live session;
- interrupt or stop work;
- send a corrective prompt or resume a supported session;
- stream the agent's progress into the Run workbench.

These controls mirror the interactive behavior users expect from coding-agent
desktop and terminal applications, while keeping the session attached to a
shared task and audit trail.

## Bind runners to Flow work

A Flow can declare named sessions and runner slots. A project resolves every
slot when it connects the Flow or first launches it. The resolved runner is
snapshotted in the Run, so later catalog edits do not rewrite history.

Different nodes can share one session or use different sessions. This lets a
Flow assign different coding agents and model price/performance levels to
planning, implementation, verification, and judging. The team defines the
policy once; individual contributors do not have to switch models manually for
every task.

Use a more capable model where complexity or evaluation warrants it, and a
faster or cheaper profile for routine work. Confirm the result in
[Observatory](/operations/costs-and-budgets) and compare quality in an
[Evaluation Study](/evaluation/run-comparison).

The launch dialog exposes every runner slot, including consensus participants
and the synthesizer. Bind each unresolved slot; per-slot selections are saved
automatically and remain visible when reopening the dialog. Editing project
bindings requires the project administration rights shown in the dialog.

The read-only **Steering** indicator reports observed adapter support. It does
not gate launch, and the active session's capability determines whether a
[message while running](/guides/message-a-running-agent) is steered or queued.

## Failure signals

- `EXECUTOR_UNAVAILABLE`: no enabled, Ready runner satisfies the hard adapter
  capability or required read-only evidence.
- Configuration ambiguity: several exact matches exist and the project must bind
  one explicitly.
- Soft intent warning: MAIster found a compatible fallback, but its model or
  provider differs from the Flow's requested intent. The warning is stored on
  the Run without exposing secrets.

Do not repair a failing runner by weakening an unrelated Flow requirement.
Correct the binary, authentication, environment reference, provider route, or
explicit slot binding shown by diagnostics.
