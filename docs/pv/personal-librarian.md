# Personal librarian — product requirements

> **Status: product scope agreed with the owner, 2026-09-26; implementation
> not started.** This is the implementation-planning input for the complete
> first release. UI placement and technical proposals are identified below;
> they still need a screen contract and the relevant ADRs before code.
> Source baseline: local `master` at `3c02c739`.
> This brief replaces the librarian direction (D1/D2/D5/D7, librarian-related
> F1/F2 and the mandatory initiative dependency) in
> [Team visibility and PO intake](team-visibility-and-po-intake.md).
> Other options in that research brief retain their own status.

## 1. User outcome and release boundary

A business requester or Product Owner works through **one enduring personal
conversation with the librarian**. The librarian understands the user's
accessible projects and team activity, helps formulate needs, creates and
updates tasks, requests technical clarification, sends tasks to triage or
execution, and returns outcomes to the same conversation.

The first release MUST close the entire loop:

**Discuss → agree a task statement → create/link tasks → clarify, triage or
launch → follow progress and decisions → explain the result.**

A read-only assistant, a task-writing assistant without launch, or a chat
whose questions must be manually copied to teammates does not satisfy this
scope. Implementation increments may be dependency-ordered; they are not
separate definitions of product completion.

The user should not need to choose a project, Flow, runner or branch before
describing a need. The librarian discovers valid choices and uses established
defaults; it asks when missing information materially affects the requested
action. It exposes technical details when they help the user decide.

## 2. Agreed product decisions

- **LIB-01 — One conversation:** each user has one personal librarian
  conversation per platform instance. No chat list, topic creation workflow,
  shared room or mandatory initiative entity is introduced. Independent
  exploratory conversations remain scratch runs.
- **LIB-02 — User authority:** the librarian acts on behalf of the current
  user, with that user's current project access and action permissions. Being
  an instance-level assistant does not grant instance-wide data access.
- **LIB-03 — Tasks own work:** accepted statements, clarification requests,
  triage, execution and work status belong to tasks and existing execution
  domains. The conversation is their source and an interface to them.
- **LIB-04 — Complete first release:** reading, task creation/update,
  human clarification, triage, launch and outcome follow-up are all required.
- **LIB-05 — Internal MCP:** platform reads and actions use the MAIster MCP
  facade and its authorized domain operations. The model gets no direct DB,
  repository shell or generic HTTP escape hatch for platform actions.
- **LIB-06 — Durable context:** conversation history, personal memory and
  context boundaries are platform-owned durable records, independent of an
  ACP session, browser tab, runner or model.

## 3. Primary user journeys

| Journey | Required outcome |
| --- | --- |
| Understand work | “Are we already doing anything about invoice payments?” returns relevant accessible tasks, status, blockers and source links; incomplete coverage is explicit. |
| Formulate a need | “Customers need invoice payments” leads to bounded clarification, a duplicate check, proposed project ownership and an actionable statement. A new statement can reference several projects. |
| Create work | “Create these two tasks” creates exactly those tasks with the agreed statement and source references; creation alone does not arm execution. |
| Ask a teammate | “Ask Anna which closing documents are required” creates an addressed, task-bound clarification and an inbox item; the response is visible on the task and returns to the user's librarian. |
| Route work | “Send the first to triage; launch the second” routes each task independently and reports its actual outcome. |
| Resume discussion | “What did Anna answer?” retrieves the relevant pending request, displays her attributed answer and proposes any statement change. Ambiguous references are clarified before an effect. |
| Manage existing work | “Stop this run”, “recover it”, or “send this correction” uses the existing eligibility and ownership rules and reports accepted, queued, refused or completed distinctly. |
| Receive a result | The librarian explains what was produced, what passed, what remains open and what the user can do next, linking the canonical task/run/evidence. A merge is not evidence of deployment or business acceptance. |
| Start a new subject | “Reset context” starts a fresh context segment within the same personal conversation, with explicit effects described in §8. |

## 4. Interaction surface — recommended first-release design

**Recommendation: a persistent top-navigation entry that opens a right-side
panel.** Proposed copy: **Librarian / Библиотекарь**. This placement is a
design recommendation, not an already accepted screen ADR.

The entry exists throughout the authenticated application. Desktop shows an
icon and label where space permits; compact layouts use an accessible icon.
The indicator distinguishes a running response, unread results and an action
required from this user. It does not invent a competing global inbox count.

