# Run trace — stop deriving log artifacts, record every dispatched prompt

**Branch**: `claude/acp-run-timeline-cleanup-64ff98` (worktree; branch pre-existing)
**Created**: 2026-09-17 · **Refined**: 2026-09-17 (SDD + TDD pass)
**Base**: `master`

## Settings

- **Method**: spec-first (SDD) → TDD `RED → GREEN → refactor`. No implementation line is
  written before a failing test names the requirement it satisfies.
- **Testing**: yes — every requirement has exactly one **primary test**; overlap is a
  defect, and so is a test that asserts a language or framework guarantee.
- **Logging**: verbose (DEBUG on every derivation decision and every prompt write)
- **Docs**: yes — mandatory documentation checkpoint at completion
- **UI changes**: **none.** No component, no layout, no new i18n key.
- **Migrations**: **one** — `run_messages.prompt_dispatch_key` + a partial unique index.
- **History**: **not touched.** No backfill, no read filter, no retention change.
- **New env vars / ports / sidecars / config files**: **none**

## Roadmap Linkage

**Milestone**: `none` — defect fix plus a bounded data-plane addition.

---

## Problem — verified

The run's artifact/Evidence view renders one React Flow node per `artifact_instances`
row, unfiltered ([evidence-graph.ts:82-90](web/lib/queries/evidence-graph.ts:82)),
labelled `art.kind` with `art.validity` as state
([evidence-graph.ts:131-139](web/lib/queries/evidence-graph.ts:133)) — literally the
reported `log | current` wall.

One function produces it:
[`deriveFromToolCall`](web/lib/projector/artifact-projector.ts:133). Every ACP
`tool_call`, every `tool_call_update`, and every `session.permission_request` without an
`http(s)` preview URL derives a `kind:"log"` artifact whose whole body is
`shortLogSummary` = `title · toolCallId · status`
([artifact-projector.ts:120-127](web/lib/projector/artifact-projector.ts:120)).
Reported scale (server install): 10 231 log rows vs 401 real — 96.2 %, 1 561 kB.

### Correction to the stated diagnosis

There is **no ×1.86 amplification**. `projectCanonicalArtifactEvent` derives at most
**one** artifact per event, idempotent on `canonicalProjectorArtifactId({runId, eventId})`
([artifact-projector.ts:311-316](web/lib/projector/artifact-projector.ts:311)). The ratio
is a measurement artifact: `assertRuntimeEventPayloadSafe` throws on any slash-led token
([runtime-events.ts:94](supervisor/src/runtime-events.ts:94)), so nearly every `tool_call`
is offloaded whole to a host-private object and the row keeps only `{contentRef}` under
`payload_schema='maister.session.content.v2'` — where
`payload->'update'->>'sessionUpdate'` is NULL and a count keyed on it undercounts. And
`session.permission_request` derives through the same function with no `sessionUpdate`
discriminant at all, so it was outside the 1 078 entirely. The 242 byte-identical
duplicates are real: a `tool_call_update` that does not change `status` yields the same
summary string as its `tool_call`.

The server database is not reachable from here, so **T1.1 proves the invariant by replay
fixture**, not by querying the install.

### Why tool activity does not belong in the artifact plane

| Plane | Answers | Source of truth |
| --- | --- | --- |
| **Evidence** | what did this run *produce* that a gate or reviewer consumes | `artifact_instances` |
| **Trace** | what did the agent actually *do* | `run_messages`, projected from `execution_events` |
| **Ledger** | how did the run *move* through the graph | `node_attempts` + `gate_results` + `assignment_events` |

Tool activity is already fully represented in the Trace plane
([transcript-projector.ts:181](web/lib/execution-host/events/transcript-projector.ts:181))
— name, `toolKind`, status, arg, `rawInput`, result, merged per `toolCallId`. The `log`
derivation is a strictly lossier duplicate.

### Already works — verified, no work needed

- **Skill and MCP calls display.** `toolNameFromUpdate` reads `_meta.claudeCode.toolName`
  ([transcript.ts:177-191](web/lib/run-transcript/transcript.ts:177)) — `Skill`, `Task`,
  `mcp__<server>__<tool>`. `summarizeToolInput` scans `TOOL_ARG_KEYS`, which contains
  `"skill"` ([transcript.ts:99](web/lib/run-transcript/transcript.ts:99)).
- **Reasoning displays** — `agent_thought_chunk` → coalesced `thought` payload.
- **The resolved prompt displays** for flow nodes — `FlowRunCenter`
  ([flow-run-center.tsx:198-221](web/components/runs/flow-run-center.tsx:198)).

### Genuinely missing about the prompt

`node_attempts.resolved_prompt` is written at one place
([runner-agent.ts:1267-1290](web/lib/flows/runner-agent.ts:1267)) under two restrictions:

