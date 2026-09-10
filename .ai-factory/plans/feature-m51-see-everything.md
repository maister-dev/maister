# M51 — See everything: a read-only visibility layer for teams

**Branch**: `feature/m51-see-everything` (off `master` @ `21b036ec`)
**Created**: 2026-09-10 · **Refined**: 2026-09-10 (`/aif-improve` — SDD + TDD pass)
**Source brief**: [`docs/pv/team-visibility-and-po-intake.md`](../../docs/pv/team-visibility-and-po-intake.md)
(cherry-picked as `24bf383e`). Option ids refer to that brief; its section numbers
differ from the original request — gap map **§2**, ranked options **§3.A–§3.F**,
owner decisions **§7**, Desk mockup **§8**, agreed scope **§9**.

One plan, one branch, one milestone, nine phases. Specifications come first and
carry **enforced requirement IDs**; implementation is **test-first**.

## Settings

- **Testing**: TDD, RED → GREEN → REFACTOR (see "TDD protocol").
- **Logging**: verbose (`pino`, `LOG_LEVEL`-gated `debug` on every new read model,
  route and sender, matching `lib/ext-activity/promotable.ts`).
- **Docs**: mandatory. Phase 0 is spec-first (Deviation 1) and its output is
  machine-validated, not conventional (see "Requirement IDs and traceability").
- **i18n**: EN + RU in the task that adds the string. Never a follow-up.

## Roadmap Linkage