The desktop panel opens beside the current screen when sufficient width is
available. On smaller widths it uses a modal sheet; on mobile it occupies the
available screen. The same conversation supports an expanded reading mode
for longer statements, without creating another conversation or navigation
hierarchy. Initial width and responsive breakpoints are settled by the screen
contract using the existing shell and workbench layouts.

The top-nav entry is preferred over a permanently floating bottom-corner
window: task actions, editors, transcripts and the status bar already use
that area. Avoid overlapping two active assistant composers in Studio or a
scratch screen; each must keep an explicit identity and focus owner. The
librarian can still open from those routes, but never absorbs their history.

Required panel behavior:

- Route navigation, collapse and reopen preserve the conversation, draft and
  scroll position. Collapse does not cancel a server-side turn or launched
  work. A reload restores persisted messages and pending operations.
- A visible subject chip shows **General / Общий вопрос** or the selected
  task(s). Current-page context can be attached explicitly; merely visiting
  another route does not retarget a pending command or confirmation.
- Message cards show statements, proposed changes, clarification requests,
  task chips and actual operation receipts. Links open the existing owning
  screen while the conversation remains available.
- A compact **Needs attention / Требует внимания** and **Related work /
  Связанные задачи** area lets the user return to work without scrolling the
  entire transcript. Task states are live domain reads, not copied chat text.
- The composer supports Send, Stop current response, Reset context and Memory.
  Stop affects the librarian turn; stopping a launched task run is a separate
  named action. Disabled controls explain their concrete reason.
- Opening places focus predictably; closing restores it to the invoker.
  Keyboard navigation, screen-reader names, dialog focus containment where
  appropriate, EN/RU copy and a narrow 390px viewport are acceptance targets.
  Do not reuse Cmd/Ctrl+K: it already invokes scratch launch.
- Never scroll a reader away from older messages when a response arrives;
  show a jump-to-latest affordance. Collapsed-chat notifications are bounded
  and use the existing notification policy and user preferences.

## 5. Capability scope and current MCP gaps

Existing tool names below are verified in [`mcp/src/tools.ts`](../../mcp/src/tools.ts).
“Add/extend” denotes required first-release work, not an existing tool promise.
Every added operation needs an explicit schema, authorization mapping, audit
contract and real domain integration. Do not infer parity from a tool name.

| User capability | Existing substrate | Required completion |
| --- | --- | --- |
| Discover accessible projects and what they do | User-scoped project/portfolio readers; `task_list`, `task_get`, `flow_list`, `runner_list` | Add authorized project discovery and a compact directory with purpose, routing facts and source freshness. Support bounded pagination/search rather than silently reasoning from the first page. |
| Read team progress and personal decisions | `activity_pulse`, `run_get`, `run_activity`, `readiness_get`, `hitl_list`, `hitl_inbox`; ext decisions route; Work/Activity readers | Expose the required cross-project read surfaces through MCP. The personal decision queue must use the caller's human authority. Distinguish a known Run from a query spanning visible projects. |
| Read project knowledge | `memory_recall` and existing project source readers | Preserve project-level access and Brain enablement; provide source links. Missing Brain is a visible lack of that source, not a failure of ordinary task reading. Personal memory uses a separate store. |
| Create/update statements and tasks | `task_create`, `task_update` | Add typed statement/provenance support and operation idempotence. `task_update` currently exposes title/prompt only; handle accepted revision conflicts explicitly. |
| Read/write comments and task relations | `comment_list`, `comment_create`, `relation_list`, `relation_add`, `relation_remove` | Bind publication to the requested task and audience, retain author attribution, and apply current relation constraints. A discussion reference alone is not a task dependency. |
| Request and consume technical clarification | `ask_human`, agent-question service, HITL/inbox and assignments | Existing `ask_human` requires a currently Running task-bound agent token. Add user-authorized task clarification before execution, with an addressed recipient and return linkage (§7). |
| Send to triage and configure launch | `triage_set`, existing Send to triage and launch-configuration domain paths | Expose invoking/reinvoking the configured triager, not only writing its verdict. Reuse persisted configuration validation. Preserve an explicit user choice about subsequent automatic launch. |
| Launch and follow work | `run_launch`, `run_get`, `run_activity`, `readiness_get` | Reuse task admission, dependencies, trust, runner readiness, budget and concurrency rules. Return an actual Run reference and distinguish Pending from Running. |
| Continue or stop work | `run_cancel`, `run_recover`, `run_discard`, `run_rework`, `run_sync`, `run_reopen`; `run_message` for bound children | Verify authority and eligibility per operation. `run_message` is not a generic operator message API: add the user-authorized message/continuation seam where needed instead of impersonating a coordinator. |
| Review and answer human decisions | `hitl_respond`, `run_promote`, existing review surfaces | Present the actual question or reviewed change, preserve exact human intent, stored-answer retry and target-drift guards. Human-only decisions require the real user's action; the model cannot manufacture approval. |
| Remember, retrieve, reset and forget | Durable execution/history mechanisms; per-agent memory is project-scoped | Add the personal records, retrieval rules and reset semantics in §8. Existing `agent_memory_write` is not personal librarian memory. |