1. **Owner filter** — skipped unless `promptOwner` is absent, `node`, or
   `permission_resume`. **`gate_ai`, `gate_skill`, `consensus_verifier` and
   `consensus_synthesis` prompts are never captured.**
2. **Write-once per attempt** (`WHERE resolved_prompt IS NULL`) — only the first prompt
   of an attempt survives.

The real owner union at dispatch is `NodePromptOwner | GatePromptOwner |
ConsensusPromptOwner` ([runner-agent.ts:133](web/lib/flows/runner-agent.ts:133)) — **six
variants**:

| Variant | Shape | Source |
| --- | --- | --- |
| `node` | `{nodeAttemptId, promptOrdinal}` | [node-prompt-owner.ts:41-51](web/lib/flows/graph/node-prompt-owner.ts:41) |
| `permission_resume` | `{nodeAttemptId, promptOrdinal, hitlRequestId}` | same |
| `gate_ai` | `{nodeAttemptId, gateId, evaluationId, promptOrdinal}` | [prompt-owner.ts:39-45](web/lib/flows/graph/prompt-owner.ts:39) |
| `gate_skill` | same as `gate_ai` | same |
| `consensus_verifier` | `{nodeAttemptId, round, verifierId, targetId, verdictId}` | [consensus/prompt-owner.ts:61+](web/lib/flows/graph/consensus/prompt-owner.ts:61) |
| `consensus_synthesis` | consensus shape | same |

Plus the standalone-agent create owner `agent` `{turnId, promptOrdinal}`
([create-intent.ts:64-70](web/lib/execution-host/create-intent.ts:64)), whose
`run_messages` rows carry `node_attempt_id = NULL`.

Two host-side rewrites happen after the text is recorded: the one-shot context-mount
grounding block ([context-mounts.ts:112-128](supervisor/src/context-mounts.ts:112),
attached at [acp-client.ts:1224-1226](supervisor/src/acp-client.ts:1224)) — **absent when
a flow declares no `context_repos`** — and runtime-object → `resource_link` block
rewriting ([prompt-runtime-objects.ts:43-72](supervisor/src/prompt-runtime-objects.ts:43)),
which is attachments, not prompt text.

### Known gaps recorded but NOT fixed here (each needs UI work)

`plan` / `plan_update` / `plan_removed` dropped at
[transcript.ts:328](web/lib/run-transcript/transcript.ts:328) · `usage` extracted into
`RunNodeTranscript.usage`
([run-transcript-projector.ts:165-180](web/lib/runs/run-transcript-projector.ts:165)) and
read by no component · `locations[]` / `rawOutput` / non-text tool `content[]` blocks
flattened away · `LegacyRow` inline
([transcript-view.tsx:306-332](web/components/run-transcript/transcript-view.tsx:306)) ·
`session.line` double-writes every ACP frame
([spawn.ts:391-395](supervisor/src/spawn.ts:391)) for one consumer.

---

## Specification (SDD)

