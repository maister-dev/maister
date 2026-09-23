# Implementation Plan: P0-4 — HITL refusal reasons and stored-answer cards

Branch: `codex/p0-4-hitl-operator-surface`
Created: 2026-09-23
Base: `ae99f9d0704a47ce7c502e4ef0f0a64904bf535e` (the supplied master baseline)
Status: Implementing; Phase 0 specifications frozen and validated.
Refinement: 2026-09-23 — SDD contracts, acceptance traceability and incremental TDD.

## Goal

Expose the reason for a refused or delayed HITL answer in EN/RU on board,
inbox, run and scratch surfaces, preserve it through external REST and MCP,
and render a persisted, undelivered answer as read-only after submission and
refresh. Preserve all ADR-180 state transitions and delivery ownership.

## Settings

- Testing: yes; the requested RED W1/W2/U1/U2/U3/S1/R1 gates and falsification
  checks are mandatory. T1 takes the explicitly permitted B6 deferral branch.
- Logging: standard structured operational logs, existing `LOG_LEVEL` control;
  add public reason fields at the refusal boundaries, without answer bodies,
  private delivery metadata, tokens or host handles. No new telemetry pipeline.
- Docs: yes; mandatory docs-first freeze and completion checkpoint through
  `$aif-docs`. This planning invocation stops at the plan.
- Git: local branch created from the current isolated worktree's exact baseline;
  no base checkout, pull, merge, push or extra worktree is needed.
- Deployment wiring: none. No dependency, binary, port, mount, environment
  variable, DB column, migration, host contract or supervisor code change.
- Workflow: serial implementation and validation; quiet machine, never beside
  an isolation slice. Existing test infrastructure is authoritative.
- Design discipline: pure typed projections and message resolution, small
  single-purpose route adapters, one copy registry and one answer projector.
  Apply SOLID at the existing module boundaries; do not add a generic replay
  framework, class hierarchy, behavior flags or adjacent refactoring.

## Roadmap Linkage

Milestone: `none`.
Rationale: the explicit execution-seam item P0-4 is the tracking boundary;
no additional roadmap milestone is inferred. Missing linkage is WARN only.

## Evidence and integration notes

The user's C1/C2/C4 findings are accepted and cited, not a new diagnostic task.
All paths below are repository-relative; supplied line numbers refer to the
baseline and can move during implementation.

| Input finding | Baseline citation | Plan consequence |
| --- | --- | --- |
| C1: web drops details | `web/app/api/runs/[runId]/hitl/[hitlRequestId]/respond/route.ts:42-95` | Add safe detail serialization and reason logging; preserve status mapper. |
| C1: service discriminators/anonymous conflicts | `web/lib/services/hitl.ts:906-975,1468-1483,1710-1732,3048`; `web/lib/execution-host/prompt-owners.ts:56-72` | Preserve existing reasons; label claim refusals at their throws; label service-built delivery errors. |
| C1: external/MCP surface | `web/app/api/v1/ext/runs/[runId]/hitl/[hitlRequestId]/respond/route.ts:190-206`; `mcp/src/tools.ts:1305-1322` | Keep external authorization/status behavior; test the actual MCP result. |
| C1: opaque UI and dead map | `web/components/board/run-hitl-response.tsx:131-176`; `web/lib/ui-error-message.ts:7-27`; `web/lib/scratch-runs/dialog.ts:112-116`; `web/components/board/hitl-actions.tsx` | One shared resolver, remove dead component, retain per-code fallback. |
| C4: checkpoint/resume versus terminal | `docs/decisions/adr-180.md`; `docs/system-analytics/hitl.md:970-984,1073-1082,1205-1231`; `web/lib/services/hitl.ts:1537-1650` | Do not change classification, transactions, CAS, sweeps or drivers. |
| C2: pending rows hide stored answers | `web/lib/queries/hitl.ts:79,90,408`; `web/lib/queries/run.ts:585` | Derive state before client work; never treat stored as delivered. |
| B6: no durable run-level cause | `web/lib/db/schema.ts:1778-1900`; `web/components/runs/flow-run-center.tsx:249` | Choose 5(b); persistent terminal-run cause remains a named limitation. |
| Wire namespace boundary | `docs/api/web.openapi.yaml:20558-20585`; `web/lib/execution-host/types.ts:151-162` | Add nested web details, never extend top-level workspace reason or host ReasonToken. |

Targeted planning inspection found these additional integration points:

- `HitlItem` / `mapRowsToHitlItems` in `web/lib/queries/hitl.ts` already select
  `storedResponse`; `getCrossProjectHitlInbox` in `web/lib/queries/portfolio.ts`
  shares that mapper. `RunPendingHitl` / `getRunDetail` in
  `web/lib/queries/run.ts` need the response added to their select and mapping.
- Scratch reads a separate DTO in
  `web/app/api/scratch-runs/[runId]/route.ts` (`PendingHitlRow`, `publicHitlSchema`)
  and `ScratchDetail.pendingHitl` in `web/lib/scratch-runs/dialog.ts`.
- Both inbox `RunHitlResponse` call sites supply `onRespond={() => router.refresh()}`;
  their local stored state must be set before that callback. Run layout has
  multiple card mounts; all must pass the new read-model fields.
- MCP has **two additional lossy layers**: `restResponseToToolError` in
  `mcp/src/rest.ts` reconstructs code/message only, and the failure branch in
  `mcp/src/main.ts` emits only `result.message`. Testing `resolveRouting` or
  `dispatchTool` alone cannot prove W1. Include the real `Client.callTool` result.
- The actual external spec is `docs/api/external/operations.openapi.yaml`.
  `ExtErrorBody.details.requiredScope` already exists: preserve it for scope
  refusals while adding the respond detail properties.
- Contract compatibility correction: the shared `MaisterErrorBody` also
  already has an open `details` object at `web.openapi.yaml:20591-20602`, with
  unrelated publish/edit-lock/artifact contexts. The supplied C1 evidence
  identifies the missing HITL contract, but must not lead to a duplicate YAML
  key or global restriction of those other routes. Use a respond-specific
  refinement of the existing shared schema (D8).
- `HitlPanel` currently gates both card mounts on canAct, and scratch
  `loadDetail` clears its shared error state. Stored-state display must be
  independent of mutation authorization, and terminal refusal feedback must
  outlive card removal and detail reload.
- Board ownership correction: project page.tsx loads `getHitlInbox` separately
  from `getBoardData`; the latter intentionally has no inline HITL fields
  (`board-hitl.integration.test.ts:198-240`). U3 must call the board's actual
  getHitlInbox projection, not restore the removed flight-card DTO.
- ExtHitlRespondResponse currently requires runStatus and allows only
  NeedsInput/Done plus one 202 state. Existing delivered/delivery-in-progress
  bodies can omit runStatus. Correct this touched response contract in D8.
- `web/lib/flows/graph/ledger.ts:197-222` `markNodeFailed` unconditionally sets
  attempt status/end time, clears stdout/exit code when omitted, and accepts
  no errorMessage. `failCheckpointedFlowPermission` in
  `web/lib/flows/graph/permission-rejection.ts` requires a parked generation,
  owner/evaluation checks and rejected-input evidence. Neither is a safe
  metadata-only write at the live terminal-410 transaction. This grounds 5(b).

## Frozen decisions

### D1. Web response reason contract

Use one client-safe `HitlRespondReason` registry in a new
`web/lib/hitl-response-contract.ts`; keep server serialization in a small
`web/lib/hitl-response-error.ts` module. Do not import execution-host modules
into client code and do not modify the host enum to reuse its type.

The response detail allow-list is `reason`, `causeCode` only. Select fields
explicitly; never spread `err.details`. Define the nine tokens below as the
closed respond registry. Serialize registered string reasons, with optional
bounded diagnostic cause code; omit non-public/unknown detail fields. Unknown
reason input on the client still falls back to the code line for forward
compatibility. Keep absent details absent; do not emit `{ reason: undefined }`.
Log the public reason as `details: { reason }` beside existing request context,
code and status. Unknown private reasons are not copied into wire bodies.

`causeCode` is a string matching `^[a-z][a-z0-9_]{0,63}$`, not a new closed
enum: the examples in the brief are not the whole application registry.
Only display a validated cause code for the two prompt-owner reasons, in
`<code>` with a localized diagnostic label. No other details or raw message
are rendered. Do not alter the throwing prompt-owner classes.