This is a business-work interface over the existing platform. Infrastructure
administration, credential management, package/Flow authoring, arbitrary code
execution and a second Git management UI are not part of this release.
Existing specialized screens remain reachable. This boundary does not defer
any of the task/clarification/triage/launch/follow-up capabilities above.

## 6. Authorization, intent and effects

**LIB-07 — Identity and current permission.** Derive the owner from the
authenticated server session, never a model argument or client-supplied user
ID. Effective authority is the intersection of the user's current permission,
the operation's declared scope, librarian capability policy and applicable
object-state preconditions. Check it again at each tool operation and before
deferred effects. Revocation, account deactivation and project membership
changes apply to queued work as well as new requests.

Global personal tokens are an existing authorization precedent, but the user
must not create or paste a long-lived API token to use the librarian.
Implementation must supply short-lived, server-issued delegated authority,
bound to the owner and the specific turn/operation with auditable purpose.
The exact token representation requires a design decision. Never issue an
admin/service token for convenience or widen `AGENT_TOKEN_SCOPES` for all
platform agents. Keep the facade's per-request HTTP/per-process stdio identity
isolation; never reuse one user's credential or ACP state for another.

Reads, snippets, citations, source chips, memory recall, history retrieval and
counts all enforce visibility. Audit attribution identifies the human owner,
the librarian executor and the originating message/operation. Ordinary
project members cannot read the owner's personal conversation or memory;
any administrative inspection capability must be separately explicit and
audited, not implied by an agent-management role.

**LIB-08 — Intent.** Answering a question or proposing a task does not create
work. An explicit instruction such as “create these and launch the first” is
authorization for the resolved operations; do not add a redundant approval
round. Ask when the object, scope or material consequence is ambiguous, or
when the existing platform action requires human confirmation. Bind each
confirmation to exact objects and the reviewed revision; a stale card cannot
approve newly changed content. Retrieved text and teammate replies are data,
not new authority to execute instructions for the owner.

**LIB-09 — Observable effects.** Persist requested operations and their
idempotency identity before issuing effects. A lost response means pending
reconciliation until the domain outcome is known, not an invitation to repeat
a create, comment, question or launch. Repeated submission returns the same
result. A changed payload under the same identity is a conflict.

For a batch, show per-item results and dependencies. Already created tasks
remain linked if another item fails; retry only unresolved items. Record
created-but-not-launched work accurately. “Create” must not arm a project's
automatic launch policy; triage-only and triage-then-launch intent must be
explicitly preserved through the existing automation paths.

## 7. Tasks, source references and human clarification

**LIB-10 — Statement and provenance.** The agreed statement contains context,
goal, acceptance criteria, constraints/out-of-scope, links and open questions.
The task receives a self-contained accepted version. Its executor must not
need to read a private conversation to understand the assignment.

Maintain many-to-many links between conversations and tasks. Each link records
its meaning (`created_from`, `refined_in`, `mentioned`), stable message/range
references and the accepted statement revision where applicable. Published
task content and selected source excerpts follow task visibility; the full
conversation retains personal visibility. Sharing an excerpt is an explicit
publication, not an automatic access grant to the original transcript.

Task chips show the existing task key and current state and navigate directly
to the task. An authorized source link opens the exact historical messages;
an inaccessible/deleted source has an explicit unavailable state. Deleting or
resetting a conversation cannot cascade-delete tasks or invalidate their
self-contained accepted statements. A source excerpt that was intentionally
published remains task content under the task's lifecycle.

After creation, new discussion can propose a statement revision. Re-read the
current task revision before applying it; require reconciliation on concurrent
human edits. For already running work, use the current continuation/rework
policy and show whether the instruction was queued, delivered or requires a
new reviewed plan. Never silently rewrite the executing requirement snapshot.