The owning document is **`docs/system-analytics/run-trace.md`**, prefix **`TRC`**, with the
traceability matrix inside the same file (the Stage B idiom, where
`execution-data-cutover.md` carries its own group's matrix). It is registered as a new
group in `scripts/validate-docs-indexes.mjs`, which then enforces: the seven R5 sections,
**Expectations ≤ 12 bullets**, unique ids, and a traceability row with a non-blank
`Primary test` for every `TRC-*` and `EDGE-TRC-*`.

> **Why a new document.** `execution-prompt-lifecycle.md` (the natural home for `PRM`
> requirements) already holds **exactly 12** Expectations bullets — the validator's cap —
> so a `PRM-13` fails the gate. `artifacts.md` (13 bullets) and `runs.md` (24) are already
> over the cap and carry no `PREFIX-NN` ids; registering either would fail immediately.
> A new single-document group is the only conforming route. Those three documents still
> receive prose updates in Phase 4, but no new requirement ids.

### Expectations — `TRC-01 … TRC-12`

- **TRC-01:** The artifact projector derives an artifact from a tool surface only when
  that surface carries an `http(s)` preview URL; a tool surface without one derives
  nothing.
- **TRC-02:** No projector-derived artifact is reachable by a gate or an artifact
  binding — projector rows carry `artifact_def_id = NULL` and every
  `artifact_required` / `input.requires` / `output.produces` resolution keys on
  `artifact_def_id`.
- **TRC-03:** An ACP frame the artifact projector cannot classify warns with its
  discriminant and advances; it never poisons a run's projection.
- **TRC-04:** A child run's legacy `outputText` is composed only from artifacts a
  producer deliberately recorded, never from a projector-derived row.
- **TRC-05:** Every prompt dispatched to an agent is recorded as a `user` message in
  `run_messages`, for every prompt-owner variant and for every dispatch within one node
  attempt.
- **TRC-06:** Prompt recording is idempotent per dispatch, enforced by a database
  constraint rather than by application ordering alone.
- **TRC-07:** A prompt row's dispatch identity is derived from the existing owner
  operation-key functions; no parallel identity scheme is introduced.
- **TRC-08:** Prompt recording is best-effort — a failed prompt-row write warns and never
  blocks, delays, or fails dispatch.
- **TRC-09:** A recorded prompt body is bounded at 256 KiB; a longer body is stored
  truncated behind an explicit marker naming the unabridged source.
- **TRC-10:** `run_messages` sequence allocation is serialized on a single per-scope lock,
  so a projector write and a prompt write can never collide on a sequence.
- **TRC-11:** Prompt text in `run_messages` is served only behind `readRepoFiles` and adds
  no exposure surface beyond the one `node_attempts.resolved_prompt` already crosses.
- **TRC-12:** A run created before this change is not modified — no backfill, no
  read-side filter, no retention change.

### Edge cases — `EDGE-TRC-01 … EDGE-TRC-07`

- **EDGE-TRC-01:** A `session.permission_request` carrying a preview URL still derives a
  `preview`; without one it derives nothing (`UT-EDGE-TRC-01`).
- **EDGE-TRC-02:** A payload offloaded to a host-private object is rehydrated before
  classification, so an offloaded preview URL is not lost (`IT-EDGE-TRC-02`).
- **EDGE-TRC-03:** An agent run's prompt row has `node_attempt_id = NULL`; `nulls not
  distinct` keeps both the sequence unique key and the dispatch-key constraint effective
  (`IT-EDGE-TRC-03`).
- **EDGE-TRC-04:** A `consensus_verifier` / `consensus_synthesis` dispatch records its
  prompt like any other owner (`IT-EDGE-TRC-04`).
- **EDGE-TRC-05:** A prompt over 256 KiB is stored truncated with the marker and the
  dispatch still proceeds (`UT-EDGE-TRC-05`).
- **EDGE-TRC-06:** A concurrent duplicate dispatch writes exactly one row; the losing
  insert is a no-op, not an error surfaced to the caller (`IT-EDGE-TRC-06`).
- **EDGE-TRC-07:** With `runs.context_mounts` non-empty the row carries exactly one
  appended line naming the mounted slugs; with no mounts the row is byte-exact
  (`UT-EDGE-TRC-07`).

### Traceability matrix (authored in `run-trace.md` by T0.1)

| Requirement | Contract/schema | Enforcement/task | Primary test | Status |
| --- | --- | --- | --- | --- |
| TRC-01 | `deriveFromToolCall` returns null without a preview URL | T2.3 | `UT-TRC-01` | Planned |
| TRC-02 | `artifact_instances.artifact_def_id` null on projector rows | T2.3 | `IT-TRC-02` | Planned |
| TRC-03 | `UnknownSessionUpdateShape` warn-and-advance | T2.3 | `UT-TRC-03` | Planned |
| TRC-04 | `outputTextFromArtifacts` producer predicate | T2.4 | `UT-TRC-04` | Planned |
| TRC-05 | `run_messages.role='user'` on dispatch | T2.5 | `IT-TRC-05` | Planned |
| TRC-06 | `run_messages_prompt_dispatch_key_uq` | T2.1, T2.5 | `IT-TRC-06` | Planned |
| TRC-07 | `createOperationKey` / `gatePromptOperationKey` reuse | T2.5 | `UT-TRC-07` | Planned |
| TRC-08 | best-effort write contract | T2.5 | `UT-TRC-08` | Planned |
| TRC-09 | 256 KiB bound + truncation marker | T2.5 | `UT-TRC-09` | Planned |
| TRC-10 | `run_transcript_states` `SELECT … FOR UPDATE` | T2.2 | `IT-TRC-10` | Planned |
| TRC-11 | transcript route `readRepoFiles` | T0.3 | `CT-TRC-11` | Planned |
| TRC-12 | absence of migration/filter touching prior runs | T3.3 | `CT-TRC-12` | Planned |
| EDGE-TRC-01 | permission-request derivation path | T2.3 | `UT-EDGE-TRC-01` | Planned |
| EDGE-TRC-02 | `prepareArtifactContent` rehydration | T2.3 | `IT-EDGE-TRC-02` | Planned |
| EDGE-TRC-03 | `nulls not distinct` scope | T2.1, T2.2 | `IT-EDGE-TRC-03` | Planned |
| EDGE-TRC-04 | consensus owner variants | T2.5 | `IT-EDGE-TRC-04` | Planned |
| EDGE-TRC-05 | truncation marker | T2.5 | `UT-EDGE-TRC-05` | Planned |
| EDGE-TRC-06 | concurrent duplicate dispatch | T2.1, T2.5 | `IT-EDGE-TRC-06` | Planned |
| EDGE-TRC-07 | context-mount suffix | T2.5 | `UT-EDGE-TRC-07` | Planned |

Test-id convention follows the project's: `UT-` unit, `IT-` integration, `CT-` contract,
suffixed with the requirement id. **One primary test per requirement** — a second test
covering the same requirement is overlap and must be deleted or re-pointed.

---

## Decisions

**D1 — Kill the `log` derivation at the source; keep `preview`** (TRC-01). The artifact
plane is evidence; the trace already exists and is richer.
*Rejected — collapse per `toolCallId`*: still ~1 078 log rows against 401 real.
*Rejected — filter at read*: see D3.

**D2 — `kind:"log"` stays a legal artifact kind.** It is a declarable manifest kind
([config.schema.ts:273](web/lib/config.schema.ts:273)); flows legitimately produce
`producer:"runner"` log artifacts. Every predicate keys on **`producer='projector'` AND
`kind='log'`**, never `kind` alone.

**D3 — History untouched, and nothing is built for it** (TRC-12). Stated consequence: runs
created before this lands keep their wall. A read filter remains available later; it is
not written now because it would be the only line that does not trace to "new runs must be
clean".

**D4 — Every dispatched prompt becomes a `user` row** (TRC-05). No UI change:
`TranscriptView` already renders `role === "user"`
([transcript-view.tsx:532+](web/components/run-transcript/transcript-view.tsx:532)) and
`getRunNodeTranscript` already returns every role by `sequence`
([run-transcript-projector.ts:137-160](web/lib/runs/run-transcript-projector.ts:137)).
`node_attempts.resolved_prompt` is left untouched — `FlowRunCenter` reads it.

**D5 — The dispatch key reuses the existing operation-key functions** (TRC-07).
`createOperationKey` ([create-intent.ts:100-107](web/lib/execution-host/create-intent.ts:100))
and `gatePromptOperationKey` ([prompt-owner.ts:60](web/lib/flows/graph/prompt-owner.ts:60))
already define canonical per-owner identity. A third scheme would violate DRY and drift
away from the fence identity the rest of the command plane uses. Consensus owners get
their key from the consensus module's own owner adapter, not from a new local switch.

**D6 — The idempotency guarantee is a database constraint, not a lock** (TRC-06). One
nullable `run_messages.prompt_dispatch_key` plus a partial unique index on
`(run_id, node_attempt_id, prompt_dispatch_key) WHERE prompt_dispatch_key IS NOT NULL`.
A check-then-insert under D7's lock is application-level only: a retry from another
process, or a defect in the lock logic, double-writes. **This is one migration; the
earlier draft's "no migrations" was wrong.**

**D7 — One sequence allocator, one lock** (TRC-10). `run_messages` is uniquely keyed
`(run_id, node_attempt_id, sequence)` NULLS NOT DISTINCT and the transcript projector owns
`run_transcript_states.nextSequence`. A shared helper takes `SELECT … FOR UPDATE` on the
state row and the projector acquires the same lock. Contention is low (one claim slot per
run) but correctness must not depend on that.

**D8 — Prompt bodies are bounded at 256 KiB** (TRC-09). A resolved prompt can inject
artifact bodies via `{{ artifacts.<id>.content }}` (ADR-120) and reach megabytes. Storing
it unbounded in `run_messages.content` would reintroduce the exact failure mode this plan
removes. Over the bound the row stores a truncated body plus an explicit marker naming
`node_attempts.resolved_prompt` as the unabridged source for the attempt's first dispatch.

**D9 — The context-mount block is named, never fabricated** (EDGE-TRC-07). Reproducing
`renderContextMountPreamble` web-side would duplicate host logic across two packages with
no shared lib — the same drift trap as `mcpServerFromToolName`.

**D10 — Exposure narrows** (TRC-11). The run detail page admits **any** project role
(`if (!role) notFound()`,
[layout.tsx:350-356](web/app/(app)/runs/[runId]/layout.tsx:350)) and already shows
`resolvedPrompt` to a viewer; `GET /api/runs/{runId}/transcript` requires `readRepoFiles`
(MEMBER) ([transcript/route.ts:62-79](web/app/api/runs/[runId]/transcript/route.ts:62)).
This does not touch `execution-prompt-lifecycle.md:125`, which governs
`execution_commands.request_canonical_json` — command-delivery data, not this read model.

**D11 — No new route, no new body-controlled identifier, no new throw** (TRC-03). Every
task reads existing routes; `UnknownSessionUpdateShape` → WARN + skip is preserved
verbatim. Per `CLAUDE.md` §2, a projection refusal is legitimate only when a retry could
one day succeed.

---

## Tasks

### Progress

- [x] T0.1 Author `docs/system-analytics/run-trace.md`
- [x] T0.2 Register the `TRC` group in the docs validator
- [x] T0.3 Update the API contract before any code
- [ ] T1.1 RED — artifact derivation and evidence safety
- [ ] T1.2 RED — prompt recording
- [ ] T1.3 RED — allocation and idempotency
- [ ] T2.1 Migration — `prompt_dispatch_key`
- [ ] T2.2 One sequence allocator
- [ ] T2.3 Drop the `log` arm of `deriveFromToolCall`
- [ ] T2.4 Producer predicate in `run_collect`
- [ ] T2.5 Record every dispatched prompt
- [ ] T3.1 Refactor under a green suite
- [ ] T3.2 Falsify every guard
- [ ] T3.3 Close the coverage gate
- [ ] T4.1 `/aif-docs` checkpoint

TDD contract for every implementation task below: **RED first** — the test is written and
observed failing *for its assertion*, never for a missing import or a typo; **GREEN** —
the minimum code that turns it green; **refactor** — under a green suite. A task is not
done while any test it owns is red, skipped, or absent.

### Phase 0 — Specification (no production code)

**T0.1. Author `docs/system-analytics/run-trace.md`**
Write the owning document with all seven R5 sections (`Purpose`, `Domain entities`,
`State machine`, `Process flows`, `Expectations`, `Edge cases`, `Linked artifacts`), the
12 `TRC` expectations and 7 `EDGE-TRC` cases above verbatim, and the traceability matrix
with every `Status` at `Planned`.
**Acceptance**: `## Expectations` holds exactly 12 bullets; every id is unique across the
group; every matrix row has a non-blank `Primary test`; every link in `Linked artifacts`
resolves.

**T0.2. Register the `TRC` group in the docs validator**
`scripts/validate-docs-indexes.mjs` — add a `RUN_TRACE_GROUP`
(`documents: ["run-trace.md"]`, `prefixes: ["TRC"]`,
`traceabilityFile: "run-trace.md"`) to `ANALYTICS_GROUPS`; extend
`scripts/validate-docs-indexes.test.mjs` to cover it.
**Acceptance**: the validator passes on the current tree, and **fails** when a `TRC` id is
removed from the matrix or its `Primary test` cell is blanked — prove both directions by
temporary edit, then revert.
*Depends on: T0.1.*

**T0.3. Update the API contract before any code (TRC-11)**
`docs/api/web.openapi.yaml` — `TranscriptMessage` ([:19320-19332](docs/api/web.openapi.yaml:19320)):
state that on a flow or agent run `role: user` carries the prompt dispatched to the agent,
one row per dispatch, bounded at 256 KiB with a truncation marker. Update the
`/api/runs/{runId}/transcript` route description ([:6123](docs/api/web.openapi.yaml:6123))
to say the transcript opens with that prompt, and restate the `readRepoFiles` gate.
**Acceptance**: `CT-TRC-11` asserts the served role set and the documented gate against
the route; the OpenAPI document still parses.
*Depends on: T0.1.*

> **Commit checkpoint 1** — `docs(run-trace): specify the TRC requirement set and contract`

### Phase 1 — RED

Each task writes failing tests only. **No production file is edited in this phase.**

**T1.1. RED — artifact derivation and evidence safety (TRC-01..04, EDGE-TRC-01/02)**
`web/lib/projector/__tests__/artifact-projector.test.ts`:
- `UT-TRC-01` a `tool_call` / `tool_call_update` without a preview URL derives nothing;
- `UT-EDGE-TRC-01` a `session.permission_request` derives `preview` with a URL, nothing
  without;
- `IT-EDGE-TRC-02` an offloaded `contentRef` payload whose
  `content[].resource_link.uri` is `https://` still derives `preview`;
- `UT-TRC-03` an unknown `sessionUpdate` warns and advances, never throws;
- `IT-TRC-02` a projector row is written with `artifact_def_id = NULL` and is therefore
  unreachable by `currentArtifactFor(runId, artifactDefId)`
  ([artifact-store.ts:272-288](web/lib/flows/graph/artifact-store.ts:272));
- `UT-TRC-04` `outputTextFromArtifacts` skips `producer='projector'`.
This task also **discharges the old T1 probe**: `UT-TRC-01`'s fixture replays one
realistic turn and asserts artifacts ≤ events, which is the one-derivation invariant.
**Acceptance**: every listed test fails with an assertion diff. If `UT-TRC-01` shows the
artifact count exceeding the event count, the single-derivation invariant is false —
**stop and re-plan D1**.
**Beware** (`memory:module-scope-calls-break-mocked-suites`): no import-time call into a
partially mocked module — whole files then fail as SKIPS and only the integration lane
notices.
**Beware** (`memory:lenient-test-doubles-hide-contract-bugs`): the double for the
offloaded path must **refuse** what the real `prepareSessionContent` refuses (size / hash
/ generation mismatch), never clamp it.

**T1.2. RED — prompt recording (TRC-05..09, EDGE-TRC-04/05/07)**
Unit tests for the key derivation, the 256 KiB bound and marker, the best-effort
contract, and the context-mount suffix; integration tests for the six owner variants.
**Acceptance**: `IT-TRC-05` fails showing one recorded prompt where three are expected
(node + gate + resume) — the current owner filter and write-once guard are exactly what it
must expose. `UT-TRC-07` fails because no key function is wired yet.

**T1.3. RED — allocation and idempotency (TRC-06, TRC-10, EDGE-TRC-03/06)**
`IT-TRC-10` races one prompt write against one projected `agent_message_chunk` on the same
scope; `IT-TRC-06` and `IT-EDGE-TRC-06` assert the duplicate-dispatch no-op;
`IT-EDGE-TRC-03` covers `node_attempt_id = NULL`.
**Acceptance**: `IT-TRC-06` fails on a missing column — a legitimate RED for a schema
requirement; `IT-TRC-10` fails on a unique-constraint violation, which is the collision the
lock must remove. Record the observed failure rate of `IT-TRC-10` against the unfixed
allocator and repeat until a miss would be visible
(`memory:falsify-every-regression-guard`).

> **Commit checkpoint 2** — `test(run-trace): failing specs for TRC-01..12` *(suite is red by design; the commit message must say so)*

### Phase 2 — GREEN

Minimum code per requirement. No task may turn a test green by weakening it.

**T2.1. Migration — `prompt_dispatch_key` (TRC-06, EDGE-TRC-03/06)**
Drizzle migration: nullable `run_messages.prompt_dispatch_key text` plus a partial unique
index `run_messages_prompt_dispatch_key_uq` on
`(run_id, node_attempt_id, prompt_dispatch_key) WHERE prompt_dispatch_key IS NOT NULL`,
`nulls not distinct` to match the existing sequence key.
**Acceptance**: `IT-TRC-06`, `IT-EDGE-TRC-03`, `IT-EDGE-TRC-06` green; existing
`run_messages` rows unaffected; the projector's own inserts leave the column NULL and are
not constrained by the new index.
**Docs**: `docs/database-schema.md` + regenerate `docs/db/erd.dbml` (ADR-159) in T4.1.

**T2.2. One sequence allocator (TRC-10)**
`appendRunMessage(tx, {runId, nodeAttemptId, role, content, promptDispatchKey?, supervisorEventId?})`:
one transaction, `SELECT … FOR UPDATE` on the `run_transcript_states` row for
`(runId, nodeAttemptId)` (inserting at `nextSequence = 0` when absent), insert, bump. Then
make `projectTranscriptEvent`
([transcript-projector.ts:145-175](web/lib/execution-host/events/transcript-projector.ts:145))
load its state under the same lock.
**Must not change** the projector's coalescing pointers (`openTextSequence`,
`openThoughtSequence`, `usageSequence`) or the `tool_update` jsonb merge SQL
([:249-265](web/lib/execution-host/events/transcript-projector.ts:249)).
**Acceptance**: `IT-TRC-10` green; the whole existing transcript suite still green.
**Logging**: DEBUG `{runId, nodeAttemptId, role, sequence}` per allocation.