| Code | details.reason | Situation / operator action | HTTP |
| --- | --- | --- | --- |
| CONFLICT | permission_resume_in_flight | A resume owns delivery; wait for it to finish. | 409 |
| CONFLICT | assignment_fenced | A newer execution owns the run; check the refreshed run. | 409 |
| PRECONDITION | prompt_owner_deferred | Execution is waiting for a recorded transition; wait and retry delivery if still pending. | 409 |
| CONFLICT | prompt_owner_invariant | Execution consistency check failed; inspect the diagnostic before retrying. | 409 |
| CONFLICT | already_delivered | This request was already answered; inspect the refreshed run. | 409 |
| CONFLICT | option_mismatch | A different answer is already stored; use the stored answer's retry action. | 409 |
| CONFLICT | not_awaiting_input | The run no longer awaits this answer; inspect the refreshed run. | 409 |
| HITL_TIMEOUT | agent_session_ended | Agent session ended before delivery; relaunch flow, Recover or relaunch scratch. | 410 |
| EXECUTOR_UNAVAILABLE | delivery_unavailable | Answer is saved; delivery happens when the run resumes. | 503 |

Add the three claim reasons to both permission and form/human claim checks,
including different structured-payload retries (`option_mismatch` means a
different answer, not only a binary choice). Preserve the order of checks,
successful idempotent branches and existing HTTP status. Analogous plan-review
claim refusals may use the same tokens; do not invent another namespace.
Map the existing terminal-run and superseded-permission claim refusals to
`not_awaiting_input` as well; neither means already_delivered. Keep their
current precedence over the later delivered/same-payload checks. Table-driven
route cases must cover these throws, not only the final pending-status guard.
The existing PRECONDITION for no prepared delivery remains PRECONDITION;
do not recode it just to fit the table.

The terminal body message is English, with action selected from server-owned
run kind: “The agent session ended before your answer arrived. Relaunch the run.”
Scratch: “The agent session ended before your answer arrived. Recover the run
or relaunch it.” Both carry `agent_session_ended`.
The permission delivery 503 message is “Your answer is saved and will be
delivered when the run resumes.” It carries `delivery_unavailable` for restart,
parking and post-grace absence alike; do not infer finer host causes.

Inventory every service-built respond 503, including the idle-resume
`terminal:false` branch and plan-review/form artifact-write failures. For
post-claim delivery failures, add `delivery_unavailable` and the saved-answer
message; retain existing code, status and `terminal` fields. Assert that the
answer is committed before each such response. This token describes delivery
unavailability, not a host outage. The sentence about delivery on resume is
conditional on a resume; it does not introduce automatic retry. Keep the
explicit same-payload retry control for existing paths that require it.
An error thrown before a durable claim must not assert that an answer was
saved: route serialization adds only its existing safe details. Freeze these
distinctions in the 503 description and examples.

### D2. One EN/RU reason-to-copy resolver

Extend `web/lib/ui-error-message.ts` with a typed HITL payload resolver keyed
first by code, then reason. Keep the existing generic resolver for other
actions. Store the new reason copy once under the existing `run` translation
namespace; scratch uses that namespace for these messages, not a duplicated
scratch reason catalog. Update `dialog.ts` `ApiError` and `errorText` to use
the same resolver; update all its callers coherently so unrelated scratch
errors still get their existing generic localized behavior.

Frozen copy (two short sentences: situation, then action):

| Reason | EN | RU |
| --- | --- | --- |
| permission_resume_in_flight | Your answer is already being delivered as the run resumes. Wait for the run to continue. | Ответ уже передаётся при возобновлении запуска. Дождитесь продолжения запуска. |
| assignment_fenced | A newer execution has taken over this run. Check the refreshed run before retrying delivery. | Управление запуском перешло к новому исполнению. Проверьте обновлённый запуск перед повторной доставкой. |
| prompt_owner_deferred | Execution is waiting for a recorded state change. Wait, then retry delivery if the answer is still pending. | Исполнение ожидает зафиксированного изменения состояния. Подождите, затем повторите доставку, если ответ ещё ожидает передачи. |
| prompt_owner_invariant | Execution failed a consistency check. Check the diagnostic detail before retrying delivery. | Исполнение не прошло проверку согласованности. Проверьте диагностическую информацию перед повторной доставкой. |
| already_delivered | This request has already been answered. Check the refreshed run. | На этот запрос уже ответили. Проверьте обновлённый запуск. |
| option_mismatch | A different answer is already saved for this request. Retry delivery of the saved answer. | Для этого запроса уже сохранён другой ответ. Повторите доставку сохранённого ответа. |
| not_awaiting_input | This run is no longer waiting for this answer. Check the refreshed run. | Запуск больше не ожидает этот ответ. Проверьте обновлённый запуск. |
| agent_session_ended (flow) | The agent session ended before your answer arrived. Relaunch the run. | Сессия агента завершилась до получения ответа. Запустите процесс заново. |
| agent_session_ended (scratch) | The agent session ended before your answer arrived. Recover the run or relaunch it. | Сессия агента завершилась до получения ответа. Восстановите запуск или запустите его заново. |
| delivery_unavailable | Your answer is saved and will be delivered when the run resumes. Wait for the run to resume. | Ответ сохранён и будет передан при возобновлении запуска. Дождитесь возобновления запуска. |

Correct `run.error.HITL_TIMEOUT` to the session-ended explanation and the
appropriate action in each caller context; `run.error.EXECUTOR_UNAVAILABLE`
to the saved/delivered-on-resume permission copy; attempt
`codes.HITL_TIMEOUT` to session-ended/relaunch, removing input-timeout advice.
Unknown reason falls back to `error.<code>`, unknown code to `error.generic`.
Do not branch on server message text, status text or causeCode.
The resolver returns a typed message descriptor, not already-translated text,
so a locale change re-renders the current refusal. It must distinguish a
respond outcome from preview/load/message/recover failures: the preview catch
in `RunHitlResponse` and non-HITL `errorText` callers must not acquire saved-
answer wording just because they share EXECUTOR_UNAVAILABLE. Keep the shared
code fallback, but require confirmed stored state for the saved assertion;
otherwise show the localized cannot-confirm-delivery message. A known reason
paired with the wrong code falls back to that code, never to the reason alone.
Implement that fallback through the same `error.EXECUTOR_UNAVAILABLE` key
with an ICU select over the known answerState: answer_stored uses the required
saved/on-resume wording, other uses cannot-confirm wording. Unknown reasons
still select the per-code key. The named delivery_unavailable reason itself
is server evidence for saved state; transport/preview/load failures are not.

Distinguish browser transport failure from a server-confirmed saved answer.
Replace the card's catch path that fabricates EXECUTOR_UNAVAILABLE with a
localized message: “Delivery could not be confirmed. Refresh the run to check
whether your answer was saved.” / “Не удалось подтвердить доставку. Обновите
запуск, чтобы проверить, сохранён ли ответ.” Do not set answer_stored from
this catch. Preserve an already known stored answer and its retry payload.
This is not another server reason or a change to the server error taxonomy.

Delete `web/components/board/hitl-actions.tsx`. Remove only its obsolete test
imports/cases, preserving production-card stale-view coverage. Do not delete
`web/lib/api-error.ts` if other production actions still use it.

### D3. Derived state and immutable public replay data

For an undelivered row, derive `answerState` from raw SQL-null semantics:
`response IS NOT NULL AND responded_at IS NULL` means `answer_stored`, otherwise
`open`. Do not use truthiness or sanitized-response emptiness; `{}`, false,
zero and private-key-only records are not open. A delivered row is absent
from pending collections, not represented by a third answer state.
Compute the SQL non-null predicate in the select where JSON null could be
decoded to JavaScript null; the projector receives that internal boolean.
Do not accidentally conflate SQL NULL with a non-null JSONB value of `null`.
That internal boolean is not an additional client field.

Expose `storedResponse` alongside answerState as the sanitized, immutable
**public POST envelope**, not raw hitl_requests.response. It is the sole
companion payload needed to show and retry an answer; do not add separate
confidence or retry-capability fields. Define a typed permission envelope
`{optionId:string}` and structured envelope `{response:JsonValue,
confidence?:number}` in `web/lib/hitl-response-contract.ts`, with a pure
projector in `web/lib/hitl-answer-view.ts`. Null means no safe replay envelope;
answerState distinguishes an open row from a stored but non-replayable row.
Permission projection contains only optionId. Structured projection strips
all `_`-prefixed keys recursively without mutating DB data and is emitted only
when the resulting request reconstitutes the exact service-canonical answer.
Read human_confidence server-side and include envelope.confidence only when
non-null (including zero). Preserve public response.confidence where already
stored. A scalar/array response still has its confidence in the envelope;
never wrap it into a different response value.