**LIB-11 — Pre-execution clarification.** A clarification belongs to a task
and can exist without a work Run. It includes the requester, recipient,
question, reason, answer format, blocking/nonblocking purpose and source
message. The recipient must be eligible to see the task. Reuse the human inbox
and task detail; do not create a dummy execution Run merely to address someone.

The initial lifecycle is open → answered or cancelled, with a durable answer
and source attribution. Define correction/supersession in implementation
contracts rather than overwriting an answer already consumed. A blocking
clarification holds launch but does not require a new persisted task status.
The owner can explicitly resolve/cancel the hold under domain permissions.

The answer becomes visible on the task and in the requester's personal
conversation. It may update the proposed statement; it does not itself approve
a scope change or launch work. If the requester lost access, do not publish
the answer into that user's conversation. Recipient deactivation, task
abandonment and owner cancellation produce visible outcomes, not endless
unaddressable waits. The request stays actionable when the librarian ACP
session is idle or gone.

## 8. History, memory and reset

**LIB-12 — Separate durable records.** Logical records below are requirements,
not preselected table names. Use stable IDs and versioned writes; resolve the
physical schema and retention policy before implementation.

| Record | Ownership and role |
| --- | --- |
| Personal conversation | Unique within `(instance, user)`; message history and its read cursor. |
| Message/turn | Authenticated author, sequence, timestamp, segment, response/effect state and source links; independent of a single ACP process. |
| Context segment | Monotonic boundary inside the same conversation; bounds automatic conversational recall and pending conversational work. |
| Personal memory item | Owner, kind, content, scope, source references, explicit/inferred origin, validity/expiry and revision. Preferences are distinct from temporary goals and pending commitments. |
| Segment summary | A derived, versioned summary of named message IDs. It records accepted decisions, proposals and uncertainty separately and can be rebuilt or invalidated. |
| Context snapshot | The bounded messages, memory revisions, source identities and current-object revisions actually selected for a turn, for reproducibility and diagnosis. |
| Task source/operation link | Stable origin and effect/result identity; task status remains owned by the task/run domain. |

**LIB-13 — Retrieval.** Build bounded context from the active segment, relevant
personal memory and freshly authorized platform reads. A task's old chat
status is not evidence of its current status. Store source provenance and
authorization scope on project-derived memory/summaries; re-check access on
every use. Drop or rederive a mixed-source summary when one input is no longer
accessible. The agent must not repeat previously visible restricted facts
from retained ACP context after access changes; rebuild that context before
another turn. Historical rendering must likewise mask access-bound derived
content after revocation while preserving the owner's own messages and honest
unavailable markers. Export/search must apply the same policy.

Automatic summaries support conversation continuity. Cross-segment personal
memory is written on explicit “remember” intent or acceptance of a visible
suggestion. An inferred preference is not silently promoted to an instruction.
The user can inspect, edit and forget records, and see why a remembered fact
was used. Project Brain and a platform agent's per-project `memory.md` are
separate from this store; personal dialogue is not automatically written there.

**LIB-14 — Reset has explicit, distinct meanings.**

| Control | Required effect |
| --- | --- |
| **Reset context / Сбросить контекст** | Start a new segment in the same conversation, clear the active subject and unaccepted conversational proposals, and rebuild ACP context. Preserve history, explicit personal memory and existing tasks/clarification requests. The UI states those effects. |
| **Forget a memory / Забыть запись** | Remove the selected personal record from future context and its derived retrieval entries; prevent automatic recreation from older summaries/history. Explicitly remembering it again is a new user action. |
| **Clear personal history / Удалить историю** | A separate destructive action with an explicit scope preview: messages, summaries, indexes and source-link consequences. It is not the normal context-reset control. Published task statements and required effect audit records retain their owning lifecycle. |

After a normal reset, pre-reset messages and segment summaries are excluded
from automatic recall, including through task source links. “Find our previous
discussion about X” explicitly permits bounded retrieval from older history;
the response labels that use. Personal memory remains available and can be
disabled separately for the next segment. Do not create a second chat.

Reset is a server-side barrier. A reset request first fences further effects
from the old turn and resolves admitted operations; the UI shows progress
until their outcomes are known, then acknowledges the new segment. No queued
old conversational instruction runs after that acknowledgement. An already
launched task or open clarification continues independently. Its eventual
result can appear as a bounded task update, but cannot reload the old dialogue
or resurrect an unaccepted launch proposal. Late summarizers and memory
writers must respect segment/revision and deletion fences.

