# Implementation Plan: @Agent Mentions in Task Comments — directed agent summons v1

Branch: feature/agent-mentions-task-comments
Created: 2026-07-26 · Refined: 2026-07-26 (improve pass — SDD + TDD)
Base: local main `76a3c8380` (fork point == main HEAD at plan time)

## Settings
- Testing: yes — **TDD, RED → GREEN → REFACTOR** (protocol in §TDD)
- Logging: standard (project pino conventions — INFO for summon decisions/outcomes, DEBUG for resolution counts, WARN for refusals; `LOG_LEVEL`-driven, matching `web/lib/social/comments.ts` / `web/lib/agents/triggers.ts`)
- Docs: yes — **SDD: spec freeze in Phase 0 before any code**

## Roadmap Linkage
Milestone: "none"
Rationale: Direct owner request extending the M31 social-board + M34 platform-agent substrate; the only open milestone (M45) is unrelated. `/aif-verify --strict` should WARN, not fail.

## Number reservations (from main HEAD `76a3c8380`)
- **ADR-151** — next free after `### ADR-150` (docs/decisions.md:12930).
- **Migration 0121** — `_journal.json` last entry `{ idx: 120, tag: "0120_living_captain_marvel" }`. Exactly ONE migration. TRIPLE: SQL + journal entry + `meta/0121_snapshot.json`; verify journal `when` is monotonic (non-monotonic `when` makes `db:migrate` silently skip).
- Renumber pass budgeted if another branch merges first (ADR header + migration triple + prose greps).

## Owner decisions (answered 2026-07-26)
| # | Question | Answer | Consequence |
|---|---|---|---|
| Q1 | Gate summonability on `triggers ∋ domain_event`, no new trigger kind? | **Yes** | No fan-out through definition zod / `AgentTriggerSource` / `runs.trigger_source` / context-block routing. §D2. |
| Q2 | `Review`/`Crashed` do NOT suppress a re-summon? | **Yes** | `MENTION_SUPPRESSION_STATUSES` excludes them. §D5. |
| Q3 | No activity row for a successful summon? | **Yes** | The run itself is the evidence; only *suppression* writes a row. §D5. |
| Q4 | `recommended.mention` in the definition format now or later? | **Now** | Adds the Studio frontmatter-editor fan-out. §D13. |
| Q5 | One chip style; "won't launch" as a footnote, not a grey chip? | **Yes** | §D9. |

---

# Part I — Specification (SDD)

Phase 0 freezes this section into `docs/`. **No implementation task may start before its governing spec section is frozen.** Where this plan and the frozen docs disagree, the docs win and this plan is corrected.

## Verified baseline (file:line, verified 2026-07-26 at `76a3c8380`)

**Corrections to the original request** (it was written pre-ADR-106):
1. Agent ids are **`<packageName>:<stem>`** (`qualifyAgentId`, web/lib/agents/definition.ts:99-101), not `<flowRefId>:<stem>`. `@core:triager` still reads naturally — `core` is a package name. Stem charset `/^[A-Za-z0-9._-]+$/` (definition.ts:86-95).
2. Bindings live in **`agent_schedules`** (schema.ts:976-1049), not "agentTriggerBindings". `triggerType` is **plain text + TS-only enum** (zero `pgEnum` in the schema) with **no CHECK on its values**; the two shape CHECKs (`agent_schedules_cron_shape_check`, `agent_schedules_event_shape_check`, migrations/0049:118-119) are `<>`-guarded ⇒ **`'mention'` needs NO agent_schedules migration**. Recorded so a reviewer does not "helpfully" add one.