**T2.3. Drop the `log` arm of `deriveFromToolCall` (TRC-01..03, EDGE-TRC-01/02)**
[artifact-projector.ts:133-149](web/lib/projector/artifact-projector.ts:133) — return
`Derivation | null`; keep the `preview` branch; narrow `Derivation["kind"]` to
`"preview"`; delete `shortLogSummary`, which **this change** orphans. Update the comment
above `NON_DERIVING_SESSION_UPDATES`
([:33-39](web/lib/projector/artifact-projector.ts:33)).
**Do not touch** `prepareArtifactContent` — a preview URL can only be found inside the
rehydrated payload; skipping the fetch would silently lose previews. Add a DEBUG log of
rehydrated bytes per event so the cost stays visible.
**Acceptance**: `UT-TRC-01`, `UT-TRC-03`, `IT-TRC-02`, `UT-EDGE-TRC-01`, `IT-EDGE-TRC-02`
green.
**Logging**: DEBUG `{runId, eventId, sessionUpdate, derived: "preview"|null}`.

**T2.4. Producer predicate in `run_collect` (TRC-04)**
[collect.ts:110-119](web/lib/run-results/collect.ts:110) — add `producer !== "projector"`;
`ArtifactRow` ([:88-100](web/lib/run-results/collect.ts:88)) gains `producer`; the building
query selects the column.
**Scope note**: after T2.3 no new run produces a projector log row, so this has no live
effect on new runs. It is retained because `run_collect` must not read a projector-derived
row as a child's deliberate output — otherwise correctness depends on another file
happening not to write one. It is backed by `TRC-04`, so it is not an orphan task under the
coverage gate.
**Acceptance**: `UT-TRC-04` green.