Server DTOs must be authoritative after a refresh. Extend:

- `HitlItem` / `mapRowsToHitlItems`, `getHitlInbox`, and the shared portfolio
  mapper/select used by `getCrossProjectHitlInbox`.
- `RunPendingHitl` / `getRunDetail` select and every pendingHitls member.
- Scratch `PendingHitlRow`, GET response and `ScratchDetail.pendingHitl`.
- The run-scoped external `toExtHitlDTO` and its schema; the cross-project
  external inbox mapper exposes answerState only (D8), preserving discovery
  versus response-content boundaries.

Keep pending/delivered counting based on `responded_at IS NULL`; storing an
answer must not optimistically decrement “Needs you”. Audit `getBoardData`,
`computeDecisionsQueue` and project/global badge consumers. Existing awaiting-
run filters may otherwise hide a permission row during a live resume. Retain
the existing awaiting-run arm and add only `kind=permission AND response IS
NOT NULL AND responded_at IS NULL AND superseded_at IS NULL AND status=Running`
to the shared pending read predicate. `markResumed` enters NeedsInput; the
confirmed handoff can return Running. No evidence requires exposing all other
nonterminal statuses. Keep
project/membership/archive authorization, agent-question lifecycle filters and
budget-breach claim visibility intact. This is a read predicate change only;
no run status writes or new status classifications. Test actual resume states,
not just a seeded NeedsInput row.

For permission replay send exactly `{ optionId: storedResponse.optionId }`.
Never send `_delivery`, schema.requestId, a host session id, an execution
assignment id or an alternative option. For form/human replay POST the stored public envelope unchanged; preserve current specialized review/budget/interrupt behavior. Do not
recompute a fresh review fingerprint, invoke preview, or restart a workflow
as a side effect of the retry-delivery control. Test existing idempotent
acceptance for the supported structured kinds as well as permission.
Replay must satisfy the existing `payloadsEqual`/kind-specific validation, not
merely reproduce a sanitized display object. Permission is always projected
by optionId; form/human replay is enabled only when reconstructing the public
body is lossless under the existing service's canonical comparison. When no lossless envelope can be produced, return storedResponse=null
while retaining answer_stored. If stripping a private key changes a structured
answer's compared value, render it read-only with “This saved answer cannot
be retried from this card. Open the run to inspect delivery.” (and RU parity),
never re-POST the lossy value. Budget/interrupt/plan-review composites keep
their existing specialized progress/remediation and replay contracts. Do not
change `payloadsEqual`, expose private fields, or add a retry request flag.
These compatibility exceptions must be documented; they do not weaken U3's
mandatory normal permission retry or ordinary lossless form replay.

An invalid stored permission payload remains read-only with a localized
diagnostic; it must never default to Allow, `{}` or a new choice. The normal
valid permission state has exactly one retry-delivery action, authorized by
the same canAct check as the original answer and disabled while in flight.

### D4. Immediate card behavior

Client state is scoped by `(runId, hitlRequestId)`; no state is carried to a
different request. Capture the submitted immutable public payload before POST.
For recognized 202 states `resume-in-progress`, `delivery-in-progress`,
`resume-queued`, set the stored presentation before invoking `onRespond` or
refresh. A stale same-request `open` prop must not reopen the controls after
that acknowledged 202. Server removal after respondedAt wins and unmounts the
card. Preserve the existing completed behavior for 200 and for
`rework-scheduled`; do not reinterpret every 202 as pending permission delivery.

For server-confirmed `delivery_unavailable`, retain the submitted payload and
show the same saved state immediately for a direct permission claim. Composite
plan-review replies must reconcile their server-generated parent response
instead of treating the last child's submitted payload as that parent answer.
For `permission_resume_in_flight` or
`option_mismatch`, refresh to obtain the authoritative stored payload; do not
assert that the losing tab's selection is what was saved. Disable choice
controls during that reconciliation. Preserve existing stale refresh behavior
for CONFLICT/PRECONDITION/HITL_TIMEOUT without letting it reopen stored options.
Keep a reconciliation failure visible with a refresh action; never silently
re-enable choices after a failed GET. Ignore late POST/GET completions for a
different request id. Prefer rendered state keyed to request identity, using
refs only to cancel/identify obsolete requests, not as the UI state store.

Read-only cards show the chosen option's label, disabled choice controls or a
noninteractive summary, an aria-live saved/delivery line and one “Retry
delivery” / “Повторить доставку” action. Structured fields are also read-only.
Use “Answer saved — delivering on resume” / “Ответ сохранён — будет передан
при возобновлении”. Retry may itself receive 409 resume-in-flight; show its
reason and retain the stored state. An ordinary eligible retry must use the
existing same-payload idempotent branch and return 200 or 202.
Visible stored summaries must also render when canAct is false; omit/disable
only retry, preserving all existing read-scope restrictions. The required
permission retry action is enabled only when canAct is true, storedResponse
contains a valid envelope, and no request is pending. Invalid stored payloads never become choices.

The scratch conversation owns equivalent local state around `answerHitl` and
`loadDetail`; `ScratchPermissionPanel` renders it. A reload or late stale GET
must not briefly restore editable options. Store scratch HITL refusal feedback
separately from loadDetail errors, so its leading setError(null) does not erase
the response reason. Clear it only on an explicit new answer/retry, dismissal,
or navigation to another run. For board/inbox/run cards, emit the localized
terminal message through the existing `useFeedback` provider before refresh
so unmount cannot erase it; keep nonterminal remediation inline. Use one
mutationId per submission for deduplication and do not duplicate toasts for
ordinary pending 202/503 outcomes. This is transient feedback, not B6 storage.
Do not add polling, timers, localStorage, new delivery ownership or automatic
background retries; retain existing SSE/read refresh mechanisms.

### D5. B6 and terminal boundaries

Choose **5(b)**. No node-attempt failure write is added; the run page's durable
terminal-cause read model remains unchanged. The responding view does show
the terminal refusal message, and existing attempt errors get corrected copy,
but a fresh visit to the terminal flow run can still lack a durable cause.
Record T1 as an explicit deferred acceptance item, not a green implementation
test or a skipped test presented as evidence. Do not add an invented failing
test to every CI run for the deferred B6 work.

The crash-within-30-second-grace classification remains the supplied follow-up:
an answer can reach Failed where ADR-177 later reaches Crashed/Recover. Copy
must say session ended, never that the operator ran out of time.

### D6. MCP and authorization contract

The thin MCP facade must preserve the complete public respond body, including
details, instead of extracting its message. For upstream hitl_respond errors,
retain the parsed JSON body through `rest.ts` / `dispatchTool` and emit it as
JSON text in `CallToolResult.content`, with MCP `isError: true` outside that
body. Transport status belongs to the facade envelope/log, not to a rewritten
upstream error body. Success bodies (including 202 state) remain unchanged.
Keep unrelated tools' existing error presentation; implement the narrow
hitl_respond path with explicit types/functions rather than a behavior flag
on a generic formatter. Do not require structuredContent/outputSchema merely
to deliver the existing JSON body. Include this presentation delta in the
ADR-180 amendment and external-operations tool documentation.

Identifiers and data class for touched routes:

| Surface | URL parameters | Auth context | Server-derived | Body-controlled |
| --- | --- | --- | --- | --- |
| Web respond | runId, hitlRequestId | active user id/role | project, run kind/status, HITL schema/row, stored answer, assignment and session ownership | optionId, response, confidence; existing raiseTo/dropWorkspace/review fingerprints remain validated by their existing service path |
| Ext respond | runId, hitlRequestId | token id/kind/scopes/owner/project | accessible run/project and HITL kind, actor conversion, audit scope | optionId, response, confidence only |
| Scratch GET | runId | active user and existing assistant-owner gate | run/project, scratch, pending HITL | none |
| Ext HITL lists | runId or existing inbox scope query | token/owner and existing read scope | project membership, visible requests | none newly introduced |