**Substrate the design rests on:**
- Comment pipeline: one `db.transaction` in `addTaskComment` (comments.ts:49-217) — lookup → `expandMentions` → insert → activity → `emitDomainEvent` → subscriptions → inbox fanout. `actorType` already admits `'agent'`. **`expandMentions` has exactly one caller** (comments.ts:82) — verified; task title/description never expand mentions, so the non-goal holds structurally.
- Scanner: `segmentMarkdown`/`segmentInline` (mentions.ts:28-154) carve fenced blocks, inline code and `[...](...)` links; tokens are scanned in `text` segments only; resolved mentions become plain markdown links (mentions.ts:204); unresolved stay literal.
- Domain events: payload is free-form jsonb with **no runtime validation** (outbox.ts:58-87) ⇒ `mentionedAgentIds` is a migration-free widening. Established idiom: **omit the key when empty** (comments.ts:117-119).
- Dispatcher: singleton (scheduler budget 1, budgets.ts:47 + per-consumer CAS lease, dispatch.ts:162-190) ⇒ no concurrent processing; duplicates only from sequential crash-replay / lease expiry.
- Consumer: `agentTriggersConsumer` (triggers.ts:309-555) never rethrows launch failures ⇒ launch errors never retry the event; per-binding audit via `recordAgentScheduleOutcome`.
- Directed-launch template: clarification handoff (triggers.ts:330-421); eligibility SQL at :341-361; launch shape at :376-390.
- Idempotency: owned by `launchAgentRun` — pre-check (launch.ts:915-934) + `onConflictDoNothing` claim (launch.ts:1311-1317) backed by partial unique `runs_agent_trigger_event_uq (agent_id, trigger_event_id)` (schema.ts:1919-1921) ⇒ `{deduped:true}`.
- Budget: over-cap **queues** (`Pending` + `tryStartRun`; launch.ts:1265,1394; scheduler.ts:317-409; pool `agent` = `MAISTER_MAX_CONCURRENT_AGENTS`), outcome `queued`; never throws.
- Launch gates: `loadAgentContext` (launch.ts:310-395) — attached / link.enabled / agent.enabled / not quarantined / not destructive / `mode=session` / **`trigger_missing`**; trust via `resolveEffectiveAgentDefinition` (effective.ts:68-150, allow-list `trusted|trusted_by_policy`).
- Agent runs persist `task_id`, `agent_id`, `trigger_source`, `trigger_event_id`, `trigger_payload`, `agent_schedule_id` (launch.ts:1250-1291); index `runs_kind_task_idx (run_kind, task_id)` (schema.ts:1909).
- Prompt context: `taskCommentTriggerContextBlock` (launch.ts:1516-1600) already loads the comment + 6-comment tail for `task.comment_added` runs, keyed on `run.taskId` + `trigger_payload.payload.commentId`.
- `task_activity.event_kind` HAS a DB CHECK (schema.ts:5915-5918; 12 kinds at :5858-5875) ⇒ new kind needs migration 0121. `recordTaskActivity` (activity.ts:31-63) is the only writer. `comment_added` rows are filtered out of the timeline (task-detail.ts:78).
- Inbox: `fanoutToSubscribers` (inbox.ts:22-59) is the only `inbox_items` writer and is called explicitly; every `subscribe()` call site passes `type:'user'`; reads hard-filter `recipient_type='user'`.
- Ext/MCP: agent tokens already author as `('agent', agentId)` (verify.ts:171-186). Ext POST returns `{ comment }` @201 (route.ts:186). MCP `comment_create` spec at mcp/src/tools.ts:507-519 → ext endpoint (tools.ts:1143-1155); drift guard (mcp/src/__tests__/tool-contract.test.ts) mirrors **request** shape only (path/query/body props, types, enums, bounds) — responses are not compared. Facade ships from `mcp/dist` (`pnpm --filter @maister/mcp build`, enforced at launch.ts:3186).
- **Authorization** (verified): `commentTask` and `launchRun` are BOTH `member` (authz.ts:48,56) ⇒ no session-user privilege escalation. Binding edits require **`editSettings` = project `admin`** (agents/[agentId]/route.ts:108,156). Ext scope map (ext-handler.ts:85-105): `comments:create → commentTask`, `runs:launch → launchRun` are distinct scopes.
- **Studio fan-out hazard** (verified): `frontmatter-artifact-editor.tsx:540-569` rebuilds `recommended` from runner/cron/events ONLY and writes the whole object back ⇒ an unknown `recommended.mention` is **silently dropped** on any Studio edit. Read-only mirror at studio/agent-view.tsx:17-18,32-33,93-99.
- Docs rules: `docs/CLAUDE.md` R5 (Purpose / Domain entities / State machine / Process flows / Expectations / Edge cases / Linked artifacts), R5a (Expectations = one normative MUST/NEVER invariant per bullet), R6 (Implemented|Designed|Phase 2 tags), R7 (new domain doc → file under `system-analytics/` + glossary link). Screens docs exist per screen: `docs/screens/projects/project-board.md`, `docs/screens/projects/project-settings-agents.md`.
- UI precedents: no HeroUI Autocomplete anywhere — hand-rolled is the convention. Keyboard/ARIA model: `web/components/workbench/branch-select.tsx` (combobox/listbox/option, activeIndex, outside-pointerdown). Option-row visuals + candidate-props pattern: `web/components/social/relations-editor.tsx`. Renderer: `markdown-body.tsx` (react-markdown + remark-gfm, custom `a` override at :60-87, no `rehype-raw`).

## Domain model (frozen)

**Agent mention** — a resolved reference from a comment body to an agent id, within the task's project.
**Summonable(agent, project)** ≡ attachment exists ∧ `link.enabled` ∧ `agent.enabled` ∧ `quarantinedAt IS NULL` ∧ definition `triggers ∋ 'domain_event'` ∧ ∃ enabled `agent_schedules` row `(agentId, projectId, triggerType='mention')`.
**Summon** — a directed agent run caused by a mention, launched by the `agent_triggers` domain-event consumer.
**Suppressed summon** — a mention that resolved and was summonable but did not launch because the agent already has an active run on that task; recorded as `task_activity.agent_summon_suppressed`.

## Frozen decision table (per mentioned agent id, evaluated in order)

This table is the contract. Implementation branches follow it 1:1; the consumer test suite asserts one case per row.

| # | Condition | Write-time record | Consume-time outcome | Persisted evidence |
|---|---|---|---|---|
| 0 | Handle unresolved (unknown id, or ambiguous bare stem) | not a mention — body keeps literal text | n/a | none |
| 1 | `event.taskId` empty/null (defensive; comments are always task-scoped) | n/a | skip whole branch | WARN log |
| 2 | Resolved, `summonable=false` at write time | `mentionedAgents[].summonable=false` | re-checked; no binding → skip | comment footnote (from activity) |
| 3 | Self-mention (`event.actorType='agent' ∧ event.actorId=agentId`) | recorded as resolved | skip | DEBUG log only |
| 4 | No eligible + enabled mention binding at consume time | any | skip | none (write-time footnote already explains) |
| 5 | Active run on this task in `MENTION_SUPPRESSION_STATUSES` | `summonable=true` | **suppressed** | `task_activity.agent_summon_suppressed` + binding `lastOutcome='suppressed'` |
| 6 | Launch accepted, slot free | `summonable=true` | **launched** | `runs` row `Running` + binding `lastOutcome='launched'`, `lastRunId` |
| 7 | Launch accepted, agent pool at cap | `summonable=true` | **queued** | `runs` row `Pending` + `lastOutcome='queued'` |
| 8 | Redelivery of an already-claimed (agent, event) pair | — | **deduped** | no new run; `lastOutcome='deduped'` |
| 9 | Launch refused (trust / quarantine / `trigger_missing` / destructive / subagent / pin divergence) | `summonable=true` | **refused** | binding `lastOutcome='refused'` + `lastErrorCode` |
| 10 | Unexpected error | any | **failed** | binding `lastOutcome='failed'`, `lastErrorCode='CRASH'` |

`MENTION_SUPPRESSION_STATUSES = { Pending, Running, NeedsInput, NeedsInputIdle, HumanWorking, WaitingOnChildren }` — a **per-concern predicate** (deliberately NOT `ACTIVE_RUN_STATUSES`, a portfolio-display set). `Pending` is included so a queued summon isn't double-queued; `Review` and `Crashed` are excluded per Q2 — re-mentioning after a finished or dead attempt is the intended rework loop.