**T2.5. Record every dispatched prompt (TRC-05, 07, 08, 09; EDGE-TRC-04/05/07)**
At [runner-agent.ts:1251-1290](web/lib/flows/runner-agent.ts:1251), beside the existing
`resolved_prompt` persist, call `appendRunMessage` with `role: "user"` and the dispatched
bytes — **without** the owner-variant filter and **without** the `isNull` write-once guard.
- **Key (D5)**: one small total function over the six ctx variants that delegates to
  `createOperationKey` / `gatePromptOperationKey` / the consensus owner adapter and
  prefixes the result — no new identity scheme, no duplicated string building.
- **Bound (D8)**: 256 KiB, truncation marker naming `node_attempts.resolved_prompt`.
- **Best-effort (TRC-08)**: warn on failure, never block dispatch.
- **Context mounts (D9)**: one appended labelled line when `runs.context_mounts` is
  non-empty.
**Acceptance**: `IT-TRC-05` shows three rows for node + gate + resume; `IT-EDGE-TRC-04`
covers both consensus variants; `UT-TRC-07`, `UT-TRC-08`, `UT-TRC-09`, `UT-EDGE-TRC-05`,
`UT-EDGE-TRC-07` green.
**Logging**: DEBUG `{runId, stepId, ownerVariant, promptLen, truncated, sequence}`.