Read DTOs contain existing project/HITL content plus the operator's public
answer. Reuse their current read/auth gates; do not expand access. Preserve
permission schema redaction. Ext absence hiding, UNAUTHORIZED→403,
NEEDS_INPUT→422 and transient PRECONDITION→409 stay intact. Existing
insufficient-scope `requiredScope` details are not subject to the new service
refusal allow-list. No body identifier becomes a filesystem/session locator.

### D7. Delivery invariants inherited unchanged

| Existing outcome | Wire | Stored answer / respondedAt | P0-4 presentation |
| --- | --- | --- | --- |
| First eligible answer, delivered | 200 | saved / set after delivery | Complete and refresh. |
| Same-payload replay already delivered | existing 200 where admitted | unchanged | Complete; no second delivery. |
| Claimed, same payload, delivery/resume pending | 202 with existing state | saved / NULL | Read-only saved state. |
| Another answer or invalid run phase | existing 409 | do not overwrite winner | Localized reason, refresh authoritative DTO. |
| Fenced delivery | 409 CONFLICT | existing owner keeps authority | Reason and read-only stored answer when returned. |
| Checkpointed host session within grace | host 410 → web 202 | existing private intent cleanup, park/resume | Delivering on resume; never new Failed write. |
| Host unavailable/parking/post-grace | 503 | saved / NULL | Answer saved; retry same payload if needed. |
| Actual terminal missing deferred | 410 | existing Failed flow / Crashed scratch; respondedAt set | Session-ended copy and next action; B6 deferred. |
| Browser transport failure | no reliable HTTP body | unknown to client | Cannot confirm delivery; reconcile, no saved claim. |

The existing claim transaction precedes delivery; respondedAt remains an
after-delivery or existing terminal marker. Do not move artifact writes,
assignment completion, audit writes, event emission, CAS, lock keys or driver
dispatch. Recovery remains the ADR-180 sweeper/driver path. No new state store
means no new migration, crash-recovery protocol or deployment cutover.

### D8. Exact OpenAPI composition and read contracts

In each spec add `HitlRespondReason` and `HitlRespondDetails` components;
details is an object with required reason, the nine-token enum, optional
causeCode with the bounded pattern, and additionalProperties=false. Keep
existing shared error schemas open for other operations. Add
`HitlRespondErrorBody` (web) / `ExtHitlRespondErrorBody` (external), composing
the respective shared error via allOf and refining only details to the new
component. Use these schemas on respond 409/410/503; details remains optional
for unchanged preconditions, CHECKPOINT failures and pre-claim exceptions.
Never add a second details property to MaisterErrorBody. Reference the named
respond detail schema in its existing description and in the operation.

Add explicit strict subcomponents/examples for the two known body-producing
arms: terminal HITL_TIMEOUT requires agent_session_ended; post-claim
EXECUTOR_UNAVAILABLE requires delivery_unavailable. Do not require these
reasons on every 410/503: the existing idle terminal CHECKPOINT body remains
`{code,message,terminal:true}`. Model terminal as an optional boolean where
present; retain the existing retryHint/top-level workspace reason fields.
Ext 401/403/404/422 keep their existing shared response refs and requiredScope
behavior. Update ext 202 prose/schema to include the actual existing state
values and the same checkpointed→202 explanation as web; do not promise that
a session has already spawned at the time of every 202.
Make ExtHitlRespondResponse require only ok, with optional runStatus; include
NeedsInput, NeedsInputIdle, Running and Done for the current external HITL
paths. Its state enum includes delivered and the existing pending states.
Use an ExtHitlRespondAccepted refinement for 202 requiring ok/state and the
documented pending-state enum. Validate the actual `{ok:true,state:delivered}`
and `{ok:true,state:delivery-in-progress}` bodies that omit runStatus, as well
as idle resume with runStatus. No service body is changed to satisfy a stale
schema, and no new run status is added to the application.

Required read-contract edits (exact surfaces, no inferred new endpoint):

| Public/RSC surface | Implementation | Spec location / new properties |
| --- | --- | --- |
| Project/global HITL cards | queries/hitl.ts HitlItem and portfolio.ts shared mapper | hitl.md; required answerState and storedResponse |
| Run page | queries/run.ts RunPendingHitl | hitl.md + flow-run.md, same properties; no invented REST run-detail DTO |
| Scratch GET /api/scratch-runs/{runId} | scratch route PendingHitlRow + dialog.ts | web ScratchPendingHitl under ScratchRunDetail.pendingHitl, same properties |
| GET /api/v1/ext/runs/{runId}/hitl | toExtHitlDTO in that route | ExtHitlRequestDTO, same public replay properties |
| GET /api/v1/ext/hitl | explicit mapper in web/app/api/v1/ext/hitl/route.ts | ExtHitlInboxItem adds answerState only; keep this discovery list minimal, obtain replay data through run-scoped HITL read |

For open rows storedResponse=null. For answer_stored it is a valid public
POST envelope or null for an invalid/non-replayable legacy answer; null does
not reopen the card. A lossless JSON-null form answer is `{response:null}`,
not a null envelope. Model storedResponse as nullable object with optional
optionId, response (OpenAPI 3.0 `{}` for JSON), and confidence (number 0..1),
additionalProperties=false; describe permission/structured alternatives and
validate them with the runtime discriminated schema. Presence of response
(including null) differs from absence. Required field presence, canonical
replay equality and open/stored relation are asserted through actual DTOs.
Do not model arbitrary form responses as object-only. Ext discovery examples
must include answerState and must not acquire the response envelope.

The canonical decisions count/list uses `getDecisionsQueue` and
`hitlDecisionsOf` (`queries/decisions.ts:325-353`). Do not replace it with a
new count query; keep actionability/project/relation filters. A stored answer
does not drop from the eligible HITL population merely because its controls
are read-only. Ext decisions remains its existing discovery projection and
does not gain a second replay payload.

### D9. Database and analytics freeze

Migration decision: **none**, verified against `schema.ts:6049-6152`.
response JSONB, responded_at, human_confidence and superseded_at already
contain the inputs. answerState and companions are SELECT projections only.
No changes to schema.ts, migrations SQL, meta/_journal.json, snapshots or DBML;
no backfill, trigger, index reservation or migration rollback is needed.
Audit their diff at completion and run the existing `db:erd --check` through
validate:docs. Do not generate an empty migration to satisfy a checklist.
The shared read predicate retains existing joins and batching; no per-card
query or data repair. If query evidence establishes an index is essential,
stop that expansion at a revised plan rather than silently creating a migration.

Improve existing `hitl.md`, do not create another HITL analytics document.
Its state machine continues to describe durable execution; add a separate
read-state table (open/stored/absent) and a sequence for
claim→POST outcome→render→refresh→identical retry→delivery→removal. Cover
failed refresh, replaced request, terminal feedback and authorization loss.
Cross-link scratch-runs.md and external-operations.md where their existing
HITL response descriptions would otherwise disagree; keep copy in the shared
catalog and the reason/action contract in hitl.md. Update existing screen
files/index references rather than adding duplicate card docs.

Phase-0 freeze means: each acceptance below has its normative spec, concrete
enforcement point and test owner; all contract examples and null semantics
agree; no unresolved replay-shape decision remains. Future findings that
change an accepted requirement update the spec and its test first, with an
explicit scope note. Never amend an acceptance merely to match a failing
implementation.

## Contract and documentation checklist

Freeze these before production code; mark new behavior Designed until verified.