**Milestone**: **M51. See everything** — one milestone, opened by T0.13. No `a`/`b`
sub-slices; the `M11a/b/c` precedent exists for a milestone that *had* to ship in
separate increments, and this one does not.
**Rationale**: owner decision 2026-09-10 — close M45, make this the next
milestone. **M50 is already taken** ("Run continuation controls",
`.ai-factory/ROADMAP.md:721`), so despite M45 being the highest *unchecked*
milestone the next free number is **51**. Also discharges backlog §A1
("Human-facing run-summary / attention digest — machine pulse exists, human
surface absent"), updated in T8.5.

**On closing M45**: T0.13 marks it complete *per the owner's decision* and the
`## Completed` row must say so. I cannot verify M45's acceptance evidence — it
demands "three representative processes across at least three internal/private
repositories with three consecutive runs per process/project profile" plus
telemetry, and nothing in this repo proves those runs happened. If the evidence
exists, cite it; if the milestone is closed as descoped, say *that*. Flipping a
checkbox on an unmet acceptance bar is the one option T0.13 forbids.

## Scope

| Brief id | Deliverable | Requirements | Phase |
| --- | --- | --- | --- |
| E4 | `deriveWorkStage` — derived stage vocabulary, no persisted column | `STG-01..07` | 1 |
| E1 | `/work` cross-project work table | `STG-08..10` | 2–3 |
| B1 | Decision queue, two canonical counters, `GET /api/v1/ext/decisions` | `ATN-01..08` | 4 |
| A1 · A5 | `/activity` stream + per-user read cursor | `ATN-09..11` | 5 |
| A6 · A2 | Now tiles + deterministic digest v0 | `ATN-12` | 5 (queries) · 6 (render) |
| F1 | Desk home, portfolio → `/projects`, rail re-cut, member default | `NAV-01..06` | 6 |
| B3 | Web push, notification subscriptions, ext subscription ops | `NTF-01..10` | 7 |

**Out (later milestones)**: D1 librarian, initiative entity and E3, D5 project
directory, D7 task statement schema, C3 intake, C2 delivery reports, C1 effects
ledger, B4 Structured Ask, B2 snooze/delegate/claim, B5 mobile pass, any Telegram
bot, agent narration, USD cost, and any change to the run or task state machines.

---

## Requirement IDs and traceability (the SDD contract)

This milestone uses the repo's **existing** spec-driven mechanism rather than a
new one. `scripts/validate-docs-indexes.mjs` already requires, for a registered
document set: all seven R5 sections, **≤ 12 Expectations bullets**, an ID on every
Expectation (`- **EVT-01:** …`, `:67`), an ID on every Edge case
(`**EDGE-EVT-01:** …`, `:73`), globally unique IDs, and — for each ID — a
**traceability row naming a primary test** (`:133-143`).

Four owning documents, four prefixes, all four **newly registered with the
validator** (T0.11 — without that step the IDs are decoration):

| Document | Prefix | Domain |
| --- | --- | --- |
| `docs/system-analytics/work-stages.md` | `STG` | stage vocabulary + work table |
| `docs/system-analytics/attention.md` | `ATN` | counters, decision queue, feed, cursor, digest, stream |
| `docs/system-analytics/home-navigation.md` | `NAV` | Desk IA, routing, rail, role default |
| `docs/system-analytics/notifications.md` | `NTF` | subscriptions, push, delivery, widened engine |

`home-navigation.md` is **new relative to the first draft**: the Desk's IA
invariants are testable and need an owner, screens docs have no Expectations
section, and folding them into `attention.md` would push it to 16 bullets — over
the enforced cap of 12.

**Traceability matrix**: `docs/system-analytics/m51-traceability.md`, in the exact
five-column shape the validator parses (`execution-data-cutover.md:131`):

```
| Requirement | Contract/schema | Enforcement/task | Primary test | Status |
```

**The rows must name real tests.** The existing Stage B matrix has decayed into
what its own preamble calls *"historical scenario aliases, not executed test
names"*. T8.4 greps every `Primary test` cell against the suite and fails if a
name does not resolve to a real test. Test IDs follow the matrix convention:
`UT-` unit · `IT-` integration · `CT-` contract · `E2E-` Playwright, suffixed with
the requirement id (`IT-ATN-03`).

**Bidirectional coverage gate (T0.12)**: every requirement has ≥ 1 task and ≥ 1
primary test; every task names ≥ 1 requirement. An orphan on either side fails
Phase 0.

### The requirements

**`STG` — work stages** (`work-stages.md`, 10 bullets)

| Id | Expectation | Enforced by |
| --- | --- | --- |
| STG-01 | `deriveWorkStage` MUST be total over `RUN_STATUS_VALUES` × task status × triage status | exhaustive `satisfies Record<RunStatusValue, …>` (compile) + `UT-STG-01` |
| STG-02 | It MUST be pure — no DB, no clock, no `server-only` import | `UT-STG-02` |
| STG-03 | `Done` + `promotion_state='none'` MUST yield `Promoted` / `promotedKind:"result"` — never `Executing` or `Review` | `UT-STG-03` |
| STG-04 | `Failed` MUST yield `Ready`; `Crashed` MUST yield `Crashed` | `UT-STG-04` |
| STG-05 | `blocked` MUST be an attribute, never a `WorkStage` member | `UT-STG-05` |
| STG-06 | `Intake` and `Delivered` MUST NOT be members until C3 / C2 ship | `UT-STG-06` |
| STG-07 | No `WorkStage` value is ever persisted | `IT-STG-07` (schema grep + no write path) |
| STG-08 | `/work` MUST issue a query count independent of row count | `IT-STG-08` |
| STG-09 | `/work` MUST list only projects from `getVisibleProjectIds` | `IT-STG-09` |
| STG-10 | Every member MUST have EN and RU labels with distinct copy | `UT-STG-10` |

Edge: `EDGE-STG-01` latest-run-of-many · `EDGE-STG-02` `workspaceRemoved` +
`Review`/`Crashed` → Backlog (existing board rule) · `EDGE-STG-03` task with no run.

**`ATN` — attention** (`attention.md`, 12 bullets — at cap)

| Id | Expectation | Enforced by |
| --- | --- | --- |
| ATN-01 | `decisions` = respondable HITL + promotable + crashed + flagged, from ONE query; count === list length | `IT-ATN-01` |
| ATN-02 | `updates` MUST subtract the inbox/activity overlap via `source_ref->>'activityId'` | `IT-ATN-02` |
| ATN-03 | With no cursor row, `updates` MUST count a bounded 24 h window | `IT-ATN-03` |
| ATN-04 | Relation-blocked tasks MUST count in neither counter | `IT-ATN-04` |
| ATN-05 | Every surface MUST read one layout-level `decisions` value | `IT-ATN-05` |
| ATN-06 | The ext pulse's `needsYouCount` semantics MUST NOT change | `CT-ATN-06` |
| ATN-07 | Queue order = HITL criticality, then age; non-HITL rank crashed > promotable > flagged | `UT-ATN-07` |
| ATN-08 | `decision_request` MUST NOT appear on any ext surface | `IT-ATN-08` |
| ATN-09 | The feed MUST NOT expose worktree paths, diff bodies or raw ACP frames | `IT-ATN-09` |
| ATN-10 | Cursor advance MUST be monotonic and idempotent | `IT-ATN-10` |
| ATN-11 | The stream MUST emit no frame for an invisible project and MUST NOT mutate run state | `IT-ATN-11` |
| ATN-12 | Digest v0 MUST be deterministic — same clock + rows ⇒ byte-identical output | `UT-ATN-12` |

Edge: `EDGE-ATN-01` no cursor row · `EDGE-ATN-02` membership gained/lost after the
cursor · `EDGE-ATN-03` stale/out-of-order cursor POST · `EDGE-ATN-04` `lastEventId`
replay.

**`NAV` — home navigation** (`home-navigation.md`, 6 bullets)

| Id | Expectation | Enforced by |
| --- | --- | --- |
| NAV-01 | `/` MUST render the Desk for an admin | `E2E-NAV-01` |
| NAV-02 | A non-admin member MUST land on `/work` | `E2E-NAV-02` |
| NAV-03 | `/projects` MUST render the former portfolio unchanged | `E2E-NAV-03` |
| NAV-04 | `railSectionForPathname` MUST be total over app route prefixes; `/` → `home` | `UT-NAV-04` |
| NAV-05 | Every inbound `/` link MUST resolve to the surface its call site intends | `UT-NAV-05` |
| NAV-06 | Nav visibility MUST NOT be the authorization boundary | `IT-NAV-06` |

Edge: `EDGE-NAV-01` no projects (empty state) · `EDGE-NAV-02` narrow stacking.

**`NTF` — notifications** (`notifications.md`, 10 bullets)

| Id | Expectation | Enforced by |
| --- | --- | --- |
| NTF-01 | User-scoped events MUST ride the ADR-077 outbox; no second outbox | `IT-NTF-01` |
| NTF-02 | Every reader of `webhook_events.run_id`/`project_id` MUST handle NULL | `IT-NTF-02` (per-reader table) |
| NTF-03 | A platform-wide subscription MUST NOT match a user event, and vice versa | `IT-NTF-03` |
| NTF-04 | The sender MUST persist intent before the send and stamp `delivered_at` after | `IT-NTF-04` |
| NTF-05 | A push `410 Gone` MUST delete the subscription; other failures follow the retry curve | `IT-NTF-05` |
| NTF-06 | Secrets MUST be stored as `env:` refs only | `IT-NTF-06` |
| NTF-07 | A personal token MUST CRUD only its own owner's subscriptions | `IT-NTF-07` |
| NTF-08 | Triggers MUST be `decisions` deltas and digests only — never per-event | `IT-NTF-08` |
| NTF-09 | `decisions:read` and `notifications:subscriptions` MUST be absent from agent scope sets | `UT-NTF-09` |
| NTF-10 | Missing VAPID config MUST degrade to "push unavailable", never crash boot | `IT-NTF-10` |

Edge: `EDGE-NTF-01` at-least-once redelivery converges to one notification ·
`EDGE-NTF-02` expired push subscription · `EDGE-NTF-03` existing project webhooks
unaffected by the widening.

---

## TDD protocol

Every implementation task runs **RED → GREEN → REFACTOR**, in that order, and says
so in its body. A task body names the test file, the test id, and the assertion
that must fail first.

1. **RED** — write the named test(s) and run them. The failure must be a
   **specific assertion failure**, not an import or type error; an import error
   proves nothing about behaviour. Record the observed failure.
2. **GREEN** — implement the minimum that satisfies the assertion. No
   speculative generality, no unused parameters, no config knobs nobody asked for.
3. **REFACTOR** — with the suite green, apply SOLID / KISS / DRY and the project
   conventions in `web/CLAUDE.md`. Re-run; still green.

**A task is done when** its requirement IDs are green in the matrix, the named
tests exist *and execute in the named vitest project*, and both suites are green.

**Test-design rules** (the user's "minimum overlap, no trivial tests"):

- **One primary test per requirement.** A second test at the *same level* is
  justified only by its own `EDGE-*` id — two integration tests asserting one
  requirement is duplication to delete.
- **`E2E-` is a different level, not a duplicate.** An acceptance test proves the
  *wiring* (the value reaches the page, the route resolves, the badge clears);
  a `UT-`/`IT-` primary proves the *logic*. A requirement may carry both, and only
  two do here — `STG-09` (visibility scoping: `IT-STG-09` in the read model,
  `E2E-STG-09` through `/work`) and `ATN-10` (cursor: `IT-ATN-10` for monotonicity,
  `E2E-ATN-10` for the divider). The matrix's `Primary test` column always names
  the lower-level one; the acceptance test is listed beside it. Three levels for
  one requirement is over-testing and gets cut.
- **A test that cannot fail is a bug.** If deleting the implementation leaves the
  test green, it is trivial — delete the test, not the coverage.
- **No test asserts** a type, a constant, an enum's own literal values, framework
  behaviour, or a pure function re-tested through an HTTP route.
- **Redaction proofs feed the mapping function input that CONTAINS the secret**
  and assert the exact output key set. A test fed an already-safe DTO literal is
  vacuous — a future `{...row}` spread would leak with zero failures
  (`aif-implement` skill-context).
- **Runnability**: `web/vitest.workspace.ts` splits by **filename suffix**, not
  directory — `*.test.ts` → `unit`, `*.integration.test.ts` → `integration`. Both
  glob `lib/**`, `app/**`, `scripts/**`, `test-support/**`, `e2e/**`;
  `components/**` is globbed by **`unit` only**, so a component-level integration
  test never runs. Every integration test below lands under `lib/**` or `app/**`.
- **Playwright**: a spec basename absent from the `AUTHED_SPEC` regex
  (`web/playwright.config.ts:30`) silently never runs in the authed project.

**Phase exit** = lint clean · `pnpm --filter maister-web test:unit && … test:integration`
**green** · `pnpm validate:docs` green · **every requirement owned by the phase is
green in the traceability matrix**. A red test the phase touched fails the phase;
a pre-existing red surfaced by the phase is quarantined by an explicit task with a
reason and a tracked follow-up — never silently tolerated, never deleted.

---

## Deviations from the original request

**Deviation 1 — specs are Phase 0, not the last phase.** The request sequenced docs
last. `.ai-factory/skill-context/aif-plan/SKILL.md` ("Plan MUST front-load a
complete, internally consistent analytics/design spec before any code phase")
requires the opposite for anything adding a wire surface, a DB table or a shared
vocabulary — all three apply. Phase 0 writes all five ADRs, four system-analytics
docs, the traceability matrix, four screens docs and every API spec, and extends
the validators that enforce them. Phase 8 is a trailing **as-built reconciliation**.
This also satisfies brief §7's requirement that `docs/screens/desk.md` precede the
Desk's components.

**Deviation 2 — there is no aggregate SSE stream to reuse.** The request said
`/work` refreshes "via the existing run stream". The only SSE routes are
`web/app/api/runs/[runId]/stream/route.ts` (one run) and
`web/app/api/projects/[slug]/evaluations/studies/[studyId]/stream/route.ts` (one
study). *Owner decision*: a **user-scoped attention stream** modelled on the study
route — a server-side poll of a durable log pushed as SSE, which its own header
comment calls "NOT a state-transition trigger", so root `CLAUDE.md`'s no-polling
rule is intact. One `EventSource` per client, no client timers.

**Deviation 3 — `getRunNodeStatuses` and `queryTaskTokens` are per-entity.**
`getRunNodeStatuses(runId)` (`web/lib/queries/run-node-status.ts:115`) and
`queryTaskTokens(taskId)` (`web/lib/runs/cost-rollups.ts:583`) take a single id;
calling them per row is the N+1 the request itself forbids. The work table reuses
the board's batched path (`buildFlightProgress`,
`web/lib/queries/board-progress.ts:186`) plus a new batched token query (T2.2).

**Deviation 4 — "saved views in localStorage" partly conflicts with the house
rule.** `web/CLAUDE.md` mandates URL-synchronized, deep-linkable state for
filters/tabs/pagination — "not `useState`-only". The **active** filter/group state
lives in the URL (as `/runs` does); localStorage holds only the **named saved-view
list** (label → querystring). Nothing filter-shaped is localStorage-only.

## Decisions

### D1 — Reserved numbers

Verified at `master` HEAD; no branch in this repo is past ADR-167 and none has a
migration above idx 161 (every local and remote ref scanned 2026-09-10):

| Reserved | Subject | Phase |
| --- | --- | --- |
| **ADR-168** | Two canonical attention counters (`decisions`, `updates`); retires `needsYou` | 0 |
| **ADR-169** | Derived work-stage vocabulary and its relation to the board columns | 0 |
| **ADR-170** | User-scoped attention SSE stream | 0 |
| **ADR-171** | Desk home IA — `/` → Desk, portfolio → `/projects`, rail, member default | 0 |
| **ADR-172** | User notification subscriptions + web push over the widened ADR-077 engine | 0 |
| **migration 0162** | `user_activity_cursors` | 5 |
| **migration 0163** | `push_subscriptions` + `notification_subscriptions` | 7 |
| **migration 0164** | Widen `webhook_events` / `webhook_subscriptions` (cross-cutting — own number, never folded into 0163) | 7 |

`docs/CLAUDE.md` **R4 is one decision per ADR**, which is why the request's single
ADR becomes five. **T8.3 budgets a mandatory renumber pass**: the branch stays
unmerged across nine phases while 21 worktrees are live, and `pnpm validate:docs`
cannot detect a cross-branch collision — it checks stub↔record bijection on this
tree only.

### D2 — The stage vocabulary is a fourth "stage", so it gets a distinct name

| Existing | Meaning | Where |
| --- | --- | --- |
| `tasks.stage` column | `"Backlog" \| "Prepare"` — pre-launch spec phase | `web/lib/db/schema.ts:1406` |
| `TaskStage` type | alias of the column | `web/lib/board.ts:56` |
| `deriveStage() → BoardColumn` | the 7 derived board **columns** | `web/lib/board.ts:83` |
| `StageChip {label, type}` | the inbox card's **node** chip | `web/lib/queries/hitl-stage.ts:14` |

New vocabulary = **`WorkStage` / `deriveWorkStage`** in `web/lib/work/stage.ts`.
**Nothing above is renamed** (surgical rule). ADR-169 records the four-way
distinction. On the inbox card the `WorkStage` chip is **added beside** the node
`StageChip` — they answer different questions ("where is this task" vs "which node
is asking").

### D3 — `WorkStage` is total, and the brief's diagram is incomplete

`RUN_STATUS_VALUES` has **11** members; the brief's §5 diagram omits four cases.
ADR-169 carries this table normatively (requirements `STG-01`, `STG-03`, `STG-04`):

| Run state | `WorkStage` | Why |
| --- | --- | --- |
| `Pending` | `Queued` | cap full; the queue-position badge exists |
| `Running` | `Executing(k/N)` | k/N from the batched spine |
| `NeedsInput`, `NeedsInputIdle` | `WaitingOnHuman` | idle is a checkpoint, not a stage |
| `HumanWorking` | `WaitingOnHuman` | covers the ADR-030 takeover and the ADR-160 rework claim |
| **`WaitingOnChildren`** | `Executing` | *absent from the brief.* Parked orchestrator; the board already buckets it in `InProduction` (`web/lib/board.ts:80`) |
| `Review` | `Review` | |
| `Crashed` | `Crashed` | |
| `Done` + `promotion_state='done'` | `Promoted` | |
| **`Done` + `promotion_state='none'`** | `Promoted` / `promotedKind:"result"` | *absent from the brief.* ADR-165 result-only completion never promotes — there is no branch. Rendering it `Executing` or `Review` would be a lie |
| **`Failed`** | `Ready` | *absent from the brief.* Root `CLAUDE.md`: `Failed\|Crashed\|Abandoned` returns the task to Backlog and Launch reappears. `Crashed` is the documented exception |
| `Abandoned` | `Abandoned` | |
| *no run* + `triage_status IS NULL` | `Triage` | |
| *no run* + `'flagged'` | `Held` | |
| *no run* + `'triaged'` | `Ready` | |
| *no run* + blocking relations | `Ready` + `blocked` | `STG-05` — attribute, not stage |

**`Intake` and `Delivered` are NOT members** (`STG-06`). The request asked for
`Delivered(reserved)`; *owner decision overrides* — "поставь по порядку туда, где
достижимы". A member nothing can produce is dead vocabulary that reads as a UI gap
and invites a premature renderer. `Delivered` arrives with C2, `Intake` with C3,
each a one-line widening the exhaustive `satisfies` map makes compile-checked —
the safety "reserved" was reaching for. ADR-169 names their owning milestones.

### D4 — The two counters, and the double-count the naïve definition hides

Today one number exists: `getNeedsYouCount` (`web/lib/queries/needs-you.ts:13`)
`= getCrossProjectHitlInbox().count + getUnreadInboxCount()`.

```
decisions = respondable pending HITL (cross-project)      -- ATN-01
          + mechanically promotable runs
          + Crashed runs owing recover/discard
          + tasks flagged by triage (Held)
updates   = unread inbox_items (read_at IS NULL)          -- ATN-02
          + activity newer than the user's cursor
            MINUS rows already represented by an unread inbox_item
```

**The `MINUS` is load-bearing.** A comment or mention writes *both* a
`task_activity` row and an `inbox_items` row (`web/lib/social/inbox.ts:22` fans out
`comment_added` and `task_mentioned`). Summing double-counts every mention. The
overlap is subtracted by `inbox_items.source_ref->>'activityId'`, which
`InboxSourceRef` (`web/lib/db/schema.ts:7330`) already carries.

**With no cursor row** (`ATN-03`, `EDGE-ATN-01`) `updates` counts a bounded **24 h**
window, matching the digest's fallback. Counting all history would make a first
visit render a meaningless four-digit badge.

**Membership changes** (`EDGE-ATN-02`): the cursor is one global timestamp, so a
user newly added to a project either floods (stale cursor) or never sees that
project's history (fresh cursor). `attention.md` states the chosen behaviour —
activity is filtered by *current* visibility and the cursor is not rewound — so the
answer is documented rather than emergent.

Relation-blocked tasks count in **neither** (`ATN-04`) — a `/work` filter only.

**The ext pulse contract does not change** (`ATN-06`).
`web/app/api/v1/ext/activity/route.ts:63` carries an explicit ADR-152 D4 note that
`needsYouCount` stays HITL-only; redefining it would break every deployed
assistant. ADR-168 freezes it and adds `decisionsCount`/`updatesCount` alongside.

### D5 — Ordering key: HITL criticality, not task priority

`HitlItem.criticality` is `low|medium|high|critical`
(`web/lib/queries/hitl.ts:139`); `tasks.priority` is `low|normal|high|urgent`
(ADR-121, `web/lib/tasks/criticality.ts`). The queue orders by **HITL criticality,
then age** (`ATN-07`). Non-HITL kinds get a fixed rank: `crashed` = high,
`promotable` = medium, `flagged` = low. `tasks.priority` is **not** consulted — it
governs admission (INV-4), and borrowing it would create a second ordering authority.

### D6 — RBAC: one visible-projects helper, not a fifth copy

The `admin → all non-archived / member → own` branch is inlined **three times**:
`web/lib/queries/portfolio.ts:289`, `:1149`, `web/lib/queries/observatory.ts:907`.
This milestone adds five more cross-project read models. T2.1 extracts one
`getVisibleProjectIds(userId, globalRole)` and re-points the existing copies.

### D7 — Route contracts (identifiers **and** responses)

Identifier labels per the trust-boundary rule, plus the response contract each
route must satisfy — both mirrored in the OpenAPI (T0.9) and asserted by a
contract test.

| Route | Identifiers | Success | Failure |
| --- | --- | --- | --- |
| `/work`, `/activity`, `/` (RSC pages) | user id + role `auth-context`; filters `body-controlled` (querystring, closed sets; an invisible project id is **dropped silently**, never 403 — existence-hiding, matching `handleExt`) | rendered page | redirect to sign-in |
| `GET /api/attention/stream` | user id `auth-context`; `lastEventId` `body-controlled` (non-negative int, clamped) | `200` `text/event-stream`, `id:` per frame | `401` unauthenticated |
| `GET /api/v1/ext/decisions` | owner user id + token kind `auth-context` | `200 {items,count}` | `401` bad token · `403 UNAUTHORIZED` non-global-personal token · `403` scope missing (body never leaks held scopes) |
| `POST /api/activity/cursor` | user id `auth-context`; `seenThrough` `body-controlled`, clamped `<= now()` | `204` | `400 PRECONDITION` future timestamp · `401` |
| `POST /api/push/subscribe` | user id `auth-context`; endpoint + keys `body-controlled`, stored opaque, never parsed for routing | `201` | `400 CONFIG` malformed · `401` |
| ext subscription CRUD | owner from `auth-context` **only**, never the body | `200`/`201`/`204` | `403` cross-owner · `404` unknown id (existence-hiding) |

No `body-controlled` field names a filesystem path or a cross-resource locator the
handler already holds from server state. **Every response is an explicit DTO
projection** — never a DB row, never `acp_session_id`, a supervisor session id, a
worktree path or an internal cost handle.

### D8 — Deployment touchpoints (Phase 7 only)

Phases 0–6 add **no env var, no config file, no sidecar, no bound port** — the
stream's poll interval, heartbeat and quiet-timeout are module constants (as in the
study route), deliberately not env vars, to avoid dev/prod skew for a knob nobody
asked to tune.

Phase 7 does, and T7.9 is its dedicated wiring task:

| Added | Files the task MUST touch |
| --- | --- |
| `MAISTER_VAPID_PUBLIC_KEY` / `_PRIVATE_KEY` / `_SUBJECT` | `.env.example` + the `web` service `environment:` block in `compose.yml`, `compose.production.yml`, `compose.public.yml` + the canonical env table in `docs/configuration.md` |
| `web-push` dependency | `web/package.json` + `pnpm-lock.yaml`, same commit |
| service worker | a route handler (D13) — no new bind mount |

Deliberate deferral requires an explicit "not yet supported in Docker — enable
by …" note in `docs/getting-started.md` **and** `docs/configuration.md`.

### D9 — Contract surfaces → spec files (and the validators that read them)

| Surface | Spec file | Registered in |
| --- | --- | --- |
| `GET /api/v1/ext/decisions`, ext subscription CRUD | `docs/api/external/operations.openapi.yaml` | already in `OPENAPI_FILES` |
| `POST /api/activity/cursor`, `POST /api/push/subscribe` | `docs/api/web.openapi.yaml` | already in `OPENAPI_FILES` |
| `GET /api/attention/stream` (SSE) | **new** `docs/api/async/attention-stream.asyncapi.yaml` | **must be added to `ASYNCAPI_FILES`** — T0.10 |
| `attention.*` event types | `docs/api/async/outbound-webhooks.asyncapi.yaml` | already registered |
| New scopes `decisions:read`, `notifications:subscriptions` | the ext OpenAPI + `web/types/token-scopes.ts` + scope i18n labels | — |
| 3 tables + widened webhook columns | migrations 0162–0164 + `docs/database-schema.md` + `docs/db/*.md` ERD + regenerated `docs/db/erd.dbml` | `db:erd --check` |
| New screens | `docs/screens/desk.md`, `work.md`, `activity.md` + README rows; `inbox.md`, `chrome/left-rail.md`, `chrome/top-nav.md` updated | `validate-docs-indexes` |
| New domains | the four requirement-owning docs + `m51-traceability.md` + README rows | `validate-docs-indexes` (after T0.11) |

**`scripts/validate-contracts.mjs:17-23` holds a hardcoded `ASYNCAPI_FILES` list.**
A new spec file not added to it is never validated and no gate notices — this was a
hole in the first draft. No new `MaisterError` code is introduced: the new paths
raise existing `PRECONDITION`, `UNAUTHENTICATED`, `UNAUTHORIZED`, `CONFIG`, so
`docs/error-taxonomy.md` is untouched.

### D10 — Atomicity, deferreds, two-phase commit

- **Deferreds**: none. Phase 7's sender holds none either — a fire-and-record HTTP
  call through the existing delivery ledger, not a promise another process releases.
- **Two-phase commit applies once**: the notification sender (`NTF-04`, T7.6). DB
  row + downstream HTTP, so intent persists **before** the send and the idempotency
  marker (`delivered_at`) is stamped **after**, with an explicit
  retryable-vs-terminal failure table. This is how `webhook_deliveries` already
  behaves; the task's job is not to regress it.
- **The activity cursor** is a single-row upsert, no side-effect, idempotent and
  monotonic: `seen_through = GREATEST(excluded.seen_through, user_activity_cursors.seen_through)`
  (`ATN-10`), so a replayed or out-of-order request cannot rewind a cursor and
  resurface read items as unread.
- **No multi-store state transition** anywhere, so no crash-window table. T8.1
  re-asserts this against the final diff.

### D11 — What a badge means

*Owner steer*: "показывать нужно то, где нужно участие … баджи должны это
отражать" — a badge says **your participation is required**.

| Badge | Counter | Tone | Asserts |
| --- | --- | --- | --- |
| Inbox | `decisions` | **attention** (amber, existing `data-testid="inbox-nav-badge"`) | "N things are blocked on you" — each answerable, promotable, recoverable or clearable **by you, now** |
| Activity | `updates` | **neutral** | "N things happened you have not seen" — nothing waits on you |

**Nothing non-actionable may wear the attention tone.** Relation-blocked tasks are
the test case (`ATN-04`): they look like they need you and do not. ADR-168 makes
this the rule a future counter must satisfy before claiming a badge.

**i18n mechanics** (project rules, both previously uncited): count-bearing strings
loaded as client templates use **`$count`, not `{count}`** — `intl-messageformat`
treats `{count}` as an ICU variable and **throws** when unsupplied. Token totals in
the digest use **`Intl.NumberFormat(locale)`** from the active `next-intl` locale,
never a fixed `en-US` or a raw integer, with RU-grouped regression coverage.

### D12 — Widening the ADR-077 engine (the "no second outbox" cost)

`emitWebhookEvent` (`web/lib/webhooks/outbox.ts:21-28`) requires `projectId` **and**
`runId`, both `NOT NULL`, and `webhook_subscriptions` has no user axis. A per-user
`attention.digest` has neither. Migration 0164 makes both columns nullable and adds
`webhook_subscriptions.owner_user_id`.

**A column going NULLABLE is a new-value fan-out** (`NTF-02`), so Phase 7 enumerates
every reader as a checklist with one test each: `emitWebhookEvent`, `match.ts`
`subscriptionMatches` (today knows only `projectId`, `null` = platform-wide),
`replay.ts`, `send.ts`, `ping.ts`, the deliveries UI, and the drainer's
fanout/drain/prune passes (`web/lib/scheduler/handlers/webhook-delivery.ts:68`).
**Both directions are tested** (`NTF-03`): a platform-wide subscription must not
match a user event, *and* a user subscription must not match a project event.

The event **source** is a new `domain_events` consumer — one entry in
`web/lib/domain-events/consumers.ts:63` plus a cursor row, no new clock (ADR-086's
own promise).

### D13 — Service-worker hosting

`web/public/` **does not exist** and the app runs behind a custom `server.ts` +
`proxy.ts`. A service worker must be served from the origin root to claim root
scope. Phase 7 serves it from a route handler at `/sw.js` with
`Service-Worker-Allowed: /` and `Content-Type: text/javascript` — keeping it inside
the Next build and out of any new bind mount (D8). T7.3 verifies the **registered
scope** in a real browser context, not just the header.

## Branch and merge policy

*Owner decision*: "коммитить надо будет по фазам, мержить после готовности всего
плана. Промежуточное ничего не нужно, это не точечные фиксы."

- **Commit per phase** — the nine checkpoints are the commit boundaries.
- **No intermediate merge.** The branch stays unmerged until all nine phases pass.
- **Before merging**: rebase onto `master`, then run T8.3 (renumber) and T8.2
  (`validate:docs`) *on the rebased tree*.
- **Merge with `--no-ff`**, both suites green, every requirement green in the matrix.

---

## Phases and tasks

> **Progress convention.** A task id carries `[x]` once its own *Verify* step has
> run green; `[ ]` means not started or not yet verified. The marker sits on the
> task itself — there is no second checklist to drift.

### Phase 0 — Specifications (no application code)

**T0.1 [x] — Reserve the ADR numbers.** `### ADR-168` … `### ADR-172` stubs in
`docs/decisions.md` + five `docs/decisions/adr-1NN.md` records. Re-verify the base
first: `git show master:docs/decisions.md | grep -o '^### ADR-[0-9]*' | tail -1`.
*Verify*: `node scripts/validate-docs-adr-anchors.mjs --all` (bijection + status equality).

**T0.2 [x] — ADR-169: work-stage vocabulary.** D2's four-way collision, D3's full
11-status table, `Intake`/`Delivered` as future members with owning milestones,
`blocked` as an attribute, the no-persisted-column rule. Owns `STG-01..07`.

**T0.3 [x] — ADR-168: two canonical counters.** D4 in full including the worked
double-count example and the no-cursor fallback; D5's ordering; D11's badge rule
and i18n mechanics; the `needsYouCount` freeze; the `needsYou` retirement list.
Restate `social-board.md`'s one-number expectation for **both** counters. Owns
`ATN-01..08`.

**T0.4 [x] — ADR-170: attention SSE stream.** Deviation 2 in full: why no aggregate
stream existed, why the study route's shape is not polling-for-transitions (quote
its header comment), the frame schema, `lastEventId` replay, heartbeat/quiet
bounds, per-user RBAC. Owns `ATN-11`.

**T0.5 [x] — ADR-171: Desk home IA.** `/` → Desk; portfolio → `/projects` unchanged;
rail = Home / Projects / Work / Activity / Inbox / Flow Studio / Observatory +
admin; `/work` as the non-admin member default (**a clause of this decision**, so
`/` never forks by role twice). Record what `/` did before and every inbound link
that moves. Owns `NAV-01..06`.

**T0.6 [x] — ADR-172: notifications.** D12's widening and fan-out; the
`attention.decision_opened | decision_closed | decisions_changed | digest`
taxonomy; `web_push | webhook` delivery axis; per-user ownership; ext parity; the
brief §6 anti-pattern this respects. State the fatigue bound: deltas and digests
only. Owns `NTF-01..10`.

**T0.7 [x] — `work-stages.md` + `attention.md`.** R5's seven sections **in order**;
`stateDiagram-v2` of D3; **Expectations carry `STG-`/`ATN-` ids** and stay ≤ 12
per doc; **Edge cases carry `EDGE-` ids**; every bullet names its enforcement
mechanism — a MUST with no mechanism is rewritten or given one. R6 status tags.

**T0.8 [x] — `home-navigation.md` + `notifications.md`.** Same structure, owning
`NAV-` and `NTF-`. `home-navigation.md` is new relative to the first draft (see
"Requirement IDs"). Index rows in `docs/system-analytics/README.md`.
*Note (do not fix)*: `social-board.md` already carries **24** Expectations bullets,
over R5a's cap — the validator applies the cap only to registered document sets, so
it is green. Pre-existing; filed in T8.5.

**T0.9 [x] — Screens docs, `desk.md` first.** Per brief §7 the Desk layout is settled
on the mockup and **`docs/screens/desk.md` is the contract, written before its
components**: JTBD, regions in mockup order (composer → Now tiles → Decisions →
Work in flight → Activity → digest in the header), three states (busy / quiet /
empty), narrow behaviour (Decisions → Work → Activity). Plus `work.md` and
`activity.md`, all three on the 9-section template, with **index rows in
`docs/screens/README.md`** (`| Doc | Screen / chrome | Route | Status |`) —
hard-gated, scanned recursively. Update `inbox.md` (new sections + both counters,
replacing its five verbatim `needsYou` claims), `chrome/left-rail.md` (both badges,
D11), `chrome/top-nav.md` (the Desk | Projects switch).

**T0.10 [x] — API specs, and register the new one.** Every D9 spec row. The ext
decisions + subscription ops modelled on `extListHitlInbox` (global-personal-token
403, the ADR-137 `decision_request` omission); the new attention-stream AsyncAPI;
`attention.*` types added to the outbound-webhooks AsyncAPI; the three tables into
`docs/database-schema.md` **and** the `docs/db/*.md` Mermaid ERD (updating one is
not updating the other), with **exact DDL** — column types, constraint names, index
names — so the migration implements the spec rather than becoming it.
**Add `docs/api/async/attention-stream.asyncapi.yaml` to `ASYNCAPI_FILES` in
`scripts/validate-contracts.mjs`**, and add a `validateAttentionStreamContract`
assertion function beside `validateM43WebContract` /
`validateExecutionHostEventContract`.
*Verify*: `pnpm validate:contracts` fails when the new spec is malformed — prove it
by temporarily breaking the file (RED), then fixing it (GREEN).

**T0.11 [x] — Extend `validate-docs-indexes.mjs` to enforce M51's requirement IDs.**
Today `validateStageBAnalytics` hardcodes four documents
(`STAGE_B_DOCUMENTS`) and four prefixes (`EVT|PRM|OBJ|CUT`, `:67`/`:73`).
**Generalize it (DRY) into `validateAnalyticsGroup({documents, prefixes,
traceabilityFile})`** and call it twice — once for Stage B (unchanged behaviour),
once for M51's four docs, prefixes `STG|ATN|NAV|NTF`, traceability
`m51-traceability.md`. Extend `scripts/validate-docs-indexes.test.mjs` accordingly.
*RED*: add the M51 group before the docs exist and watch it fail with
"missing M51 analytics document"; then T0.7/T0.8 turn it green.
*Verify*: `node --test scripts/validate-docs-indexes.test.mjs`; Stage B's existing
failures/passes are unchanged (a regression case pins this).

**T0.12 [x] — `m51-traceability.md` + the coverage gate.** The five-column matrix for
every `STG`/`ATN`/`NAV`/`NTF`/`EDGE-*` id, with `Contract/schema`,
`Enforcement/task`, `Primary test` (a real `UT-`/`IT-`/`CT-`/`E2E-` name) and
`Status` (`Planned` until its phase turns it green). Index row in
`docs/system-analytics/README.md`. **Bidirectional gate**: a script or a documented
grep proving every requirement has ≥ 1 task and every task names ≥ 1 requirement.
*Verify*: the validator reports no "missing traceability row with primary test".

**T0.13 [x] — Open M51, close M45 (`.ai-factory/ROADMAP.md`).** One
`- [ ] **M51. See everything**` entry — **no a/b sub-slices**. **M50 is taken**;
verify with `grep -o '\*\*M[0-9]\+\.' .ai-factory/ROADMAP.md | grep -o '[0-9]\+' | sort -n | tail -1`
before writing, exactly as ADR numbers are checked. Mark M45 `- [x]` with a
`## Completed` row stating the closure's basis in words — evidence, or "closed by
owner decision 2026-09-10 without the stated qualification run set".
*Verify*: exactly one unchecked milestone remains, and it is M51.

**T0.14 [x] — Phase 0 exit gate.** `pnpm validate:docs` **and** `pnpm validate:contracts`
green; the M51 requirement group is enforced (T0.11) and fully traced (T0.12).
Anything a later task needs that the specs do not state is a spec bug fixed **here**.

> **Checkpoint 1** — `docs(m51): specify stages, counters, navigation and notifications with enforced requirement IDs (ADR-168..172)`

---

### Phase 1 — The stage classifier · `STG-01..07`, `STG-10`

**T1.1 [x] — `deriveWorkStage`.** *RED*: write
`web/lib/work/__tests__/stage.test.ts` (`UT-STG-01..06`) against a not-yet-existing
`web/lib/work/stage.ts`; the cross-product test must fail on a **missing mapping
assertion**, not a module-not-found — so stub the module with a `throw` first.
*GREEN*: implement
`deriveWorkStage(input): { stage, blocked, progress, promotedKind }` over
`{ taskStatus, taskStage, triageStatus, runStatus, runKind, promotionState, workspaceRemoved, blockingRelationCount, progress }`,
with the status axis an exhaustive `satisfies Record<RunStatusValue, …>` map so a
12th status is a **compile error**. Pure — no DB, no clock, no `server-only`
(`STG-02`).
*REFACTOR*: extract the triage/relation axis if the branch nesting exceeds two
levels; keep one exported function (KISS).
*Tests*: `UT-STG-01` full cross-product `RUN_STATUS_VALUES × task status ×
{null,triaged,flagged} × {blocked,not} × {workspaceRemoved,not}` asserting a
defined `WorkStage` for every cell — exhaustiveness, not sampling. `UT-STG-03`,
`UT-STG-04`, `UT-STG-05`, `UT-STG-06` are the named cases the brief omitted, one
test each, no overlap with the cross-product's generic assertion.
`EDGE-STG-01..03` get one test each.

**T1.2 [x] — i18n + chip · `STG-10`.** *RED*:
`web/lib/__tests__/i18n-work-stage-keys.test.ts` (`UT-STG-10`) asserting every
member has EN and RU keys **with distinct copy** (a byte-identical EN/RU pair is a
latent bug). *GREEN*: `workStage` namespace in both catalogs +
`<WorkStageChip>` in `web/components/work/work-stage-chip.tsx`, icon-first with
`aria-label` when icon-only, mounted **beside** the node `StageChip` on the board flight
card — a key with no render site is not done.
*Deviation (execution, 2026-09-10)*: the **inbox-card mount moves to T4.4**. Every
pending HITL item is by definition `NeedsInput | NeedsInputIdle | HumanWorking`,
all of which map to `WaitingOnHuman`, so on today's HITL-only `/inbox` the chip
would be a constant — noise, not information. T4.4 adds the *Ready to promote*,
*Crashed* and *Held* sections, at which point the chip varies across all four
populations and starts earning its place. The i18n keys are consumed by the board
mount, so `STG-10` is satisfied here.
*REFACTOR*: one label lookup, no per-call-site switch.

**Pre-existing integration red, quarantined at Phase 1 (2026-09-10).** The phase-exit
rule says a pre-existing red surfaced by a phase is quarantined with a reason and a
tracked follow-up. Measured, not assumed: the four Phase 1 production/i18n edits were
reverted, the failing files re-run at that baseline, and the changes restored.

| File | Failing | Verdict |
| --- | --- | --- |
| `lib/flows/graph/__tests__/evidence-readiness-all-blocking-kinds.integration.test.ts` | 4 | **Pre-existing** — identical at baseline. Three cases label themselves `RED: today returns true`, i.e. committed as known-red |
| `lib/services/__tests__/hitl-hook-trip.integration.test.ts` | 3 | **Pre-existing** — identical at baseline |
| `lib/flows/__tests__/runner.integration.test.ts` | 1 | **Pre-existing** — identical at baseline |
| `app/api/runs/[runId]/takeover/__tests__/takeover-resume.integration.test.ts` | 1 | **Flaky under full-suite load** (an ~11 s async resume/respawn case). Passes 2/2 isolated at baseline AND with the Phase 1 changes applied |

**Phase 1 caused none of them.** No failing file imports `lib/queries/board`,
`lib/work/stage`, `components/board/**` or the message catalogs, and
`lib/queries/board` has only six importers, none on these paths. Unit suite is fully
green (746 files / 7574 tests). Follow-up is **T8.6**.

> **Checkpoint 2** — `feat(work): derive a canonical work stage (ADR-169, STG-01..07)`

---

### Phase 2 — Cross-project read-model spine · `STG-08..09`

**T2.1 [ ] — `getVisibleProjectIds`.** *RED*:
`web/lib/queries/__tests__/visible-projects.integration.test.ts` (`IT-STG-09`) — a
**positive grant** (a member sees exactly their own projects, rows non-empty) plus a
negative (a foreign project absent). Deny-only tests cannot distinguish "correctly
refused" from "broken". *GREEN*: `web/lib/queries/visible-projects.ts`; re-point
`portfolio.ts:289`, `portfolio.ts:1149`, `observatory.ts:907` (DRY — the fourth and
fifth copies never get written). *REFACTOR*: the three migrated call sites keep
their existing tests green — name them in the task and re-run.

**T2.2 [ ] — Batched token totals.** *RED*: an equivalence test — for a seeded set the
batched map equals `queryTaskTokens` per id, and `[]` issues no query. *GREEN*:
`queryTokensByTaskIds(taskIds): Promise<Map<string, number>>` beside
`queryTaskTokens` in `web/lib/runs/cost-rollups.ts`, sharing `baseTokenSumExpr` and
`foldTokenRows` so per-task and batched totals cannot disagree (DRY).

**T2.3 [ ] — Cross-project promotable.** *RED*: a two-project fixture asserting exactly
**one** `computeReadinessByRun` invocation (spy). *GREEN*: split
`web/lib/ext-activity/promotable.ts` into candidate-loader + classifier so
`listPromotableForProjects(projectIds)` runs one bulk readiness pass;
`listProjectPromotable(projectId)` stays a thin wrapper, callers and tests
untouched (SOLID — the classifier stops knowing how rows are fetched).
**Layer 2 must survive**: the `promotionHold` exclusion and the
`launchedLineageRunIds` evaluation-study exclusion (`promotable.ts:169`) are
deliberately more aggressive than `promoteRun`'s own checks — dropping either would
recommend promoting a run an operator has held. The `workspaces.run_id` de-dup (no
UNIQUE on that column) must also survive; both get a regression case.

**T2.4 [ ] — Crashed and Held queries.** *RED*: a **redaction proof at the mapping
function** — feed the mapper a row that actually contains `acpSessionId` and assert
the output's exact key set and that its JSON has no session id. A test fed an
already-safe DTO literal is vacuous. *GREEN*:
`listCrashedForProjects(projectIds)` projecting `crashActionFor`
(`web/lib/board.ts:171`); `listFlaggedForProjects(projectIds)` for
`triage_status='flagged'`. Both `recover` and `discard` covered.

> **Checkpoint 3** — `refactor(queries): one visible-projects helper and batched cross-project read models`

---

### Phase 3 — `/work` · `STG-08..09`

**T3.1 [ ] — `getWorkTable`.** *RED*: `IT-STG-08` asserting the total query count is
**constant** as the fixture grows from 1 project/2 tasks to 3 projects/12 tasks —
the anti-N+1 guarantee as a test, not a comment. *GREEN*:
`web/lib/queries/work-table.ts` — `getVisibleProjectIds` → one batched
task+latest-run query (the board's batching, not its per-project scope) → one
`computeReadinessByRun` → one batched `node_attempts` read through
`buildFlightProgress` → `queryTokensByTaskIds` → blocking relations →
`deriveWorkStage`. Includes pre-flight stages (`Triage`, `Held`, `Ready`).
*Logging*: one `debug` per call — row count, project count, elapsed ms.

**T3.2 [ ] — Route and table.** `web/app/(app)/work/page.tsx` + a client table.
Full-width per the data-management pattern (drop `mx-auto max-w-*`, `min-w-*` +
`overflow-x-auto`, responsive `md:`), **view-only** rows, URL-synchronized filters
via a plain `<form action="/work">` in the `/runs` idiom. Columns: `KEY-N` · title ·
project · stage (progress spine) · run dot · readiness · waiting-on (role or "you",
age) · blockers (KEY-N chips) · tokens · last activity · next action. Grouping by
project / stage / mine; saved views per Deviation 4. Token counts via
`Intl.NumberFormat(locale)`; count strings use `$count`.

**T3.3 [ ] — Rail entry + i18n.** All four rail files or the nav highlights the wrong
item: `RAIL_SECTION_IDS` (`left-rail-route.ts:1`), `railSectionForPathname` (`:27`),
`buildLeftRailSections` (`left-rail-sections.ts:15`), `sectionIcons`
(`left-rail-nav.tsx:44`). New `work` namespace EN + RU; **do not reuse
`nav.activity`**, already the board's Activity *tab* label
(`web/components/board/project-tabs.tsx`). *Verify (`unit`)*: a page-contract test
in the `observatory/__tests__/page-contract.test.ts` shape.

**T3.4 [ ] — e2e `E2E-STG-09`.** `web/e2e/work-table.spec.ts` + a `byKey.work` fixture
in `e2e/_seed/seed-e2e.ts` + a type in `e2e/_seed/fixtures.ts` + the basename in
`AUTHED_SPEC` (`web/playwright.config.ts:30`) — **without that entry the spec
silently never runs**. Admin sees two projects' rows; a member only their own;
filter and group round-trip through the URL; a saved view restores.

> **Checkpoint 4** — `feat(work): cross-project work table at /work (E1, STG-08..10)`

---

### Phase 4 — Decision queue, counters, ext parity · `ATN-01..08`

**T4.1 [ ] — `getDecisionsQueue` / `getDecisionsCount`.** *RED*: `IT-ATN-01` asserting
`count === list.length` across a fixture holding all four kinds, and `IT-ATN-04`
asserting a relation-blocked task appears in neither counter. *GREEN*:
`web/lib/queries/decisions.ts` unioning T2.3/T2.4 with `getCrossProjectHitlInbox`,
ordered per D5. **Count and list come from one query** — a count that can disagree
with its list is exactly the bug the one-number rule exists to prevent.
*Tests*: `UT-ATN-07` covers ordering as a pure comparator, not through the query.

**T4.2 [ ] — `getUpdatesCount`.** *RED*: `IT-ATN-02` — a task with one comment
mentioning the user yields `updates === 1`, **not** 2; and `IT-ATN-03` — a user with
no cursor row counts only the bounded 24 h window. *GREEN*:
`web/lib/queries/updates.ts` implementing D4's `MINUS` via
`inbox_items.source_ref->>'activityId'`. `EDGE-ATN-02` (membership change) gets one
test pinning the documented behaviour.

**T4.3 [ ] — Retire `needsYou`.** Every consumer from `grep -rn "needsYou"`:
**delete** `web/lib/queries/needs-you.ts` (not a deprecated alias — a second way to
compute a canonical number is the drift this milestone removes) ·
`web/app/(app)/layout.tsx:51,86,97` (Inbox → `decisions`, Activity → `updates`,
wired T5.7) · `web/app/(app)/page.tsx:25-30,47,77,94-100` ·
`web/app/(app)/inbox/page.tsx:23-28,40,44` ·
`web/app/(app)/projects/[slug]/page.tsx:224-230` (project-scoped `decisions`) ·
`web/lib/queries/portfolio.ts:718` (`pendingHitlCount`).
**Not touched**: `web/lib/ext-activity/**` and
`web/app/api/v1/ext/activity/route.ts:63-67` — `needsYouCount` is a frozen contract.
*Tests*: `IT-ATN-05` asserts every migrated surface reads the **same**
`getDecisionsCount` value (equality across surfaces, not per-surface correctness);
`CT-ATN-06` pins the ext pulse's unchanged shape; a grep assertion proves no
`needsYou` identifier survives outside the two exempt paths.

**T4.4 [ ] — `/inbox` sections.** Three sections on the existing `HitlCard` shell
(`web/components/inbox/hitl-card.tsx`): *Ready to promote*, *Crashed — recover or
discard*, *Held — flagged*. Inline actions route to the **existing** promote /
recover / discard endpoints; no new mutation path.
Also **mount `<WorkStageChip>` on the inbox card here** (moved from T1.2): with
four populations on the page the chip finally varies, so it distinguishes
`WaitingOnHuman` from `Review`, `Crashed` and `Held` at a glance. The empty state appears only when
`decisions === 0` across all four sections.

**T4.5 [ ] — `GET /api/v1/ext/decisions`.** *RED*: `IT-ATN-08` asserting a
`decision_request` row is absent from the response, plus a **positive grant** (a
global personal token with `decisions:read` receives its own items) and the
negatives (project token 403, agent token 403, project-scoped user token 403, `*`
grants — `decisions:read` is not in `EXACT_ONLY_SCOPES`). *GREEN*:
`web/app/api/v1/ext/decisions/route.ts` via `handleExt`, copying
`web/app/api/v1/ext/hitl/route.ts`: `allowGlobalActorWithoutProject: true`, refuse
unless `tokenKind === "user" && ownerUserId !== null && projectId === null`. New
scope `decisions:read` in `web/types/token-scopes.ts` and the scope i18n labels;
**deliberately absent** from `AGENT_TOKEN_SCOPES` and `CROSS_PROJECT_AGENT_SCOPES`
(`UT-NTF-09` covers both scopes) — an agent must not read a human's decision queue.
Respond paths unchanged: `respondToHitl` (`web/lib/services/hitl.ts:5953`) keeps the
human-only enforcement. *Contract*: `CT-ATN-06`-style assertion that the response
matches the T0.10 OpenAPI example exactly — no extra keys.

> **Checkpoint 5** — `feat(inbox): complete decision queue and two canonical counters (ADR-168, ATN-01..08)`

---

### Phase 5 — Activity, cursor, digest queries, stream · `ATN-09..12`

Phase 5 ships **read models and the stream**. The Now tiles and the digest
*sentence* have no host page until the Desk exists, so their components live in
Phase 6 — a component with no render site cannot be e2e-tested, and shipping one
would violate the project's own "a key is done only when something consumes it".

**T5.1 [ ] — Migration 0162 `user_activity_cursors`.** DDL exactly as specified in
T0.10: `user_id text PK REFERENCES users(id) ON DELETE CASCADE`, `seen_through
timestamptz NOT NULL`, `updated_at timestamptz NOT NULL DEFAULT now()`. New table
over live data — no backfill and no abort-guard needed; an absent row means "never
looked", the correct seed (a constant default would be the "looks populated but
isn't" trap that permanently excludes pre-migration rows). The migration is a
**triple** — SQL + `_journal.json` entry + `meta/0162_snapshot.json` — and
`schema.ts` is its fourth leg: the task ends with `pnpm --filter maister-web
db:generate` reporting **"No schema changes"**.
*Verify*: `db:migrate` on a clean DB; **`pnpm --filter maister-web db:erd --check`
green** after regenerating `docs/db/erd.dbml`.

**T5.2 [ ] — Cross-project activity feed · `ATN-09`.** *RED*: `IT-ATN-09`, a redaction
test asserting no field of any feed row matches a worktree-path or diff-hunk shape,
fed rows that actually contain them. *GREEN*:
`web/lib/queries/activity-feed.ts` — a union over `task_activity` (13 kinds),
`domain_events` `run.*` + `gate.failed` (13 kinds,
`web/lib/domain-events/taxonomy.ts:5`), `run_pr_merged`, and webhook **delivery
outcomes** (not payloads), scoped by `getVisibleProjectIds`.
*Note*: `run_finished` is still not a `task_activity` kind; run terminal transitions
come from the `domain_events` side — which is why the union exists rather than a new
activity kind (that needs the `setRunStatus` choke point, out of scope).

**T5.3 [ ] — `/activity`, cursor, unread divider · `ATN-10`.** *RED*: `IT-ATN-10` —
a stale or out-of-order cursor POST cannot move `seen_through` backwards; and a
future `seenThrough` is refused `PRECONDITION` (D7). *GREEN*:
`web/app/(app)/activity/page.tsx` with project / actor-type / kind / mine filters
(URL-synchronized), the "your last visit" divider, and `POST /api/activity/cursor`
performing the monotonic `GREATEST` upsert. Rail section + `activityFeed` namespace
(**not** `nav.activity`), extending the same four rail files as T3.3.

**T5.4 [ ] — Now-tile and digest read models · `ATN-12`.** *RED*: `UT-ATN-12` — the
digest is byte-identical given a fixed clock and row set; a token total renders
RU-grouped under the `ru` locale (`Intl.NumberFormat`). *GREEN*:
`web/lib/queries/digest.ts` and `getNowTileCounts` — pure/read-only, since the
cursor or a 24 h fallback: promoted · crashed · new decisions · new events · tokens
spent, each with a link target. **Queries only — no components** (see the phase
note). No agent, no narration, no USD. Determinism is what later makes this a safe
notification payload (T7.7).

**T5.5 [ ] — Attention SSE stream · `ATN-11`.** *RED*: `IT-ATN-11` — a user receives no
frame referencing a project outside `getVisibleProjectIds`; `lastEventId` replays
the tail without duplicating (`EDGE-ATN-04`); an aborted request closes the stream.
*GREEN*: `web/app/api/attention/stream/route.ts` on the study route's shape —
`requireActiveSession()`, `parseLastEventId` (header then query), a server-side
read-model poll pushed as SSE, a heartbeat, and a `MAX_QUIET_MS` cap that closes an
idle stream rather than holding it forever. Client hook
`web/lib/use-attention-stream.ts` follows `useRunStream`'s `retain: false` idiom — a
"something changed" tick that triggers a refetch, never an accumulated log. The
stream **never mutates persisted run state**.
*REFACTOR*: if the poll body duplicates the study route's frame formatting, extract
the shared SSE framing helper rather than copying it (DRY).

**T5.6 [ ] — Wire `/work` and `/activity` to the stream.** Replace load-time-only
freshness with an SSE-triggered refetch; no timers. Surfaces show the accessible
liveness pill + reconnect affordance (`<RunStreamLiveness>`'s pattern).

**T5.7 [ ] — Both rail badges · `ATN-05`, D11.** Inbox → `decisions` (amber, existing
`data-testid="inbox-nav-badge"`); Activity → `updates` (**neutral**,
`data-testid="activity-nav-badge"`), in the collapsed (`<CollapsedRailBadge>`) and
expanded variants and the mobile drawer. `web/app/(app)/layout.tsx` computes both
once and passes them down — neither badge recomputes its own number. Count strings
use `$count`.
*Verify (`unit`)*: distinct tones from one layout-level fetch; the neutral badge
carries no attention styling class.

**T5.8 [ ] — e2e `E2E-ATN-10`.** `web/e2e/activity-feed.spec.ts` (+ fixture +
`AUTHED_SPEC` entry): the unread divider appears and a cursor POST clears it, and
the **badge-independence** case — answering the last decision clears the amber badge
while the neutral one is untouched. That is the only end-to-end proof the two
counters are separate populations rather than one number rendered twice.
*(The tile-vs-badge assertion moves to Phase 6, where a page renders a tile.)*

> **Checkpoint 6** — `feat(attention): activity stream, read cursor and digest read models (A1/A2/A5, ATN-09..12)`

---

### Phase 6 — The Desk · `NAV-01..06`

Everything the Desk renders now exists. This phase composes it **once**.

**T6.1 [ ] — Move the portfolio to `/projects` · `NAV-03`.**
`web/app/(app)/page.tsx` → `web/app/(app)/projects/page.tsx`, behaviour unchanged.
The segment already exists with `[slug]/` and `new/` but **has no `page.tsx`**, so
`/projects` currently 404s — this fills it rather than displacing anything. Its
`@/components/portfolio/*` tree moves with it.
*Verify (`E2E-NAV-03`)*: `/projects` renders exactly what `/` rendered before,
onboarding checklist and empty state included.

**T6.2 [ ] — Audit every inbound `/` link · `NAV-05`.** *RED*: `UT-NAV-05`, a table test
over every `href="/"`, `redirect("/")` and `router.push("/")` call site asserting
its intended destination. There are **four** `href="/"` sites today
(`(auth)/layout.tsx:29`, `feedback/error-fallback.tsx:52`, `chrome/top-nav.tsx:47`,
plus one test assertion); all three real ones mean "home" and stay on `/`. Server
actions and e2e specs are swept in the same task — a post-registration redirect
means the *portfolio*, and getting that backwards is silent.

**T6.3 [ ] — The Desk page · `NAV-01`.** `web/app/(app)/page.tsx` laid out per
`docs/screens/desk.md` (T0.9) and the mockup: composer (the existing scratch
launcher — **Idea mode is a later milestone** and is not stubbed) → Now tiles →
Decisions with inline actions → Work in flight (full width on desktop) → Activity
(beside Decisions on desktop, last on narrow) → the digest sentence in the header.
Mounts `<NowTiles>` (`web/components/attention/now-tiles.tsx`) and the digest
sentence over T5.4's read models; reuses the decision-queue sections and the work
table's row component — **the Desk composes, it does not re-implement** (DRY).

**T6.4 [ ] — Desk states · `EDGE-NAV-01..02`.** Busy, quiet, empty. Empty reuses the
first-run onboarding checklist and the empty-state card inside the Desk frame; the
composer is absent until a project exists. Narrow stacks Decisions → Work →
Activity.
*Verify (`E2E-NAV-01`)*: all three states at desktop 1440 and narrow 390, plus the
tile-vs-badge equality moved here from Phase 5.

**T6.5 [ ] — Rail re-cut + Desk | Projects switch · `NAV-04`.** *RED*: `UT-NAV-04`, a
table test over every route prefix asserting the section it highlights — including
the four that currently collapse onto `projects`: `railSectionForPathname` maps `/`,
`/projects`, `/runs` and `/scratch-runs` to `"projects"`
(`left-rail-route.ts:32-39`), and `/` must now resolve to `home`. *GREEN*: rail
becomes Home / Projects / Work / Activity / Inbox / Flow Studio / Observatory +
admin across the same four files as T3.3, plus `nav.*` i18n EN + RU and the
Desk | Projects control per `chrome/top-nav.md`.

**T6.6 [ ] — `/work` as the member default · `NAV-02`, `NAV-06`.** Non-admin members land
on `/work`; admins land on the Desk — one routing clause of ADR-171, applied here so
`/` never forks by role twice. *Verify*: `E2E-NAV-02` (a member and an admin land on
different routes from the same sign-in flow) and `IT-NAV-06` (nav hiding is not the
authorization boundary — a member requesting an admin route is refused server-side
regardless of what the rail renders).

> **Checkpoint 7** — `feat(desk): the Desk becomes home and the portfolio moves to /projects (ADR-171, NAV-01..06)`

---

### Phase 7 — Web push and notification subscriptions · `NTF-01..10`

**T7.1 [ ] — Migration 0163: `push_subscriptions` + `notification_subscriptions`.**
DDL exactly as T0.10 specifies, including constraint names. Per-user rows; secrets
as `env:` refs only (`NTF-06`), matching `webhook_subscriptions.signing_secret_ref`.
Same migration-triple + `db:generate` "No schema changes" discipline as T5.1.
*Verify*: `db:erd --check` green.

**T7.2 [ ] — Migration 0164: widen the ADR-077 tables (cross-cutting, own number).**
*RED*: `EDGE-NTF-03` — existing project/run-scoped webhooks still fan out and
deliver unchanged; this is the regression that matters. *GREEN*:
`webhook_events.run_id` and `.project_id` → nullable;
`webhook_subscriptions.owner_user_id` added. **Live data is preserved** — this
widens, never drops.
*Verify*: `db:erd --check` green.

**T7.3 [ ] — Service worker at `/sw.js` (D13).** Route handler with
`Service-Worker-Allowed: /` and `Content-Type: text/javascript`.
*Verify*: the **registered scope** is `/` in a real browser context, asserted in the
Playwright spec — not merely the response header.

**T7.4 [ ] — Fan out the nullable widening · `NTF-02`, `NTF-03`.** *RED*: `IT-NTF-02`, a
per-reader table with one case each feeding a user-scoped (project-less, run-less)
event to `emitWebhookEvent`, `match.ts` `subscriptionMatches`, `replay.ts`,
`send.ts`, `ping.ts`, the deliveries UI, and the drainer's fanout/drain/prune passes
(`web/lib/scheduler/handlers/webhook-delivery.ts:68`). A reader that structurally
never sees a NULL row is the defect shape. `IT-NTF-03` covers **both directions**: a
platform-wide subscription must not match a user event, and a user subscription must
not match a project event.

**T7.5 [ ] — The `attention.*` domain-event consumer · `NTF-08`, `EDGE-NTF-01`.**
*RED*: `EDGE-NTF-01` — at-least-once redelivery converges to one notification.
*GREEN*: one entry in `web/lib/domain-events/consumers.ts:63` plus a cursor row — no
new clock (ADR-086's own promise). Idempotent `handle`. Emits
`attention.decision_opened | decision_closed | decisions_changed | digest`.

**T7.6 [ ] — The sender (two-phase commit, D10) · `NTF-04`, `NTF-05`.** *RED*:
`IT-NTF-04` — a send failure leaves the row retryable with `delivered_at` still
null; a success stamps it. `IT-NTF-05`/`EDGE-NTF-02` — a `410 Gone` deletes the
subscription. *GREEN*: persist intent **before** the send, stamp `delivered_at`
**after**, with an explicit failure table (4xx / 5xx / network / expired
subscription) naming per row the HTTP result, whether the row stays retryable or
goes terminal, and what mutates on retry. Reuses the existing HMAC, backoff curve
and delivery log (DRY — no second engine).

**T7.7 [ ] — Triggers · `NTF-08`.** Fire on a `decisions` delta and on the digest.
**Never a per-event stream by default** (brief §6 fatigue bound, restated in
ADR-172). The digest payload is T5.4's deterministic sentence.

**T7.8 [ ] — Opt-in UI + ext subscription ops · `NTF-07`, `NTF-09`.** *RED*:
`IT-NTF-07` — a **positive grant** plus a cross-owner negative: token A cannot read,
modify or delete owner B's subscriptions. `UT-NTF-09` — `decisions:read` and
`notifications:subscriptions` are absent from `AGENT_TOKEN_SCOPES` and
`CROSS_PROJECT_AGENT_SCOPES`. *GREEN*: per-user opt-in on `/account`; ext CRUD under
`/api/v1/ext`. The owner comes from `auth-context`, **never the body** (D7). EN + RU.

**T7.9 [ ] — Deployment wiring (D8) · `NTF-10`.** The three VAPID vars into
`.env.example` **and** the `web` service `environment:` block of `compose.yml`,
`compose.production.yml`, `compose.public.yml`, **and** the canonical env table in
`docs/configuration.md`. `web-push` in `web/package.json` with `pnpm-lock.yaml`
committed in the same change.
*Verify (`IT-NTF-10`)*: a boot with the vars unset degrades to "push unavailable"
with a clear log line — it does not crash the web process.

**T7.10 [ ] — e2e (mocked push).** Opt-in flow, a delivered notification, revocation.

> **Checkpoint 8** — `feat(notifications): web push and user subscriptions over the widened ADR-077 engine (ADR-172, NTF-01..10)`

---

### Phase 8 — As-built reconciliation

**T8.1 [ ] — Re-derive the contract list from the diff.** Walk D9 against
`git diff master...HEAD` and confirm each surface's spec moved with it. Assert D10
by diff: the only two-phase commit is T7.6's sender; no new deferred; no new
multi-store transition.

**T8.2 [ ] — `pnpm validate:docs` + `validate:docs:all` + `pnpm validate:contracts`.**
All green. For the record: `validate:docs` is **not** wired into
`.github/workflows/ci.yml`, and the Stop hook `docs/CLAUDE.md` describes lives in a
`.claude/settings.json` that does not exist in this repo — so these gates are
local-only and must actually be run, not assumed.

**T8.3 [ ] — Renumber pass (mandatory).** Its own focused session, **after** rebasing
onto master. Re-derive the next free ADR from `git show master:docs/decisions.md`
and the next free migration idx from master's `_journal.json`; renumber if a
parallel branch landed first; grep prose forms (`pre-ADR-168`, `since 0162`) and
prefer number-agnostic phrasing. Re-run `validate-docs-adr-anchors.mjs --all`.
Re-check **M51** too — a milestone that landed meanwhile takes the number the same
way an ADR does.

**T8.4 [ ] — Close the traceability matrix.** Flip every `Status` cell from `Planned` to
its verified state, and **grep every `Primary test` cell against the suite**, failing
if a name does not resolve to a real test. The existing Stage B matrix decayed into
"historical scenario aliases, not executed test names"; this task is what stops M51's
matrix going the same way. Confirm the bidirectional gate (T0.12) still holds after
whatever the phases actually changed.

**T8.6 [ ] — Resolve or re-classify the quarantined integration reds.** The eight
pre-existing failures recorded at Checkpoint 2 (`evidence-readiness-all-blocking-kinds`
4, `hitl-hook-trip` 3, `runner` 1) plus the `takeover-resume` full-suite flake. For each:
fix it, or re-classify it as intentionally-red with a dated note naming what would make
it green. Three of them already self-label `RED: today returns true`, so they are
assertions of a known gap rather than breakage — that gap needs an owner, not a
deletion. The merge criterion is that no red is *unexplained*, and that none of them is
M51's. Re-measure on the rebased tree, since the baseline moves with master.

**T8.5 [ ] — Backlog, PRODUCT_VIEW, and adjacent-defect notes.**
`.ai-factory/ROADMAP.md` backlog §A1 (the human-facing digest now exists; the
ADR-123 standup-digest agent stays reserved for a v1 narration).
**`docs/PRODUCT_VIEW.md`: write into §Phase 2 item 5 "Observability and attention
routing" (`PRODUCT_VIEW.md:248-254`) — do NOT create a §Phase 2.5.** That item is
verbatim this work: "one summary that answers: what changed, what passed, what
failed, what is stale, and **what needs a human**" is the digest plus the decision
queue; "Web UI notifications first" is Phase 7; "Project/team inbox expansion" is
B1. Tag shipped bullets `(Implemented — ADR-168…172)` per R6.
File as TODOs at the bottom of `docs/decisions.md` (R9 — do **not** fix here):
(a) a dead 12-entry `WebhookEventType` union at `web/lib/db/schema.ts:6940` with
zero importers; (b) `social-board.md`'s 24 Expectations bullets vs R5a's cap of 12;
(c) `docs/pv/improvement-roadmap.md` cites a `PRODUCT_VIEW.md §Phase 2.5` that does
not exist.
**Fix here, because Phase 7 makes it ours**: `WEBHOOK_EVENT_TYPES` is already **18**,
not the "16" claimed in `docs/decisions/adr-077.md`,
`docs/system-analytics/outbound-webhooks.md:198` and
`docs/api/async/outbound-webhooks.asyncapi.yaml:16-19` — and Phase 7 adds four
`attention.*` types on top. Correct the count in all three places.

> **Checkpoint 9** — `docs(m51): reconcile the specs with the shipped code and close the traceability matrix`

---

## Owner decisions (2026-09-10)

| # | Question | Decision | Where |
| --- | --- | --- | --- |
| 1 | Split into two plans? | **No — one plan, phased internally** | this document |
| 2 | Milestone: open one, or ship against backlog §A1? | Close M45; this is next. **M50 was taken**, so **M51**, no `a`/`b` | Roadmap Linkage · T0.13 |
| 3 | `PRODUCT_VIEW §Phase 2.5` does not exist — create it? | No. §Phase 2 item 5 is verbatim this functionality | T8.5 |
| 4 | Five ADRs instead of one (R4)? | Approved | D1 |
| 5 | `Delivered` / `Intake`: reserve or add when reachable? | Add when reachable; the plan reflects the order of work | D3 · `STG-06` |
| 6 | Activity badge — when? | Badges show where **participation is required**: Inbox `decisions` (attention), Activity `updates` (neutral) | D11 · T5.7 |
| 7 | `/work` as the member default — where? | Phase 6, a clause of ADR-171, so `/` never forks by role twice | T6.6 · `NAV-02` |
| 8 | Merge early to dodge the renumber? | No. Commit per phase, merge when the whole plan is done | Branch and merge policy · T8.3 |
| 9 | Live refresh with no aggregate stream? | A user-scoped attention SSE route on the study route's shape | Deviation 2 · T5.5 |
| 10 | "No second outbox" vs. run-scoped webhook tables? | Widen the ADR-077 engine; enumerate every reader of the nullable columns | D12 · T7.2 · T7.4 |

Nothing is open. One thing to keep honest in execution: **T0.13's M45 closure records
a basis, not just a checkmark** — see the Roadmap Linkage note.