## 9. Runtime, liveness and recovery

**LIB-15 — Durable execution.** A persistent conversation does not require an
always-running ACP process. Reuse the supervisor, execution-host command
ledger, durable prompt ownership and continuation mechanisms. Support
workspace-free librarian turns without inventing a repository/project solely
to host the conversation. Specify how a librarian turn is represented in
the Run/owner system before implementation; never hide it inside a browser
request handler or an unowned background promise.

Messages are accepted durably with visible delivery state. Serialize effectful
turns within one user's conversation; independent users do not share a global
conversation lock. Repeated requests from two tabs deduplicate; the same user
sees one ordered history on both. New input while busy is durably queued with
its author and subject, and can be withdrawn before admission. A stop or reset
cannot erase the evidence needed to reconcile an already-issued operation.

Browser navigation/disconnection does not abandon accepted work. Restart or
adapter loss resumes/reconciles from the durable owner and reports the actual
outcome. Closing the panel releases no task permissions and spends no extra
tokens by itself. Idle conversations occupy no permanently reserved execution
slot. Configure finite turn/context/token budgets and per-user fairness under
the platform cap; expose exhaustion and missing runner configuration as
actionable states. Do not hardcode a provider/model or silently switch one.

**LIB-16 — Follow-up.** Task and clarification events produce deduplicated,
source-linked updates for the owning conversation using existing durable
event/notification mechanisms. Long operations return acceptance promptly;
completion is delivered later. Periodic unsolicited model-generated digests
are not required. Updates preserve user notification preferences and current
access. A failed delivery remains observable and retryable without repeating
the underlying business effect.

## 10. Acceptance scenarios for the complete first release

These are required scenario definitions, not claims of existing tests. The
implementation plan must name the enforcing contracts and real tests. Prefer
integration/E2E over mocks and avoid duplicating the same assertion in every
layer. Include an actual ACP/internal-MCP round trip and a small live-adapter
qualification for the user journeys; deterministic infrastructure tests alone
do not establish the librarian's ability to formulate useful work.

| ID | Scenario and pass condition | Requirements |
| --- | --- | --- |
| L-01 | From Desk, a PO asks about several projects, inspects sources, navigates to a task and returns to the same draft/history. The mobile equivalent has no horizontal overflow or hidden Send control. | LIB-01, LIB-02, §4 |
| L-02 | An ambiguous business need becomes two accepted tasks in different authorized projects, each with a usable statement, source reference and task chip. An existing duplicate is offered for linking instead of silent duplication. | LIB-03, LIB-04, LIB-10 |
| L-03 | “Create only” creates no execution; “create and launch” performs both without a redundant confirmation when fully specified. Triage-only does not arm auto-launch. | LIB-04, LIB-08, LIB-09 |
| L-04 | The owner asks a named teammate before execution; the teammate answers in the task/inbox; the answer reaches the original conversation after a browser/server restart. The blocking hold and any statement revision are resolved explicitly. | LIB-11, LIB-15, LIB-16 |
| L-05 | A viewer can read allowed work but cannot create/launch. An unrelated member cannot enumerate a project through search, counts, history, citations or memory. A global admin still does not expose another user's personal dialogue through librarian retrieval. | LIB-02, LIB-07, LIB-13 |
| L-06 | Revoke membership or deactivate the owner between proposal and execution. No new unauthorized effect occurs; old ACP context, cached snippets and mixed summaries cannot re-expose revoked data. | LIB-07, LIB-13, LIB-15 |
| L-07 | Lose the response after task creation, question publication or launch. Retry, restart and two-tab resubmission produce one effect and a recoverable receipt. A partially successful batch identifies each item. | LIB-09, LIB-15 |
| L-08 | Concurrent human edits invalidate a stale statement/approval. A teammate answer or retrieved instruction cannot approve an action on behalf of the owner. | LIB-08, LIB-10, LIB-11 |
| L-09 | A normal reset preserves tasks and personal memory but excludes old conversational context. An in-flight effect settles before reset acknowledgement; late callbacks do not issue another effect or inject old context. | LIB-06, LIB-12, LIB-14, LIB-15 |
| L-10 | Forgetting a memory removes it from recall and derived indexes; a delayed summarizer cannot recreate it. Clearing private history leaves already published task statements usable and source links honestly unavailable. | LIB-10, LIB-13, LIB-14 |
| L-11 | Recover/cancel/clarify/promote an existing work item only through its normal domain guards. The actual user's human-only response remains distinguishable from an agent suggestion. No direct DB/shell action bypasses MCP. | LIB-05, LIB-07, LIB-08 |
| L-12 | A result arrives while the panel is closed; reopen shows one update and current task state. It distinguishes creation, triage, queue, execution, merge and unknown deployment instead of claiming an unsupported success. | LIB-03, LIB-09, LIB-16 |