| Changed surface | Canonical spec/doc | Required update |
| --- | --- | --- |
| Web respond errors / accepted states | `docs/api/web.openapi.yaml` | Refine existing MaisterErrorBody with HitlRespondErrorBody/Details per D8; preserve other details and top-level reason; 409/410/503 examples and scope; preserve all 202 states. |
| Ext respond / MCP public body | `docs/api/external/operations.openapi.yaml` | ExtHitlRespondErrorBody mirrors details; preserve requiredScope, other errors and CHECKPOINT 410; correct 202 prose and accepted state schema. |
| HITL pending read data | D8's exact web/ext components and `docs/system-analytics/hitl.md` | answerState and public replay companions on detailed reads; answerState only on discovery; null behavior, pending counts and removal. RSC props remain analytics/screen contracts. |
| Permission classification and replay | `docs/system-analytics/hitl.md` | Reason/action/status table; retry bullets; 503 paragraph; idempotency table; statement that delivery on resume is conditional on a resume, not a new automatic retry promise. |
| Terminal operator action | `docs/error-taxonomy.md` | HITL_TIMEOUT surface/action; document the scoped delivery_unavailable distinction and B6 limitation. |
| Inbox/board card | `docs/screens/inbox.md` | Read-only stored answer, chosen option, retry delivery, reason and mono diagnostic, count unchanged until delivery. |
| Flow and scratch pages | `docs/screens/runs/flow-run.md`, `docs/screens/runs/scratch-run.md` | Answered state, immediate 202 feedback, terminal action and explicit B6 limitation. |
| MCP tool semantics | `docs/system-analytics/external-operations.md`, `mcp/src/tools.ts` TOOL_SPECS.hitl_respond | Upstream error JSON preserved in tool content, code/details.reason consumers; no message parsing. |
| Scratch refresh/feedback | `docs/system-analytics/scratch-runs.md` | Link the canonical HITL read-state/feedback contract; remove conflicting local generic-only claims, without duplicating the reason table. |
| ADR-180 operator surface | `docs/decisions/adr-180.md` | Dated “as-built operator surface” amendment, initially Designed; references to contracts, D1–D6, T1 deferral and crash-grace follow-up. No new ADR number. |

Preserve docs R5 structure, ≤12 testable Expectations with enforcement points,
R7 single sources and screen index links. No schema/ERD or AsyncAPI change is
needed: neither durable state nor events change.

## Requirements and acceptance traceability

An acceptance is complete only when the test executes against its production
consumer and its intentional broken variant fails at the named assertion.
T1 is the sole selected deferral, not an implementation pass.

| ID / requirement | Normative source | Enforcement / tasks | Primary acceptance evidence |
| --- | --- | --- | --- |
| AC1 — reasons reach both REST routes and MCP | D1/D6/D8; web/ext respond contracts | serializer, service throw sites, MCP call result; 4–6 | W1 real permission_resume_in_flight claim through web/ext; actual MCP JSON body equality; foreign detail fields absent |
| AC2 — honest terminal/saved bodies | D1/D7; HITL reason table and 410/503 examples | post-claim service body arms; 4–5 | W2 terminal flow/scratch and 503 bodies; stored row confirmed; CHECKPOINT and pre-claim errors unchanged |
| AC3 — one bilingual reason map | D2; EN/RU catalogs + screen contract | resolver and callers; 8–9 | U1 all nine pairs in EN/RU, unknown/mismatched reason fallback, causeCode only as mono diagnostic; no server message/token rendered |
| AC4 — stored survives a fresh read | D3/D8; read schemas and hitl.md | SELECT projection and every mapper; 4/7 | U3 same committed row via board/global inbox/run/scratch/ext; fresh unmount+mount read-only; SQL NULL versus JSON null; private keys absent |
| AC5 — pending is immediate and cannot be answered twice | D4; screen contract | local request-scoped state before refresh/callback; 8/10–11 | U2 three pending 202 states and 503; stale props/late responses cannot restore choices; another request starts open |
| AC6 — retry means the same stored answer | D3/D4; replay table | public payload projection and existing service replay; 4/7/10–12 | U3 DOM POST equals public stored payload, DB idempotent branch returns 200/202; negative different-option 409; no lossy structured retry |
| AC7 — delivered row disappears without count drift | D3/D8; read-state table | canonical queries and existing respondedAt write; 4/7/12 | U3 pending count retained through Running resume, then row/count removed; project/relation/auth exclusions preserved |
| AC8 — scratch shows reasons and preserves terminal feedback | D2/D4; scratch screen/analytics | conversation error owner and panel; 8–11 | S1 POST 409/410/503 reason rendering; subsequent loadDetail/card removal does not erase terminal message |
| AC9 — ADR-180 arms preserve execution outcomes | D7; ADR-180 and hitl.md | unchanged drivers/sweep plus public body/DTO; 4/12 | R1 real supervisor/Postgres race/post-grace, exact same retry then delivery, no run.failed for that run |
| AC10 — existing contracts/auth remain valid | D6/D8; original ext shared responses | unchanged authorization/status mappings; 2/4–7 | existing positive/negative route cases incl. requiredScope, hidden 404 and user/token-kind gates; unknown details do not escape |
| AC11 — no durable-model or transition change | D5/D9; ADR amendment | plan scope and final diff; 1/14 | schema/migration/host/transition diff audit, existing lifecycle suites green, db:erd --check |
| AC12 — terminal run cause limitation recorded | D5; taxonomy/screen/ADR | explicit 5(b) record; 1/3/14 | T1 deferred B6, fresh run page not claimed fixed; transient refusal remains visible |

Mandatory read-state edge rows: SQL NULL→open; empty/false/zero/JSON null or
private-only non-null value→stored; respondedAt set→absent; an older stored
permission plus a new open permission on the same run→each retains its own
request identity. Empty/private-only/malformed permission data must not mint
an Allow choice. A former option absent from the current public options stays
read-only with a diagnostic, not a guessed label or payload.

## Incremental SDD → TDD execution protocol

For each behavior slice, use **RED → GREEN → refactor**, not a large batch of
untested implementation followed by Task 13. The task list is a dependency
map; test additions in tasks 4 and 8 are introduced just before their owning
implementation slice so unrelated intentional RED tests do not obscure it.

1. **Spec gate:** Phase 0 fixes operation/schema pointers, example bodies,
   existing-state outcomes and the AC id. Parser validation runs now; runtime
   schema/example parity runs once its executable contract exists in Phase 1.
2. **RED:** run the smallest owning test against existing behavior. Record
   test name, command, AC id, expected assertion failure and exit status.
   Missing modules, broken mocks, fixture seed failures and no-test discovery
   are infrastructure defects, not valid RED evidence.
3. **GREEN:** implement only that contract change, including obsolete assertion
   migrations in the same slice. Verify the target behavior and affected
   regressions, then proceed to the next slice. Never disable a required test.
4. **Refactor:** only after GREEN, remove duplicated mapping/projection code,
   simplify functions/types without changing public behavior, and rerun the
   owning tests plus lint/typecheck. No refactor is required when the smallest
   implementation already meets KISS/DRY/SOLID and repository conventions.
5. **Phase gate:** all planned tests added so far and the existing full relevant
   suites execute GREEN; record failures, unhandled errors and exit code, not
   just passing counts. No skipped required test or hidden quarantine.

Owning slices: W1/W2→5; MCP W1→6; DTO/replay U3→7; U1→9;
board/inbox U2→10; scratch S1/U2→11. R1 wire/DTO assertions are RED before
5/7 and GREEN before the Phase-1 checkpoint; Task 12 composes their already
verified output with UI expectations rather than inventing a late RED claim.
Task 13 audits migrations and falsifies the implemented seams; it is not the
first point where existing assertions are repaired.

## Tasks

### Phase 0 — freeze specifications

- [x] **Task 1: Freeze analytics and the ADR amendment.** Depends on none.
  Update `hitl.md` reason/read-state/retry/idempotency sections and
  `adr-180.md` using D1–D9, including the full refusal table, read-state
  sequence, B6 choice, zero-migration decision and crash-grace follow-up.
  Freeze D3's lossless form/human replay and non-replayable compatibility
  cases; update scratch/external analytics links. Logging: documentation only.
- [x] **Task 2: Freeze wire schemas and example payloads.** Depends on 1.
  Update D8's exact components in both OpenAPI files and external-operations
  MCP prose. Require public body equality through
  MCP, `additionalProperties: false` on respond-specific details, and preserve
  external requiredScope. Do not close the whole shared ExtErrorBody.details
  object in a way that removes other existing error contracts. Logging: specify
  reason-only structured details at respond boundaries, no answer content.
- [x] **Task 3: Freeze screen and bilingual copy acceptance.** Depends on 1–2.
  Update the three screen docs and taxonomy; freeze D2/D4 copy and keyboard,
  focus, aria-live, canAct and retry behavior. Document B6 as unimplemented.
  Logging: none in render paths. Exit: complete, internally consistent SDD,
  `pnpm validate:docs` and `pnpm validate:contracts` green. Distinguish document
  meta-schema validation here from W2's Phase-1 executable example/route-body
  validation; both are required before calling the contract qualified.

### Phase 1 — make wire and read models truthful before client changes