Ids in `mentionedAgentIds` are **all resolved ids**, including currently-non-summonable ones: the consumer is authoritative at consume time, so enabling a binding during the (sub-second) dispatch window still summons, and revoking one still refuses.

## Expectations (R5a — normative; each is an acceptance check)

1. A comment MUST expand a resolved agent mention to `[@<agentId>](/agents/<agentId>)` and MUST leave unresolved handles as literal text.
2. An agent mention inside a fenced block, inline code span, or an existing markdown link MUST NOT resolve, expand, or summon.
3. A bare `@<stem>` MUST resolve only when exactly one eligible candidate in the task's project has that stem; ambiguity MUST stay literal.
4. Mention resolution MUST be scoped to the task's project — a mention MUST NEVER resolve to an agent of another project.
5. The expanded link target MUST begin with `/` so no agent id is parsed as a URL scheme by the renderer's `urlTransform`.
6. `mentionedAgentIds` MUST be deduplicated and MUST be omitted from the event payload when empty.
7. The whole comment write (expansion, insert, activity, event, subscriptions, fanout) MUST remain a single transaction; a failure at any step MUST leave no partial writes.
8. Agent mentions MUST NEVER create `inbox_items` rows or `task_subscribers` rows; `recipient_type` MUST stay `'user'` across the feature.
9. At most one run MUST exist per `(agent, comment event)` pair, under any number of redeliveries.
10. A mention MUST NOT launch an agent that has no enabled mention binding on that project attachment.
11. An agent MUST NEVER summon itself through its own comment.
12. A mentioned agent with an active run on the same task MUST NOT be launched again and MUST record exactly one suppression row per `(task, agent, event)`, under any number of redeliveries.
13. Mention summons MUST be additive: generic `eventMatch.kinds` subscribers to `task.comment_added` MUST keep firing exactly as before, including the pre-existing lowest-`scheduleId`-wins single-owner rule.
14. A summon over the agent concurrency cap MUST queue as `Pending` and MUST NEVER be dropped or throw.
15. Mention-summon authority MUST be operator-granted: only a project `admin` (`editSettings`) can create or enable a mention binding.
16. The consumer MUST NEVER throw out of `handle`; every per-agent decision MUST be recorded as a binding outcome or a log line, and MUST NOT block other mentioned agents in the same event.
17. The comment POST response MUST report resolved agent mentions with their write-time summonability, so an API/MCP caller learns whether a summon was accepted without polling.
18. A run launched by a mention MUST carry `runs.task_id`, `runs.trigger_event_id`, and a `trigger_payload` whose shape keeps `taskCommentTriggerContextBlock` working unchanged.
19. Adding `'mention'` MUST NOT alter cron dispatch or generic event matching (both filter their `trigger_type` explicitly).
20. A mention of an agent on a terminal task (`Done`/`Abandoned`) is permitted by design; nothing in the summon path may branch on task status.

## Edge cases (each mapped to behavior / `MaisterError`)