## 11. Implementation planning handoff

Keep one complete release scope. Sequence the work as follows:

1. **Contracts and screen design:** user-delegated authority, MCP capability
   coverage, conversation/segment/operation ownership, clarification-before-run,
   source sharing and deletion/retention rules. Add the normative ADR/API/schema
   and screen artifacts; map L-01..12 to enforcing tests. Select runtime
   placement, runner configuration and finite budgets. Confirm panel layout on
   Desk, task detail, workbench, Studio and narrow screens.
2. **Durable conversation and MCP identity:** one conversation per user,
   bounded context, scoped discovery/read tools, effect admission and receipts,
   restart/cancellation behavior. This is infrastructure, not a release exit.
3. **Complete work cycle:** statement/provenance, task creation/update,
   clarification, triage, launch, existing-work actions and result delivery.
4. **Memory and context controls:** versioned memory/summaries, retrieval,
   reset barrier, forgetting, history/source retention and multi-tab behavior.
   Their ownership/fencing contracts are established in step 1, not appended
   after runtime implementation.
5. **End-to-end qualification and documentation:** all L-01..12, representative
   real PO scenarios, permission revocation and process-death controls,
   EN/RU operator documentation and the existing validation gates.

Additive rollout is per-instance enabled/disabled with runner readiness shown
to an admin. Disabling stops admission and reconciles accepted effects; it
does not delete tasks, sources or personal history. A rollback must preserve
created work and audit records. Resolve exact retention periods, history
deletion eligibility, budget defaults and the proposed UI placement during
technical planning; none may be replaced by an unbounded implicit default.

## 12. Current implementation evidence and contract owners

| Concern | Existing owner / implementation |
| --- | --- |
| MCP tools, dispatch and transport identity | [`mcp/src/tools.ts`](../../mcp/src/tools.ts), [`mcp/src/auth.ts`](../../mcp/src/auth.ts), [external operations](../system-analytics/external-operations.md) |
| User permissions and operation scope mapping | [`web/lib/authz.ts`](../../web/lib/authz.ts), [`web/lib/tokens/ext-handler.ts`](../../web/lib/tokens/ext-handler.ts), [`web/types/token-scopes.ts`](../../web/types/token-scopes.ts) |
| Agent project-bound launch and restricted cross-project reach | [`web/lib/agents/launch.ts`](../../web/lib/agents/launch.ts), [`cross-project-reach.ts`](../../web/lib/agents/cross-project-reach.ts), [agents](../system-analytics/agents.md) |
| Tasks, triage and human questions | [tasks](../system-analytics/tasks.md), [triage](../system-analytics/triage.md), [`agent-question.ts`](../../web/lib/services/agent-question.ts), [`assignments/service.ts`](../../web/lib/assignments/service.ts) |
| Current mention semantics | [agent mentions](../system-analytics/agent-mentions.md) — summons a task-bound agent; an already active summon is suppressed, not a persistent personal conversation |
| Memory boundaries | [agent memory](../system-analytics/agent-memory.md), [Project Brain](../system-analytics/project-brain.md), [`memory-store.ts`](../../web/lib/agents/memory-store.ts) |
| Existing UI and attention | [`top-nav.tsx`](../../web/components/chrome/top-nav.tsx), [home navigation](../system-analytics/home-navigation.md), [attention](../system-analytics/attention.md), [notifications](../system-analytics/notifications.md) |
| Execution and continuation | [execution hosts](../system-analytics/execution-hosts.md), [run continuation](../system-analytics/run-continuation.md), [Stage A/B qualification plan](../../.ai-factory/plans/stage-ab-stabilization.md) |

The current agent launch, user-token and human-only HITL contracts do not yet
constitute a librarian identity. Any required extension must be explicit and
must preserve ordinary platform-agent constraints. Remaining runtime
qualification is relevant to testing the new owner, not a reason to downgrade
the requested first release to read-only.