- [x] **Task 4: Add RED W1/W2/R1 and DTO-side U3.** Depends on 1–3.
  Extend the existing web respond route test, ext HITL route integration test,
  MCP dispatch/stdio tests and real Postgres board/inbox tests listed below.
  Drive a resume-owned claim through real service/route paths for W1, not only
  a fabricated JSON object. Assert both details presence and private-field
  absence, terminal/saved messages and status preservation. Extend the two
  real ADR-180 race/post-grace cases with the new body and DTO assertions now,
  so R1 becomes RED before production changes. Introduce these RED cases
  incrementally per the execution protocol. DTO U3 tests
  project/global/run/scratch reads, counts and removal. Record intended RED
  assertions; unrelated fixture/auth failures are not RED proof. Logging:
  capture safe code/reason/request-id evidence, never credentials.
- [x] **Task 5: Add public response contracts and route/service details.**
  Depends on 4. Create the small contract/serializer modules, label claim
  throws and terminal/delivery-unavailable bodies in `hitl.ts`, and apply the
  serializer in both respond routes. Add ext refusal logging locally (the
  inner catch currently has no reason log). Keep its mapper and auth wrapper.
  Logging: warn with runId, hitlRequestId, code, status, details.reason; service
  delivery logs use the same public reason and existing latency context.
  Acceptance: W1 web/ext and W2 green, no supervisor/transition diff.
- [x] **Task 6: Preserve errors through the complete MCP response.**
  Depends on 5. Update `mcp/src/rest.ts`, `tools.ts` dispatch result and
  `main.ts` hitl_respond failure rendering as required by D6; reuse existing
  MCP harness. Preserve JSON body equality and `isError:true` at the outer
  tool result, as well as success 202 states and existing auth behavior.
  Logging: tool/status/reason only. Acceptance: W1 real callTool evidence
  green; unrelated tool error tests unchanged.
- [x] **Task 7: Project stored answer state on every required read path.**
  Depends on 4–5. Add `hitl-answer-view.ts`; wire `queries/hitl.ts`,
  `queries/portfolio.ts`, `queries/run.ts`, scratch GET and explicit ext DTOs.
  Preserve existing permissions/redaction/specialized claims. Include read
  predicate/count parity for stored permission rows during resume. Update
  `RunPendingHitl`, `HitlItem`, `ScratchDetail` and affected fixture shapes,
  including D8's required public envelope. Prove lossless replay against the
  existing service before exposing a non-null storedResponse.
  Logging: none per-row; existing query errors remain explicit. Acceptance:
  DTO U3 green including SQL-null truth, nested private fields, project/global
  scope and post-respondedAt disappearance; client work can now safely refresh.

### Phase 2 — reason rendering and stored-answer interaction

- [x] **Task 8: Add RED U1/U2/S1 and replay interaction coverage.**
  Depends on 5–7. Use per-file `// @vitest-environment jsdom`, existing React
  DOM helpers, real EN/RU message catalogs and actual components. Test each
  table row, unknown reason/code, cause detail isolation, network ambiguity,
  three accepted 202 states, both inbox mounts and scratch conversation POST.
  U1 owns the full code/reason/locale table; scratch and inbox test their
  wiring with representative cases, not duplicate matrices. Add true fresh
  remount, terminal-feedback survival and read-only canAct=false coverage.
  Rerender stale same-request props and new request ids. Retry must POST the
  captured/read public payload exactly once; another choice cannot be sent.
  Logging: none in component tests except useful assertion diagnostics.
- [x] **Task 9: Implement the shared resolver and remove the dead map.**
  Depends on 8. Update `ui-error-message.ts`, `messages/en.json`,
  `messages/ru.json`, `dialog.ts` error helpers, and production consumers.
  Delete `hitl-actions.tsx` and migrate its stale-view test coverage to the
  live card. Update attempt timeout copy. Logging: no raw server payloads in
  browser logs. Acceptance: U1 green for both locales and unknown input;
  code/unknown-reason fallback remains localized. Scratch S1's POST acceptance
  belongs to Task 11, not this resolver-only slice.
- [x] **Task 10: Implement read-only states in board/inbox/run cards.**
  Depends on 7–9. Update `RunHitlResponse`, both `HitlPanel` mounts, every
  `web/app/(app)/runs/[runId]/layout.tsx` card mount and any actual production
  consumer found by import search. Set stored state before callback/refresh,
  preserve it through stale props, retain chosen label and immutable retry
  payload, honor canAct/busy and existing completed/rework paths. Logging:
  none on render; no automatic retry loop. Acceptance: U2/replay DOM tests
  green; no count decrement on pending 202/503.
- [x] **Task 11: Implement equivalent scratch state and error presentation.**
  Depends on 7–10. Update `scratch-conversation.tsx`,
  `scratch-permission-panel.tsx` and scratch DTO typing; local accepted state
  survives loadDetail, saved retries use the stored payload, terminal refusal
  remains visible outside the removed card. Check every `errorText` caller
  when changing its namespace contract. Logging: no answer content or host
  metadata. Acceptance: S1 plus scratch 202/reload/retry DOM tests green.

### Phase 3 — full delivery qualification and as-built verification

- [x] **Task 12: Qualify U3 replay and R1 with the existing real harness.**
  Depends on 5–11. Finish qualifying the R1 tests added in Task 4, in
  `permission-deadline.integration.test.ts`:
  race-window host checkpoint → web 202 → public stored DTO → delivery, and
  post-grace 503 → saved DTO → existing sweep → identical retry → resume.
  Assert no Failed state/event for either arm, and respondedAt/card removal
  after successful delivery. Feed the real public response into the exact
  shared UI resolver and assert its saved/delivering descriptor; U1/U2 own
  actual localized rendering and interactions in jsdom. Do not move the real
  supervisor harness into jsdom or introduce a second harness. T1 is recorded
  as deferred 5(b), explicitly excluded from the green implementation count.
  Logging: existing supervisor tail and assertion context only on failure.
- [ ] **Task 13: Audit migrated assertions and run falsification/regression gates.**
  Depends on 12. Confirm each owning slice already migrated its assertions;
  run the commands below, confirming
  runner inclusion. Temporarily undo each feature seam on the implementation
  branch, one at a time, prove the named test becomes RED, then restore only
  that mutation. No reset/checkout that can discard unrelated edits. Review
  every fix cycle against the locked boundaries. Logging: record command,
  revision, result and intended failure assertion; no secrets. All promised
  tests must execute; no passWithNoTests or skipped suite counts as evidence.
  The P0-4 owner suites and falsification checks are complete. The full web
  integration gate remains red in unrelated recovery fixtures, as recorded
  below; this task stays open rather than treating isolated passes as a full
  project pass.
- [ ] **Task 14: Close docs and report exact qualification.** Depends on 13.
  Mark verified operator surface Implemented in the amendment/analytics;
  retain explicit B6/crash-grace/A4/watchdog/P0-5 follow-ups. Run contracts,
  docs, lint/typecheck and smoke gates; inspect the final diff for forbidden
  state/host/schema changes. Logging: concise validation record and exact
  environmental blockers if any. Stop at this increment; do not implement
  follow-ups or publish remotely.
  The as-built docs and all static/smoke gates are complete; final qualification
  remains open with Task 13's full integration gate.

Each behavioral phase exits with its named targeted tests green, then the
existing full web unit and integration suites green, run sequentially. MCP
full suites are also required after its phase. A newly red existing assertion
must be classified as obsolete contract text or a broken invariant and fixed
accordingly. Environment-blocked execution is incomplete qualification, not
a product pass; do not quietly quarantine the required acceptance tests.

### Execution evidence (2026-09-23)

- Phase 0 contract and docs validators passed before implementation.
- Phase 1: web route/service unit 98/98; ext, portfolio and scratch real-DB
  integration 39/39; HITL service integration 15/15; ADR-180 real-supervisor
  deadline integration 10/10; MCP unit 259/259 and integration 6/6. The full
  web unit project passed 831 files / 8,593 tests with bounded workers.
- Phase 2: board, inbox, scratch, run and error resolver unit/DOM suites passed
  60 files / 565 tests; web typecheck and targeted ESLint passed.
- Phase 3 R1: `permission-deadline.integration.test.ts` passed 10/10 with a
  nonconditional 202 public-DTO assertion, delivered-row disappearance, and
  post-grace 503 identical retry/no-Failed assertions.