| Edge case | Behavior |
|---|---|
| `user@example.com` in a comment | Not a mention — `@` must be at a word boundary. No error. |
| `@triager.` / `@triager,` (trailing punctuation) | Token ends at the last alphanumeric; `triager` resolves; punctuation stays outside the link. |
| Same agent mentioned twice in one body | Both occurrences expand; **one** id in the payload; one run. |
| Two different agents mentioned | Two runs (each its own `agent_id` against the same `trigger_event_id`); over-cap ones queue. |
| Agent detached/disabled between write and consume | Consumer skips silently; the comment keeps its chip (historical record). |
| Agent deleted after the comment | Chip still renders (body is immutable history); no summon. |
| Hand-typed `[@fake](/agents/fake)` in a comment | Renders as a chip but has **no** activity entry and **no** run — the authoritative signals are the activity payload and the run, never the chip. Documented, accepted (identical to today's hand-typed KEY-N links). |
| Expanded body exceeds the 10 000-char input cap | Pre-existing property of KEY-N expansion (validation is on input, expansion follows). No change, no error. |
| Zero summonable agents in the project | The composer's `@` popover never opens; manual `@x` still expands only if `x` resolves to an eligible agent, else literal. |
| Mention on a `Done`/`Abandoned` task | Allowed (Expectation 20); the agent's own workspace axis governs cost. |
| Binding exists but definition lacks `domain_event` | `summonable=false` at write time (footnote); if launched anyway via drift, `loadAgentContext` refuses → `trigger_missing` → row 9. |
| Trust revoked between binding and consume | `resolveEffectiveAgentDefinition` throws → row 9 (`refused`, `PRECONDITION`). |
| Comment posted by an ownerless project token | Actor is `('system', null)`; mentions summon normally (no self-exclusion applies). |

## Contract surfaces → spec files

| Surface | Spec file | Change |
|---|---|---|
| New cross-domain flow doc | **`docs/system-analytics/agent-mentions.md` (new)** | Full R5 structure: Purpose, Domain entities, State machine (summon decision), Process flows (write-time sequence + consume-time flowchart), Expectations (the 20 above), Edge cases, Linked artifacts. Glossary link from `docs/CLAUDE.md` (R7). |
| `task.comment_added` payload + `mentionedAgentIds` | `docs/system-analytics/domain-events.md` | Payload note; also fix the stale "exactly 10 kinds" (code has 11). |
| `comment_added` activity payload + `mentionedAgents`; new kind `agent_summon_suppressed` | `docs/system-analytics/social-board.md` (pipeline diagram :83, mention expansion :111, edge cases), `docs/database-schema.md` (:118, :1169), `docs/db/runs-domain.md` (:437-441 — refresh the already-stale kind list) | prose + ERD |
| `agent_schedules.trigger_type = 'mention'` + no-migration rationale | `docs/system-analytics/agents.md` (bindings + link to the new doc), `docs/db/agents-domain.md` (:127-135), `docs/database-schema.md` (:790) | prose |
| `task_activity_agent_summon_uq` partial unique index | `docs/database-schema.md` index table, `docs/db/runs-domain.md` indexes (:582-583) | ERD/index rows |
| Web comments POST — request unchanged, **response gains `mentionedAgents`** | `docs/api/web.openapi.yaml` (`postTaskComment` :2455-2505 + new `MentionedAgentDTO` schema + example) | schema + prose |
| Ext comments POST — same response field | `docs/api/external/operations.openapi.yaml` (`extCreateTaskComment` :354+, `ExtCreateCommentBody` :3080 prose) **+ fix the pre-existing actor drift at :362-366** (docs claim user/system only; `socialActorForToken` and `CommentDTO.actor.type` already support `agent`) | schema + prose |
| MCP tool description (in-code SSOT) | `mcp/src/tools.ts:508-510` | prose; request schema unchanged (guard proves it) |
| Screens | `docs/screens/projects/project-board.md` (task-detail composer + timeline notes), `docs/screens/projects/project-settings-agents.md` (mention binding row) | prose |
| Agent definition format `recommended.mention` | `docs/system-analytics/agents.md` definition-format section | prose |
| Decision record | `docs/decisions.md` **ADR-151** | new |

No AsyncAPI change (domain events are an internal outbox, not a published channel). No new `MaisterError` code — `CONFIG` for binding validation, existing `AgentLaunchError` codes for refusals.

**Deployment touchpoints: none.** No env vars, ports, sidecars, deps, or compose/Dockerfile changes. `pnpm --filter @maister/mcp build` is the pre-existing documented dist step (.env.example:70-71).

## Design decisions

### D1 — Binding = `agent_schedules` row with `triggerType: 'mention'`
Per the request's recommended shape. Keeps every launch path in one table with its outcome audit (`lastOutcome`/`lastErrorCode`/`lastRunId`) and the `schedulesRevision`-fenced full-replacement save. Mention rows carry no cron/event columns (both shape CHECKs are `<>`-guarded → pass unchanged → **no agent_schedules migration**). **At most one enabled mention binding per (agent, project)**, enforced in `updateAgentLink` beside the existing "one enabled event binding owns a kind" rule (project-links.ts:482-494). Rejected: a boolean on `agent_project_links` — loses one-table visibility, the outcome audit, and prefill symmetry.

### D2 — Launch source stays `'domain_event'` (Q1)
Trigger payload `{source:'domain_event', eventId, payload:{kind:'task.comment_added', payload:<event payload>, mentionedBy:{actorType, actorId}}}` — the `{kind, payload}` core matches the clarification handoff so `taskCommentTriggerContextBlock` routes unchanged; `mentionedBy` is an additive sibling. Consequence: a definition must declare `domain_event` in `triggers:` to be summonable (existing `trigger_missing` gate). Binding creation is deliberately **not** definition-gated (matching today's event bindings); the composer picker compensates by offering summonable agents only.

### D3 — Scanner: one segmentation pass, second token family
Extend `mentions.ts`, never a parallel regex pass. Agent tokens are collected from `text` segments only, so code/link inertness is inherited. Token rule: `@` at a word boundary (start-of-segment, whitespace, or `(`), handle `[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+)?`, **must end alphanumeric**. Resolution is a pure injected function: canonical `pkg:stem` → exact id; bare `stem` → unique match only; else literal. Expansion happens in the same rewrite pass as KEY-N.

### D4 — Link form is the chip carrier (and why)
The renderer must **never re-resolve** mentions: only write-time-resolved mentions may look like mentions. Storing `[@id](/agents/id)` carries that decision into the body, and react-markdown's `a` override detects it structurally. The **leading `/` is load-bearing** — without it, `core:triager` could be parsed as a URL scheme by `urlTransform`; this gets a why-comment in code and a dedicated test. A text-node regex in the renderer was rejected: it would re-resolve at read time and lose the write-time truth.

### D5 — Consumer: additive mention branch, structurally-idempotent suppression
New branch for `kind === 'task.comment_added' && payload.mentionedAgentIds?.length`, running **before** the generic matcher and **without** `continue` (mentions are additive; the clarification `continue` stays clarification-only). It fans out to N agents and must NOT reuse the generic single-owner loop. Per deduped id, the frozen decision table applies.

**Suppression idempotency is structural, not read-then-write.** Migration 0121 adds a partial unique index
`task_activity_agent_summon_uq` on `(task_id, (payload->>'agentId'), (payload->>'triggerEventId')) WHERE event_kind='agent_summon_suppressed'`, and the insert uses `onConflictDoNothing`. This matches the project's `runs_agent_trigger_event_uq` philosophy (the unique is the backstop) and removes a TOCTOU window that a check-before-insert would leave.

This is the **first domain-event consumer to write `task_activity`**; the nearest sanctioned precedent is the `pr_state_scan` scheduler job (pr-state-scan.ts:468-475 — system actor, own tx). ADR-151 restates the ADR-078 D7 invariant as: *`recordTaskActivity` remains the only writer; callers are either the originating domain transaction or a system-actored async consumer/job whose write is idempotent by construction.*

### D6 — Write path
In the existing transaction: resolve candidates → expand → store expanded body → `comment_added` activity payload gains `mentionedAgents:[{id, summonable}]` (omit-empty; write-time truth for the UI) → domain event payload gains `mentionedAgentIds: string[]` (deduped, omit-empty) → **no** subscribe/fanout for agents.

### D7 — `agent_summon_suppressed` activity kind fan-out
TS union + DB CHECK (migration 0121) + timeline label map (page.tsx:330-342, `taskDetail.event.*`) + project-log label map (page.tsx:523-531) + interleave passthrough + docs kind lists. `inbox_items_event_kind_check` is deliberately **not** widened (the kind never fans out); its pre-existing staleness is tracked separately, out of scope here.

### D8 — `'mention'` triggerType fan-out
`scheduleSchema` zod · `normalizeSchedule` mention arm (all-null cron/event columns; `CONFIG` on stray fields) · `updateAgentLink` at-most-one rule · `scheduleToView` · attach/edit modal row · `rowFromAvailable` prefill · `recommendedSchema` · docs. Verified no-change: cron tick (triggers.ts:138-146) and generic matcher (triggers.ts:439-448) filter their type explicitly — asserted by test, not by assumption.

### D9 — UI/UX contract (Q5)
**Autocomplete** (hand-rolled, per project convention; keyboard model from `branch-select.tsx`, row visuals from `relations-editor.tsx`):
- *Trigger*: `@` at a word boundary; query = following `[A-Za-z0-9._:-]*`. Closes on whitespace, `Escape`, blur, caret leaving the token, or zero matches.
- *Data*: server props from the RSC page (**no new endpoint**), summonable agents only — "creatable now, unlaunchable later" is a design defect. If the project has zero summonable agents the popover never opens and the hint does not advertise the feature.
- *Keyboard*: `ArrowDown`/`ArrowUp` move with wrap, `Enter`/`Tab` select, `Escape` closes and keeps the typed text; when closed, all keys behave natively (Enter must still submit nothing / newline as today).
- *IME safety*: ignore key handling while `nativeEvent.isComposing` (required for RU/CJK input).
- *ARIA*: textarea carries `aria-expanded`, `aria-controls`, `aria-activedescendant`; list is `role="listbox"` with `role="option"` + `aria-selected`; a polite live region announces the match count. Icon-free rows with visible text as the accessible name.
- *Pointer*: options are buttons; `onMouseDown` prevents default so selection never loses focus first. Active option is scrolled into view. Max 8 rows.
- *Insertion*: replace the partial token with `@<canonical id>` + a trailing space, caret after it, focus retained.
- *Positioning*: anchored below the textarea (not caret-tracked) — KISS, matches the existing precedent.
- *i18n*: EN + RU for every string including aria labels and live-region text; update `composerPlaceholder`/`composerHint`, which today advertise KEY-N only.

**Rendering**: one chip style — a non-navigating `<span>` accent pill with `title={agentId}` (not an `<a>`: `/agents` is admin-only, so a link would 403 for members). Task KEY-N links keep their existing amber-link treatment, so the two mention kinds stay visually distinct.

**Explanations**: a per-comment footnote lists resolved-but-not-summonable mentions with remediation text ("no mention trigger — a project admin can enable one in project settings"); suppressed summons render as their own timeline event. Successful summons get no extra row (Q3) — the run is the evidence.

### D10 — No new HTTP endpoint
The task-detail page already loads the project's agents and computes launchability inline (page.tsx:223-236); mention candidates are derived there and passed as props. Rationale recorded so a reviewer does not expect an autocomplete route. No new body-controlled cross-resource identifiers anywhere in this plan: the comments POST body stays `{body}` (free text), with task/project derived from url-param + server state exactly as today.

### D11 — POST response reports resolved mentions (Expectation 17)
Both comment POSTs return, alongside the existing payload, `mentionedAgents: [{id, name, summonable}]` (omit when empty). Rationale: the assistant-over-MCP is a first-class author of summoning comments, and today it would have to parse markdown links to learn whether its summon was accepted. Write-time truth is exactly what the pipeline already computed — zero extra queries. Scope guard: POST responses only; `CommentDTO` and the GET list are untouched (deriving this for historical comments would need an activity join). The MCP request-shape drift guard stays green by construction; the OpenAPI response schemas are updated in the same change.

### D12 — Authorization and containment (verified, not assumed)
`commentTask` and `launchRun` are both `member`, so no session user gains launch power they lacked. Creating/enabling a mention binding requires `editSettings` (**project admin**) — the binding *is* the authorization, and the summonable set is operator-curated (Expectation 15). On the ext surface, `comments:create` can indirectly cause a launch without holding `runs:launch`; this property **already exists** for generic `task.comment_added` event bindings and is not introduced here — ADR-151 records it explicitly, with the admin-gated binding as the containment. Storm containment: per-task-per-agent active-run suppression + the agent concurrency cap; queue drain is the existing `promoteNextPending`.

### D13 — `recommended.mention` fan-out (Q4 — now)
`recommendedSchema` (definition.ts:168-189, `.strict()`) gains optional `mention: z.boolean()`; `rowFromAvailable` maps it to a prefilled mention row. **Critically**, `frontmatter-artifact-editor.tsx:540-569` rebuilds `recommended` from known sub-fields only and writes the whole object back — it MUST learn `mention`, or Studio edits will silently strip it from authored agents. The read-only mirror `studio/agent-view.tsx` shows it too. Round-trip requirement (config-state symmetry): SET → present; CLEAR (unchecked) → key absent; re-SET → present again — all three asserted.

---

# Part II — Execution

## TDD protocol (applies to every implementation task)

Each task runs **RED → GREEN → REFACTOR**, and its checklist is not complete until all three are done:

1. **RED** — write only the tests the task names; run the named command; **observe the failure and confirm it fails for the intended reason** (assertion mismatch, or module-not-found when the unit is genuinely new). A test that passes on first run is a defective test — fix the test, not the code.
2. **GREEN** — the minimum implementation that turns them green. No speculative options, no unrequested config surface.
3. **REFACTOR** — with the suite green, remove duplication and tighten naming/structure against the named principle checks below; re-run the suite.

**Principle checks at each REFACTOR** (named per task where non-obvious):
- *SOLID*: resolution/eligibility/decision logic stays in pure or single-purpose functions; the consumer branch orchestrates and does not re-implement eligibility SQL; DB access is injected (`db ?? getDb()`, `tx` passthrough) as the codebase does.
- *KISS*: no abstraction that has exactly one caller and no test seam; no configurability nobody asked for.
- *DRY*: one predicate source (`MENTION_SUPPRESSION_STATUSES`), one summonability query, one token regex, one chip-detection rule — greps must show no second definition.
- *Conventions*: `MaisterError` with a `code` (never bare `Error`), `@/` imports, no `any` without `// FIXME(any):`, no `console.*`, eslint auto-fix rules (import order, padding lines, jsx-sort-props) satisfied.

**Test ownership matrix** — each behavior is asserted at exactly one layer; duplicating an assertion across layers is a review defect. Trivial tests are banned: no "module exports X", no re-testing zod defaults or framework behavior, no snapshot of static markup.

| Behavior | Owning layer | File |
|---|---|---|
| Tokenization, resolution, expansion, inertness, href form | unit | `web/lib/social/__tests__/mentions.test.ts` |
| Summonability matrix (8 combinations) | integration | `web/lib/agents/__tests__/summonability.integration.test.ts` (new) |
| Single-tx atomicity, no inbox/subscriber rows | integration | `web/lib/social/__tests__/social-domain.integration.test.ts` |
| Event payload shape (dedup, omit-empty) | integration | `web/lib/domain-events/__tests__/emit-sites.integration.test.ts` |
| POST response `mentionedAgents` (web + ext) | integration | the two existing comment route integration suites |
| Decision table rows 1-10 | integration | `web/lib/agents/__tests__/triggers.integration.test.ts` |
| Binding validation + at-most-one + `recommended` round-trip | unit (+1 integration for the DB round-trip) | `web/lib/agents/__tests__/`, `project-links` suites |
| Autocomplete filtering, token detection, insertion | unit (pure helpers) | `web/components/social/__tests__/` |
| Chip rendering, footnote mapping, timeline interleave | unit (`renderToStaticMarkup`, per project convention — no jsdom) | `web/components/social/__tests__/`, `web/lib/queries/__tests__/` |
| Composer → chip → footnote happy path in a real browser | e2e (UI only; **does not** re-assert launch) | `web/e2e/agent-mentions.spec.ts` (new) |
| MCP request-shape ↔ OpenAPI parity | contract | `mcp/src/__tests__/tool-contract.test.ts` (existing guard) |

**Runnability**: every new file lands in an existing runner glob — unit `lib/**/*.test.ts`, `components/**/*.test.ts`, `app/**/__tests__/**/*.test.ts`; integration `lib/**/*.integration.test.ts`, `app/**/*.integration.test.ts` (web/vitest.workspace.ts:50-94); e2e under `web/e2e/`. No runner config change is required — confirm with `vitest list` if a new path family appears.

**Per-phase green checkpoint**: each phase ends with the touched suites green. Pre-existing red found along the way is quarantined explicitly (config `exclude` or `.skip` + reason + follow-up), never silently tolerated.

## Phase order (dependency-derived)

Binding lands **before** the write path: `listMentionCandidateAgents` queries `agent_schedules` for `triggerType='mention'`, which does not typecheck until the schema union exists. Scanner work is independent but rides along with the write path it feeds.

```
Phase 0  spec ──► Phase 1  binding foundation ──► Phase 2  resolution + write path
                                                        │
                                                        ▼
                          Phase 4  surfaces ◄──── Phase 3  consumer ──► Phase 5  e2e + gates
```

## Commit Plan
- **Commit 1** (T1-T2): `docs(social,agents): ADR-151 + agent-mention spec, contracts, screens`
- **Commit 2** (T3-T5): `feat(agents): mention trigger binding + migration 0121 + attach/Studio surfaces`
- **Commit 3** (T6-T8): `feat(social): agent-mention scanning, resolution, write path + response contract`
- **Commit 4** (T9): `feat(agents): directed mention summon in the domain-event consumer`
- **Commit 5** (T10-T11): `feat(web): mention autocomplete, chips, summon notes, i18n`
- **Commit 6** (T12-T13): `feat(mcp): comment_create mention contract; e2e + docs flip`
(No AI trailer — repo convention.)

## Tasks

### Phase 0 — Spec freeze (SDD; no code until this lands)

- [x] **T1. `docs/system-analytics/agent-mentions.md` (new) + ADR-151 + analytics deltas**
  New R5-structured doc: Purpose · Domain entities · State machine (`stateDiagram-v2` of the summon decision) · Process flows (write-time `sequenceDiagram`, consume-time `flowchart` mirroring the decision table) · **Expectations** (the 20 normative bullets) · **Edge cases** (the table, each tied to its behavior/error code) · Linked artifacts. Tag every piece `(Designed)` per R6; add the glossary link in `docs/CLAUDE.md` per R7.
  ADR-151 in docs/decisions.md: D1-D13, explicitly including the restated ADR-078 D7 one-writer invariant (D5), the ext-scope property + admin-gated containment (D12), and the deliberate no-migration finding for `agent_schedules`.
  Deltas: social-board.md, agents.md (+ definition-format `recommended.mention`), domain-events.md (+ fix stale kind count), database-schema.md, docs/db/runs-domain.md (+ refresh stale kind list), docs/db/agents-domain.md.
  Exit: decision table, Expectations, and Edge cases are internally consistent and stated exactly as the code will branch; `pnpm validate:docs` green; ADR anchor check (`scripts/validate-docs-adr-anchors.mjs`) green.

- [x] **T2. API contracts + screens docs**
  `docs/api/web.openapi.yaml`: `postTaskComment` response gains `mentionedAgents` (new `MentionedAgentDTO` schema: `id`, `name`, `summonable`) + example + prose on @-expansion. `docs/api/external/operations.openapi.yaml`: same response field on `extCreateTaskComment`, mention prose on `ExtCreateCommentBody`, **and** the pre-existing actor-mapping drift fix at :362-366 (agent tokens author as `('agent', agentId)`). Screens: `docs/screens/projects/project-board.md` (composer autocomplete + timeline notes) and `project-settings-agents.md` (mention binding row) per the screens template.
  Exit: specs describe exactly the behavior Phases 1-4 will implement; `pnpm validate:docs` green.

### Phase 1 — Binding foundation

- [ ] **T3. Migration 0121 + `task_activity` kind union**
  RED: an integration assertion that an `agent_summon_suppressed` activity row inserts once and that a duplicate `(task_id, payload agentId, payload triggerEventId)` insert is a silent no-op under `onConflictDoNothing`. Run integration (testcontainers apply migrations on boot).
  GREEN: `migrations/0121_agent_mention_summons.sql` — (a) drop/re-add `task_activity_event_kind_check` with `agent_summon_suppressed` (pattern: 0111); (b) partial unique `task_activity_agent_summon_uq` on `(task_id, (payload->>'agentId'), (payload->>'triggerEventId')) WHERE event_kind='agent_summon_suppressed'`. Additive only — no data-bearing DROP, no backfill (stated in the migration header, together with the evidence that `agent_schedules` needs no migration). TRIPLE: SQL + `_journal.json` entry (verify `when` monotonic) + `meta/0121_snapshot.json`. schema.ts: `TASK_ACTIVITY_EVENT_KINDS` + the index declaration. `inbox_items_event_kind_check` deliberately untouched.
  REFACTOR: confirm the newest journal entry has a matching snapshot; no other CHECK is touched.

- [ ] **T4. `'mention'` triggerType server-side + `recommended.mention` fan-out**
  RED: unit — `normalizeSchedule` mention arm (accepts a minimal row; `CONFIG` on stray cron/event fields); `scheduleSchema` accept/reject matrix; at-most-one-enabled-mention rule; `recommendedSchema` accepts `mention` and still rejects unknown keys (`.strict()`); **Studio frontmatter round-trip: SET → CLEAR → re-SET** (the data-loss regression). Integration — `updateAgentLink` mention-binding round-trip. Run unit + integration.
  GREEN: schema.ts triggerType union; `normalizeSchedule` arm; `updateAgentLink` rule; `scheduleToView`; route `scheduleSchema`; `recommendedSchema.mention`; **`frontmatter-artifact-editor.tsx:547-569` `editRecommended` learns `mention`** (else Studio strips it); `studio/agent-view.tsx` read-only mirror.
  REFACTOR + fan-out acceptance: complete every D8 row; grep `triggerType`/`trigger_type` and `TASK_ACTIVITY_EVENT_KINDS` consumers repo-wide; add the two guard tests proving the cron tick and the generic matcher ignore `'mention'`.

- [ ] **T5. Attach/edit UI + prefill**
  RED: unit — `rowFromAvailable` maps `recommended.mention` to one mention row; modal validity accepts a mention row with no cron/event input. GREEN: minimal "Add mention trigger" row in `agents-attach-edit-modal.tsx` + prefill in `agents-attach-panel.tsx`; EN/RU strings. REFACTOR: the row reuses the existing binding-row layout rather than a parallel component (DRY). Binding edits stay `editSettings`-gated (admin) — do not loosen.

### Phase 2 — Mention resolution + write path

- [ ] **T6. Agent-handle scanning + expansion (`web/lib/social/mentions.ts`)**
  RED: extend `web/lib/social/__tests__/mentions.test.ts` — canonical `@pkg:stem`; bare unique stem; ambiguous bare → literal; unknown → literal; fenced block inert; inline-code inert; inside existing link inert; `user@example.com` non-match; trailing punctuation boundary; duplicate handle → single id, both occurrences expanded; mixed KEY-N + @agent in one body; **href starts with `/`** (scheme-parse guard). Run `pnpm --filter maister-web test:unit`; expect module-not-found for the new exports, then assertion failures.
  GREEN: `collectAgentMentionCandidates(segments)` + pure `resolveAgentMentions(candidates, agents)` + expansion inside the existing rewrite pass; extend `expandMentions` to return agent mentions alongside task mentions (single caller — comments.ts — updated in T8). DEBUG log of candidate/resolved counts on the existing logger.
  REFACTOR: one token regex, one boundary rule, shared segment walk with KEY-N (DRY); why-comment on the leading-slash invariant (non-obvious constraint — the only comment this task adds).

- [ ] **T7. Summonability helper (`web/lib/agents/summonability.ts`, new)**
  RED: new `web/lib/agents/__tests__/summonability.integration.test.ts` covering the 8-row matrix — no link · link disabled · agent disabled · quarantined · no mention binding · binding disabled · definition lacks `domain_event` · fully summonable; plus project scoping (an agent attached to another project is absent). Run `pnpm --filter maister-web test:integration`.
  GREEN: `listMentionCandidateAgents(dbOrTx, projectId) → {id, stem, name, summonable}[]` (eligibility mirroring triggers.ts:341-361 + LEFT JOIN enabled mention binding + `triggers ∋ 'domain_event'`), accepting an injected `tx`. Export `MENTION_SUPPRESSION_STATUSES` with a why-comment naming its concern and why `Review`/`Crashed` are excluded.
  REFACTOR: this module is the single source for both the write path and the consumer's eligibility check (DRY); assert by grep that no second eligibility query exists.

- [ ] **T8. Write path + POST response contract**
  RED: extend `social-domain.integration.test.ts` (expanded body stored; activity payload `mentionedAgents`; **zero** `inbox_items`/`task_subscribers` rows for agent mentions; poisoned-step rollback leaves no partial writes) · `emit-sites.integration.test.ts` (payload carries deduped `mentionedAgentIds`; mention-free comment omits the key) · both comment-route integration suites (POST response `mentionedAgents`; ext agent-token author expands identically; self-mention still expands). Run integration.
  GREEN: wire T6+T7 into `addTaskComment` inside the existing transaction; add the response field in both routes. Extend the existing INFO "comment added" line with the agent-mention count.
  REFACTOR: no new transaction boundaries; response projection is an explicit DTO mapping at the boundary (project convention: rows never serialize verbatim).

### Phase 3 — Consumer

- [ ] **T9. Mention branch in `web/lib/agents/triggers.ts`**
  RED: extend `triggers.integration.test.ts` with **one case per frozen decision-table row** — no-taskId skip (row 1); non-summonable/no-binding skip (2,4); self-mention no-op (3); suppression writes exactly one row and no run, and stays one row under redelivery (5,12); launch (6) carrying `task_id`/`trigger_event_id`; over-cap → `Pending` + `queued` (7); redelivery → exactly one run (8); refusal recorded with its code (9); plus **interaction**: an agent holding both a mention binding and a generic `task.comment_added` event binding yields exactly one run and leaves the pre-existing lowest-`scheduleId` single-owner behavior unchanged (13); two mentioned agents → two runs; `Review`-status run does **not** suppress while `Running` does; a mention-free `task.comment_added` still takes the generic path untouched. Run integration; confirm each fails for its own reason.
  GREEN: the branch per D5 — before the generic loop, no `continue`, deduped ids, per-agent try/catch that never rethrows, outcomes via `recordAgentScheduleOutcome`, suppression insert with `onConflictDoNothing` (backed by T3's partial unique), launch with `agentScheduleId` set. INFO per decision `{eventId, agentId, decision, runId?}`; WARN on refusals with the error code.
  REFACTOR: the branch orchestrates only — eligibility comes from T7, the status predicate from T7's export, the launch shape from the existing helper (SOLID/DRY). No new registration is added (the consumer is already registered and covered by `dispatch.integration.test.ts`), so no wiring-seam test is needed.

### Phase 4 — Surfaces

- [ ] **T10. Composer autocomplete (UX contract D9)**
  RED: unit tests for the pure helpers — `detectMentionQuery(text, caret)` (word-boundary trigger, closes on whitespace, no trigger mid-email), `filterMentionCandidates(candidates, query)` (prefix-before-substring, id and name, 8-row cap), `applyMentionSelection(text, caret, id)` (replaces the partial token, adds one trailing space, returns the new caret). Run unit.
  GREEN: page-side candidate derivation (summonable only, from data already loaded); popover in `comment-composer.tsx` implementing the full D9 contract (keyboard incl. wrap, `isComposing` guard, ARIA set, live-region count, pointer-safe selection, scroll-into-view, zero-candidate = never open); EN/RU strings incl. aria labels; updated placeholder/hint.
  REFACTOR: helpers stay pure and colocated; the component holds interaction only (SOLID); no duplicate filtering in the popover.

- [ ] **T11. Chips, footnotes, timeline**
  RED: unit — `MarkdownBody` via `renderToStaticMarkup`: an `/agents/…` link with an `@` label renders the non-navigating chip; a normal link and a KEY-N task link are untouched; a code-fenced mention stays plain text. `task-detail` mapping: `comment_added` payload → per-comment `mentionedAgents` attached before the existing `comment_added` filter; `agent_summon_suppressed` interleaves into the timeline. Run unit.
  GREEN: `markdown-body.tsx` `a` override case; `task-detail.ts` mapping; `task-timeline.tsx` footnote + suppressed-event row; label maps on both pages; EN/RU strings.
  REFACTOR: one chip-detection predicate shared by any future caller (DRY); no styling duplication with task links.

- [ ] **T12. MCP facade + dist**
  RED: run `pnpm --filter @maister/mcp test` first to confirm the guard is green pre-change (baseline), then update. GREEN: `comment_create` description documents canonical/bare syntax, code-inertness, and that the response reports resolved mentions; rebuild `pnpm --filter @maister/mcp build`. REFACTOR/verify: guard green (request schema unchanged by construction); no TOOL_SPECS field added.

### Phase 5 — End-to-end + release gates

- [ ] **T13. E2E, docs flip, full gates**
  RED→GREEN: new `web/e2e/agent-mentions.spec.ts` seeded like the existing social-board spec — type `@`, pick from the popover, submit, assert the chip renders and a non-summonable mention shows its footnote. Scope boundary: the e2e asserts the **UI contract only**; launch behavior stays owned by T9's integration tests (no overlap).
  Then flip every `(Designed)` tag from T1/T2 to `(Implemented)`, re-verify each contract surface against shipped code, and run all gates:
  `pnpm --filter maister-web typecheck` · `pnpm --filter maister-web exec eslint .` (**check-only — never bare `pnpm lint`, it reformats ~60 files**) · `pnpm --filter maister-web test:unit` · `pnpm --filter maister-web test:integration` · `pnpm --filter maister-web test:e2e` (kill ports 3100/7788 first — shared across worktrees) · `pnpm --filter @maister/mcp test` · `pnpm validate:docs` + the ADR anchor script.
  Any pre-existing red gets an explicit quarantine note, never silence.

## Acceptance criteria (each maps to its owning test)

| # | Criterion | Owner |
|---|---|---|
| 1 | "@core:triager please dedupe" on a task where the agent is attached with an enabled mention binding → exactly one run with `task_id` + `trigger_event_id` and comment-thread prompt context | T9 (row 6) |
| 2 | Redelivery of the same event creates no second run | T9 (row 8) |
| 3 | Same comment without the mention binding → chip renders, nothing launches, footnote explains | T8 + T9 (rows 2/4) + T11 |
| 4 | `@core:triager` inside a fenced code block is inert | T6 (+ T13 visual) |
| 5 | Bare `@triager` resolves iff exactly one attached eligible agent has that stem | T6 + T7 |
| 6 | An agent mentioning itself does not self-launch; mentioning another agent does | T9 (row 3) |
| 7 | `comment_create` via MCP behaves identically to the web composer and reports resolved mentions | T8 + T12 |
| 8 | Active run on the task → no new run, exactly one suppression note even under redelivery | T9 (rows 5/12) + T3 |
| 9 | A `Review`-status run does not suppress a re-summon | T9 |
| 10 | Mention + generic subscription on one agent → exactly one run; generic single-owner behavior unchanged | T9 (row 13) |
| 11 | Over-cap summon queues as `Pending` | T9 (row 7) |
| 12 | Zero `inbox_items`/`task_subscribers` rows from agent mentions | T8 |
| 13 | Comment write remains atomic under a poisoned step | T8 |
| 14 | Autocomplete offers only summonable agents; keyboard, ARIA, and IME contract hold | T10 (+ T13) |
| 15 | `recommended.mention` survives a Studio frontmatter edit round-trip | T4 |
| 16 | Migration 0121 is a valid triple; no `agent_schedules` migration exists; cron + generic matching unaffected | T3 + T4 |
| 17 | Every contract surface in the table matches shipped behavior; all gates green | T13 |

## Non-goals (unchanged)
@user mentions and human-notification changes · mentions in task title/description · agent inbox rows or chat surfaces · cooldown frameworks beyond suppression + dedup · cross-project mentions · widening `inbox_items_event_kind_check` (tracked separately).

## Open questions
None — Q1-Q5 answered above. Any new ambiguity found during T1 must be resolved in the spec before Phase 1 starts.