> **Commit checkpoint 3** — `feat(run-trace): suppress projector log artifacts and record dispatched prompts`

### Phase 3 — Refactor and prove

**T3.1. Refactor under a green suite (SOLID / KISS / DRY + project conventions)**
- **DRY**: exactly one place derives a dispatch key; exactly one place allocates a
  `run_messages` sequence; no copy of `renderContextMountPreamble`.
- **KISS**: no abstraction introduced for a single caller; the key function is a total
  switch over the owner union, not a registry.
- **SOLID**: `appendRunMessage` takes a transaction and knows nothing about prompts;
  prompt-specific concerns (bound, marker, key, context-mount line) live with the
  dispatcher.
- **Conventions**: `MaisterError` with a `code` for any domain failure, never a plain
  `Error`; no `any` without `// FIXME(any):`; comments explain **why**, never what.
**Acceptance**: no behavior change — the suite is green before and after, and `git diff`
shows no test file edited in this task.

**T3.2. Falsify every guard**
Per `memory:falsify-every-regression-guard`, revert each fix in turn and confirm the
matching primary test **fails**: T2.3 → `UT-TRC-01`; T2.4 → `UT-TRC-04`; T2.5 →
`IT-TRC-05`; T2.1 → `IT-TRC-06`; T2.2 → `IT-TRC-10`. Record the outcome per requirement. A
guard that still passes against unfixed code is not a guard and is rewritten.