- Falsification on `404b468f`, one temporary mutation at a time, followed by
  source restoration: removing route `details` made W1 fail at the missing
  `permission_resume_in_flight`; disabling reason selection made U1 fail at
  per-code fallback; ignoring 202 made U2 fail with live Allow/Deny buttons;
  forcing the DTO projector to return `open` made real-Postgres U3 fail on the
  claimed row. The restored route/card owner tests passed 101/101. No
  mutation remains in the working tree.
- Final web unit passed 831 files / 8,601 tests. Web and MCP typechecks passed;
  MCP ESLint passed; web ESLint exited 0 with 26 warnings outside the changed
  P0-4 files. Contract validation passed 5/5, including both HITL respond
  examples; docs/ADR/link/index and ERD checks passed. MCP unit 259/259 and
  stdio integration 6/6 passed; supervisor permission roundtrip passed 14/14;
  authenticated board/inbox Playwright smoke passed 8/8.
- First complete web integration pass ran all 512 files: 510 files and 4,487
  tests passed, two tests failed. The external inbox exact-shape assertion
  omitted its newly documented `answerState`; it was corrected and reran 4/4.
  One unrelated flow prompt-owner `SIGKILL after_apply` case missed a 30-second
  fixture count under two workers; its isolated rerun passed 1/1 in 38 seconds
  without code changes.
- A second complete run with the corrected assertion and macOS sleep prevention
  (`caffeinate -dimsu pnpm exec vitest run --project integration --maxWorkers 2
  --minWorkers 1`) ran all 512 files: 511 files and 4,488 tests passed. Its
  sole test failure was pre-existing ADR-180 RED 14: the agent resume grant
  classified `result` rather than the test's expected `continue`. The same
  file passed 10/10 on a separate full-file run and failed 9/10 on another;
  RED 14 alone and RED 13+14 together passed. No production state-transition
  or supervisor change was made. Vitest also reported one unhandled Postgres
  `57P01` during cross-file teardown after the scratch transcript tests had
  passed; that file passed 8/8 when run alone.
- A one-worker sleep-protected complete run was stopped after its first,
  unrelated 58-test flow prompt-owner file failed a 30-second `skill_check`
  recovery matcher. The exact case then also failed in isolation with a
  projection transaction deadline. Earlier complete and isolated runs had
  passed this file/case. This is an unresolved full-suite regression gate,
  not a P0-4 acceptance pass. The P0-4 route, DTO, card, scratch, MCP,
  deadline 202/503, contract, docs, unit, and smoke gates above are green.

### Review-fix pass (2026-09-23)

- [x] A failed budget-breach claim remains replaceable on the board and in the
  expanded inbox card; the existing real-Postgres inbox projection exposes
  `claimStage: "failed"` (11/11 query tests green).
- [x] Board and scratch permission cards suppress Retry when the saved option
  no longer exists in the current choices.
- [x] Scratch shows the shared EN/RU reason copy with a monospaced prompt-owner
  `causeCode` diagnostic, and request-scoped feedback ignores old refusals and
  late POST completions after another request appears.
- [x] The focused board/inbox/scratch jsdom suite passed 53/53 after fixes;
  the full web unit suite passed 831 files / 8,609 tests before the final
  scratch request-order guard, then the affected focused suite re-passed.
  `validate:docs:all`, contracts 5/5, web/supervisor/MCP typechecks, MCP build,
  scoped ESLint and `git diff --check` passed.
- [ ] The complete web integration gate remains open under Task 13. A fresh
  real-supervisor deadline run passed 9/10: RED13's unchanged checkpoint grant
  asserted `continue` but observed `result`. In the isolated RED13+14 run,
  RED13 passed and RED14 failed with the same classification. The affected
  execution code and those assertions are identical to master; no P0-4 state
  transition or supervisor code changed. This is not recorded as a green
  qualification or repaired by weakening the ADR-180 assertion.

## Test placement, migration and falsification

| Gate | Existing file to extend / planned new file | Runner and evidence |
| --- | --- | --- |
| W1 web, W2 | `web/app/api/runs/[runId]/hitl/[hitlRequestId]/respond/__tests__/route.test.ts` | web unit; existing injected service/route fixtures; body/status/private-data assertions. |
| W1 ext | `web/app/api/v1/ext/runs/[runId]/hitl/__tests__/route.integration.test.ts` | web integration, real Postgres and real claim; retain 403/404/422/transient 409 coverage. |
| W1 MCP | `mcp/src/__tests__/tools.test.ts`, `mcp/src/__tests__/stdio.integration.test.ts` | MCP unit/integration; actual callTool content JSON equals upstream public body, not only dispatch output. Extend existing local HTTP fixture to serve 409/410/503 and 202 bodies. |
| W2 examples | new `web/lib/__tests__/hitl-response-contract.test.ts` | web unit; parse actual web/ext YAML using existing yaml, validate named examples and actual route bodies with the shared Zod contract schemas. Assert schema enum/required/pattern/closed-details parity and a missing-reason negative. Keep root validate:contracts as the independent document parser gate. |
| U1/U2 | `web/components/board/__tests__/hitl-response-stale-view.dom.test.ts`, new `hitl-response-stored.dom.test.ts` beside it | web unit/jsdom, .test.ts naming with createElement; use actual next-intl catalogs, not a mock that echoes keys. |
| Inbox U2 | `web/components/inbox/__tests__/hitl-panel.dom.test.ts` | web unit/jsdom; both card mounts, callback executes after immediate stored rendering. |
| U3 DTO + replay | `web/lib/queries/__tests__/board-hitl.integration.test.ts`, `portfolio-inbox.integration.test.ts` | web integration; extend board fixture to import getHitlInbox (the actual board HITL DTO) alongside getRunDetail. Read the same row through project/global projections; actually POST the public envelope, then query again. Preserve assertions that getBoardData has no inline HITL fields. |
| U3 external projection/count parity | `web/app/api/v1/ext/hitl/__tests__/route.integration.test.ts`, run-scoped ext HITL suite, `web/lib/queries/__tests__/decisions.integration.test.ts` | Existing integration fixtures: discovery exposes state only, detailed list exposes sanitized envelope, canonical project/global count retains stored eligible rows; no duplicate full lifecycle harness. |
| Scratch read/U3 | new `web/app/api/scratch-runs/[runId]/__tests__/route.integration.test.ts` | web integration; real committed scratch/HITL rows through the actual GET; use startMainPostgresTestDb and existing seed helpers. Existing route.test.ts needs fixture-shape migration only. |
| S1 | new `web/components/scratch/__tests__/scratch-hitl-response.dom.test.ts` | web unit/jsdom; conversation fetch path plus permission panel, localized 409/410/503, stored state and retry. |
| R1 | `web/lib/__tests__/permission-deadline.integration.test.ts` | web integration, existing real supervisor + Postgres + ProjectionWorker; preserve the supplied 10/10 baseline scenarios, add assertions/scenarios explicitly. |
| T1 | Task 1/3/14 B6 deferral record | No runtime pass claimed. Future B6 test must cover durable cause after a fresh terminal-run visit. |

Coverage boundaries keep the suite small:

- W1 web owns the full reason-serialization/allow-list matrix; ext owns the
  same real resume-owned claim plus its authorization/status boundary. MCP
  owns transport/body preservation for one 409, one 410, one 503 and one 202;
  do not repeat the full service scenario matrix inside MCP.
- W2 owns example/runtime-schema parity. Follow the existing YAML→Zod pattern
  in supervisor openapi-examples.test.ts using web's existing yaml/Zod deps;
  no supervisor edits, new validation package or homemade JSON-Schema engine.
  Compare actual OpenAPI component constraints to the exported contract and
  validate real route bodies. Do not test only a copied enum against itself.
- U1 owns all localized code/reason combinations and malformed/unknown input;
  inbox needs its two mounts and callback wiring, scratch needs representative
  409/410/503 plus its separate state lifecycle. Neither repeats U1's matrix.
- U3 owns DB derivation, public envelope equality, confidence=0, scalar/array
  preservation, redaction and post-delivery disappearance. A small pure
  projection table is justified only for JSON edge values; do not start a
  Postgres container solely to test a pure sanitizer.
- U2 owns rapid duplicate clicks, busy/auth-disabled controls, unknown 202,
  stale refresh, true remount and old-request completions. Do not infer a
  successful remount from rerendering an existing React root.
- R1 owns real host/sweep/driver behavior only. Reuse the existing same-file
  fixtures and per-run identities; no log-only proof or assertions on a global
  sweep counter. UI rendering remains U1/U2/S1's responsibility.