**T3.3. Close the coverage gate (TRC-12)**
Flip every matrix `Status` to `Implemented`. Verify bidirectionally by hand, in the shape
`validate-m51-coverage.mjs` automates for M51: every `TRC`/`EDGE-TRC` id names at least one
task, and every Phase-2 task is named by at least one requirement. `CT-TRC-12` asserts the
absence of any migration or query predicate that reads or mutates pre-existing runs.
**Acceptance**: `pnpm --filter maister-web lint` and the full suite green; the docs
validator green; no orphan in either direction.

> **Commit checkpoint 4** — `refactor(run-trace): close the TRC coverage gate`

### Phase 4 — Documentation truth pass

**T4.1. `/aif-docs` checkpoint**
Per `memory:docs-truth-pass-after-milestones`, verify prose against the **code**.
- `docs/system-analytics/artifacts.md` — the projector derives previews only; `log` remains
  a manifest kind; prior runs keep their projector rows (TRC-12).
- `docs/system-analytics/runs.md` — §Run transparency: a transcript now opens with the
  dispatched prompt as a `user` message, one per dispatch. **And fix §605-623**: the Prompt
  disclosure lives in the run centre (`flow-run-attempt-prompt`), not on the Timeline tab —
  the component's `TimelineEntry` has no `resolvedPrompt` field
  ([run-timeline.tsx:44-67](web/components/board/run-timeline.tsx:44)).