Unknown/malformed 2xx state must trigger localized reconciliation feedback,
not a success toast or a reopened card. Keep any already-proven stored state;
do not claim a new saved answer from an unrecognized body.

Existing expectation migrations, limited to behavior intentionally changed:

- Web respond test: extend exact 410/503 bodies and claim 409 expectations;
  keep same-payload/different-payload concurrency, state preservation,
  assignment and terminal-CAS assertions. `terminal:false` remains present.
- `web/lib/services/__tests__/hitl.test.ts`, `hitl.integration.test.ts`,
  `hitl-permission-ledger.integration.test.ts`: update body-message expectations
  if asserted; do not weaken delivery-command or owner assertions.
- `permission-deadline.integration.test.ts`: “supervisor unreachable/retry”
  response wording is obsolete; real post-grace retry behavior is still valid.
- `web/components/board/__tests__/run-hitl-response.test.ts` and
  `hitl-response-stale-view.dom.test.ts`: remove tests solely for dead
  HitlActions; preserve live stale-view semantics; replace generic-only and
  immediate-refresh-only expectations with reason/accepted-state assertions.
- `web/components/inbox/__tests__/hitl-panel.test.ts`, `hitl-card.test.ts`,
  `hitl-panel.dom.test.ts`, portfolio `inbox-panel.test.ts`: add required DTO
  fixture fields and preserve existing specialized assignment/review behavior.
- `web/components/scratch/__tests__/scratch-permission-panel.test.ts` and
  `web/lib/scratch-runs/__tests__/dialog.test.ts`: migrate generic-only failure
  expectations and open DTO fixtures; keep composer/lifecycle tests intact.
- Ext/MCP tests: extend errors for details and actual tool JSON; preserve
  insufficient-scope requiredScope and other tool transport behavior.
- Remaining typed HitlItem/RunPendingHitl/ScratchDetail fixture literals found
  by typecheck get explicit open/null values where they model open rows;
  stored fixtures use the actual projected values. Never make fields optional
  simply to keep stale fixtures compiling.

Required falsification, one isolated mutation at a time:

1. Remove DTO answerState derivation → real-Postgres U3 fails.
2. Remove web/ext detail serialization → W1 fails at the corresponding route;
   remove MCP preservation → actual callTool W1 fails independently.
3. Remove reason resolver lookup → U1 fails on distinct EN and RU visible copy.
4. Remove 202 stored handling → U2 fails immediately, including inbox callback.

## Validation commands and environment

Use installed Node 24 and pnpm dependencies; inspect the selected test DB lane
and the existing `startMainPostgresTestDb` configuration before execution.
Do not use a development DB or a concurrently running isolation lane. Check
test discovery with the installed Vitest CLI (`--help` then `list` if supported;
otherwise verbose run discovery) and the inspected `vitest.workspace.ts` globs.
Web unit includes `.test.ts` under components and app; integration includes
`lib/**/*.integration.test.ts` and `app/**/*.integration.test.ts`. A `.tsx`
test filename is not covered by those current globs.

Planning-time environment check: the current shell resolves Node 26.3.0 and
pnpm 11.3.0, outside the declared Node range. The optional Prettier invocation
triggered pnpm's dependency-install check; registry DNS failed with ENOTFOUND
and the install was interrupted. Select the supported Node 24 runtime and
prepare the locked dependencies before implementation validation. No product
test or contract gate is claimed from this planning run. Plan structure,
task numbering, required acceptance groups and canonical document paths were
checked locally; whitespace checking reported no errors.

Run each command separately. Representative focused commands from repo root:

```sh
pnpm --filter maister-web exec vitest run --project unit 'app/api/runs/[runId]/hitl/[hitlRequestId]/respond/__tests__/route.test.ts'
pnpm --filter maister-web exec vitest run --project unit lib/__tests__/hitl-response-contract.test.ts
pnpm --filter maister-web exec vitest run --project integration 'app/api/v1/ext/runs/[runId]/hitl/__tests__/route.integration.test.ts'
pnpm --filter maister-web exec vitest run --project integration lib/queries/__tests__/board-hitl.integration.test.ts lib/queries/__tests__/portfolio-inbox.integration.test.ts --maxWorkers=1 --minWorkers=1
pnpm --filter maister-web exec vitest run --project integration 'app/api/scratch-runs/[runId]/__tests__/route.integration.test.ts' 'app/api/v1/ext/hitl/__tests__/route.integration.test.ts' lib/queries/__tests__/decisions.integration.test.ts --maxWorkers=1 --minWorkers=1
pnpm --filter maister-web exec vitest run --project unit components/board/__tests__ components/inbox/__tests__ components/scratch/__tests__ lib/scratch-runs/__tests__/dialog.test.ts
pnpm --filter maister-web exec vitest run --project integration lib/__tests__/permission-deadline.integration.test.ts --maxWorkers=1 --minWorkers=1
pnpm --filter maister-web exec vitest run --project integration lib/services/__tests__/hitl --maxWorkers=1 --minWorkers=1
pnpm --filter @maister/supervisor exec vitest run --project integration src/__tests__/permission-roundtrip.integration.test.ts --maxWorkers=1 --minWorkers=1
pnpm --filter @maister/mcp test:unit
pnpm --filter @maister/mcp test:integration
pnpm --filter maister-web test:unit
pnpm --filter maister-web test:integration --maxWorkers=1 --minWorkers=1
pnpm --filter maister-web exec eslint .
pnpm --filter maister-web typecheck
pnpm --filter @maister/mcp exec eslint .
pnpm --filter @maister/mcp typecheck
pnpm validate:contracts
pnpm validate:docs
pnpm --filter maister-web test:e2e --project=authed e2e/portfolio-board.spec.ts e2e/inbox.spec.ts --workers=1
git --no-pager diff --check
```

The verified Playwright project is `authed` in `web/playwright.config.ts`.
`AUTHED_SPEC` is a literal regex and already includes
portfolio-board/inbox/admin specs; adding a file does not opt it into that
project. Interaction assertions belong in jsdom; preserve existing board/inbox
and admin smoke as smoke rather than adding another Playwright harness.

Full integration execution can be expensive; measure actual serial runtime
and preserve fixture lifecycle cleanup. No arbitrary timeout inflation,
parallel isolation slice, skipped required test or unexplained count delta.
If runtime/DB/supervisor prerequisites block a command, report the specific
prerequisite and remaining gate; this plan does not claim these tests ran.

## Commit plan

These are implementation checkpoints, not authorization to push or merge.

1. After tasks 1–3: `docs(hitl): define refusal reasons and stored-answer surface`.
2. After tasks 4–7 and wire/read gates green:
   `fix(hitl): preserve refusal details and expose stored answers`.
3. After tasks 8–11 and interaction gates green:
   `fix(hitl): render saved answers and localized delivery reasons`.
4. After tasks 12–14 and qualification green:
   `test(hitl): qualify operator surface across resume delivery arms`.

Record RED evidence before implementation, but commit coherent green batches.
Final docs describe current behavior and link canonical contracts; they are
not a duplicated implementation changelog.

## Rollback and remaining scope

This is additive wire/read data plus UI copy; older clients ignore the new
fields. Deploy server/read projection before or together with the client.
During a mixed-version transition, missing fields from an older server do not
prove a response was unsaved; preserve locally acknowledged stored state.
Rollback as a coherent application change (or UI first), never by rewriting
stored responses, clearing respondedAt or resetting runs. No data migration
or supervisor rollout is required. Rollback restores the old visibility bug;
it does not undo a delivered answer.

Explicit follow-ups, not implementation tasks in this plan:

- **B6 / T1:** durable run-level cause for every terminal path, including this
  terminal permission 410, consensus empty synthesis and fan-out death.
- **Crash-within-grace:** reach ADR-177 crash boundary rather than Failed.
- **A4:** reuse the map for scratch grace/recover status copy beyond this card.
- **ADR-180 watchdog:** MAISTER_RESUME_PROMPT_TIMEOUT_SECONDS remains separate.
- **P0-5 consensus** and the duplicated httpStatusForCode helpers remain separate.

Completion requires all selected gates, authoritative saved-state behavior on
every listed surface, zero private-key leaks and an unchanged state-transition
diff. It does not claim B6 or the crash-grace classification has been fixed.