- `docs/system-analytics/execution-event-plane.md` — `run_messages` now has a
  non-projector writer; both take the same state lock.
- `docs/system-analytics/execution-prompt-lifecycle.md` — the per-dispatch prompt is
  recorded in `run_messages` behind `readRepoFiles`, distinct from
  `execution_commands.request_canonical_json`. **Prose only — no `PRM-13`; that document is
  at the 12-bullet cap.**
- `docs/system-analytics/run-results.md` — `outputText` no longer reads projector rows.
- `docs/database-schema.md` + regenerated `docs/db/erd.dbml` for `prompt_dispatch_key`.
- `docs/decisions/adr-052.md` — its context paragraph still claims the run stream carries
  `session.line|update|permission_request|exited|crashed`, untrue since ADR-167.
  Accepted-ADR text is immutable → add a dated `**Amendments:**` entry
  (`docs/CLAUDE.md` §R4); do not edit the decision.
- **No new ADR** — nothing changes a confinement rule or an event contract.

> **Commit checkpoint 5** — `docs(run-trace): align artifact, transcript and prompt contracts`

---

## Contract surfaces changed → spec file

| Surface | Change | Spec file that must move with it |
| --- | --- | --- |
| `run_messages` | new `prompt_dispatch_key` + partial unique index | migration + `docs/database-schema.md` + `docs/db/erd.dbml` |
| `run_messages` writers | second, non-projector writer; shared state lock | `run-trace.md`, `execution-event-plane.md` |
| `run_messages.role = "user"` | carries the dispatched prompt, bounded | `run-trace.md`, `TranscriptMessage` in `docs/api/web.openapi.yaml` |
| `GET /api/runs/{runId}/transcript` | description + gate restated | `docs/api/web.openapi.yaml` |
| `artifact_instances` projector derivation | `log` no longer produced | `artifacts.md`, `execution-event-plane.md` |
| `run_collect` child `outputText` | projector rows excluded — **a shipped contract narrows** | `run-results.md`, `docs/api/web.openapi.yaml`, the MCP tool description if it restates the field |
| Prompt recording scope | gate, consensus and repeat dispatches recorded | `run-trace.md`, `execution-prompt-lifecycle.md` (prose) |
| Docs validator | new `TRC` analytics group | `scripts/validate-docs-indexes.mjs` + its test |
| `runs.md:605-623` | documents a Timeline-tab disclosure that lives in the run centre | `runs.md` — doc fixed, code unchanged |
| ADR-052 context | stale since ADR-167 | dated `**Amendments:**` entry |

## Deployment touchpoints

One Drizzle migration (T2.1) on the existing `pnpm --filter maister-web db:migrate`
lineage. **No env var, no runtime config file, no sidecar binary, no bound port, no new
`package.json` script** — `Dockerfile`, `compose.yml`, `compose.override.yml`,
`compose.production.yml` and `.env.example` stay untouched. Nothing is run against
pre-existing data.

## Commit plan

| # | Covers | Message |
| --- | --- | --- |
| 1 | T0.1–T0.3 | `docs(run-trace): specify the TRC requirement set and contract` |
| 2 | T1.1–T1.3 | `test(run-trace): failing specs for TRC-01..12` *(red by design)* |
| 3 | T2.1–T2.5 | `feat(run-trace): suppress projector log artifacts and record dispatched prompts` |
| 4 | T3.1–T3.3 | `refactor(run-trace): close the TRC coverage gate` |
| 5 | T4.1 | `docs(run-trace): align artifact, transcript and prompt contracts` |

Merge to `master` with `--no-ff` only after the suite is green
(`memory:red-suites-block-the-milestone`): classify any red test as obsolete vs broken and
resolve it in this increment.

## Explicit non-goals

- **Any UI change.** No component, layout, or i18n key is touched.
- **Any history change.** No backfill, no read filter, no retention sweep (TRC-12).
- Rendering `plan` entries, `usage` numbers, `locations[]`, or non-text tool content — all
  recorded as known gaps; each needs UI work.
- Moving `LegacyRow` out of the inline flow — UI.
- Adding `resolvedPrompt` to the Timeline tab — the doc is corrected instead (T4.1).
- The `session.line` double-write — recorded, not changed.
- Automating the `TRC` bidirectional coverage check in a script (M51 has
  `validate-m51-coverage.mjs`; T3.3 does it by hand for one small group).
- Any change to the supervisor's zod seam, which still kills a session on an unknown
  `sessionUpdate` ([bounded-acp-stream.ts:545-551](supervisor/src/bounded-acp-stream.ts:545)).
