# Implementation Plan: Compact long USER messages in run transcripts

- Branch: `maister/task-868ce957-8a47-44fa-9975-ceb4503493c0/attempt-1` (prepared by MAIster; no branch/worktree operations).
- Base branch HEAD inspected: `master` at `8c92a60fee36480937ae8f432bdb72ebf86f5cee`.
- Plan mode: full; status: implementation-ready, subject to flow review.
- Numbered artifacts: ADR none; SQL migration/journal/snapshot none. This presentation-only feature introduces no architecture or persisted domain schema change; do not allocate unrelated numbers.
- Canonical branch plan: `.ai-factory/plans/maister-task-868ce957-8a47-44fa-9975-ceb4503493c0-attempt-1.md`.
- Delivery: identical plan bytes to `$MAISTER_PLAN_DOCUMENT_FILE`; strict PlanReviewV1 to `$MAISTER_PLAN_REVIEW_FILE`.

## Original Request

# Task statement

## Context
Run transcripts render USER messages in full. On this host, triager run 3a885f97 produces an ~11,100 px tall transcript, of which ~8,800 px is two USER blocks of ~16.5k characters each: the initial prompt (sent at 22:07) and the same prompt re-sent unchanged after a clarification answer (22:13, post-resume). The prompt opens with a 'Packaged skills' list of 21 paths. The page auto-scrolls to the bottom on open, forcing the reader to scroll back up through the prompt. In components/run-transcript/transcript-view.tsx the USER branch at line 698 renders without collapsing, while <details> is already used nearby at line 501.

## Goal
Make long USER messages in the run transcript collapsed by default with a compact preview, render repeated identical prompts as a one-line notice, and compress the packaged-skills list into a chip, so the transcript's opening view is scannable.

## Acceptance criteria
- USER messages above a length threshold render collapsed by default, showing a 3-4 line preview
- A collapsed message offers a 'Show fully (N chars)' toggle and a 'Copy' button that copies the full message text
- An identical USER prompt re-sent after resume renders as a single line such as 'sent again, unchanged' instead of a second full block
- The 'Packaged skills' path list renders as a compact chip with the count (e.g. '21 skills'), expandable to the full list
- Expand/collapse state is persisted in the URL, so shared links preserve it
- Short USER messages render exactly as today (no regression)

## Constraints
- Frontend-only change within the run transcript components
- Reuse the <details> idiom already present in transcript-view.tsx (:501) for consistency
- The full message text must remain available (expand + copy); no data may be dropped from the transcript

## Out of scope
- Backend changes to prompt generation or the transcript data model
- Collapsing assistant or tool messages
- Redesigning the transcript layout beyond the listed collapse behaviors

## Links
- components/run-transcript/transcript-view.tsx#L698
- components/run-transcript/transcript-view.tsx#L501
- maister run 3a885f97 (triager)

## Open questions
- Length threshold for collapsing: characters or lines, and what value?
- Is collapsing enough for the auto-scroll-to-bottom pain, or should the initial scroll anchor also change?
- Chip expansion UI: inline <details>, popover, or something else?

## Settings

- Testing: yes. TDD: write behavioral tests first, demonstrate RED on missing behavior, implement GREEN, then refactor only feature-owned code.
- Logging: standard. No prompt text, clipboard payloads, skill paths or URL contents in logs. No new browser console logging or server telemetry; localized inline errors at clipboard/full-content boundaries. Existing server endpoint logging remains authoritative.
- Docs: yes; mandatory documentation checkpoint through aif-docs during implementation.
- Roadmap linkage: none. No clearly matching named milestone was established; do not attach this small UI task to a broad milestone.
- Research: no research artifact influenced the plan. Code and the supplied request plus recorded intake clarification are the evidence.

## Requirements Brief

Goal: make large USER prompts and their exact repeats scannable while preserving every message and its complete content.

In scope: shared transcript USER rendering, conservative packaged-skills segmentation, native details controls, full-text copying, URL disclosure state, EN/RU strings, minimal tests and owning docs.

Non-goals: change prompt generation, storage/projectors, API payloads, assistant/tool rendering, initial scroll anchor, live-follow/pagination algorithms, layout redesign or new dependencies.

Affected contracts: frontend disclosure URL entries and existing TranscriptView presentation; source-authorized full-content GET is consumed as-is. TranscriptMessage, HTTP/OpenAPI, SSE/AsyncAPI, DB and execution ledgers do not change. No migrations, env vars, runtime config, ports, containers or deployment wiring are needed.

Data model: retain original message.content untouched. Derive typed local presentation segments with original offsets and exact text slices, repeat identity and disclosure identity; never persist transformed prompt data. Message IDs identify state, not text hashes or array indexes.

Docs: extend docs/system-analytics/workbench.md with a narrowly scoped presentation contract and cross-reference it from docs/screens/runs/flow-run.md and docs/screens/runs/scratch-run.md. Do not rewrite existing trace-plane history or duplicate the policy in multiple docs.

Acceptance:

1. USER text exceeding 2,000 JavaScript UTF-16 code units OR 12 logical newline-delimited lines is initially closed. Exactly 2,000 characters and 12 lines remains unchanged. Count CRLF as one newline; count empty trailing lines. Character labels use the same string.length metric.
2. A closed long prompt shows up to four visual lines, clipped with CSS line-clamp-4 at desktop and narrow widths. Its native summary offers localized “Show fully (N chars)” / “Collapse”; Copy remains visible and accessible independently of hover and disclosure state.
3. Copy passes the entire unmodified message to clipboard, including the packaged list. Only successful writes show copied feedback; unavailable/rejected clipboard produces localized inline error and permits retry.
4. A later complete long USER prompt with exactly identical content becomes a one-line native summary (“Sent again, unchanged”), retaining its own time/delivery metadata, message anchor, attachments, expansion and full-copy action. A differing byte/code-unit, whitespace or line ending is different. Short repeated messages remain as today.
5. A recognized generated Packaged skills section becomes an inline details chip with an accurate list-item count. Its expanded content includes the heading, explanation and every original list line. Other prompt content remains in its original order. Malformed/ambiguous/unrecognized sections stay ordinary text; nothing is discarded.
6. Message, repeat and skill disclosure states restore from URL on refresh, pasted links and back/forward. Nested skill openness survives closing/reopening its parent. Independent scopes never overwrite each other or other URL state.
7. Initial scrolling and latest-follow behavior remain as today. Opening/copying disclosures does not navigate, refresh history, fetch unrelated pages or jump to latest. Existing assistant/tool/compaction/attachment/history behavior passes regression checks.
8. Existing bounded previews never become false exact repeats or false full copies; explicit expansion/copy loads original USER text through the existing authorized full-content URL, with retryable localized errors and original download access retained. Original-byte count is never presented as N characters.

Assumptions: the typed review companion lists all non-obvious defaults, including the approved intake policy. No blocking decision remains.

## Requirements Reconciliation

Authority: current task constraints and recorded human clarification in .maister/run.json task.effectivePrompt override generic skill defaults; project CLAUDE/rules govern implementation.

| Requirement / combination | Evidence | Verification |
| --- | --- | --- |
| Approved collapse policy, four lines, unchanged scroll | .maister/run.json task.clarifications[0] | Threshold tests and browser layout/scroll checks |
| Native details, unchanged short text | transcript-view.tsx CompactionRow and USER article | Native keyboard E2E and short-message static markup regression |
| Exact replay is visual only | TranscriptMessage has no resume marker; history is bounded | Repeat tests with changed text, intervening answer, pagination and eviction |
| Shared consumers and bounded content | scratch-transcript.tsx re-export; run-transcript-history.tsx; PreviewNotice | Scratch/node/run regressions and authorized full-content test |
| Lossless packaged skills | web/lib/capabilities/package-skills.ts build/append functions | Generated-shape fixtures with exact reconstruction |
| Shareable view and browser navigation | web/CLAUDE.md URL-state rule; run-peek-controller.tsx history pattern | Reload/back/forward and simultaneous peek tests |
| Localization | web/messages/en.json and ru.json, useTranslations already in renderer | EN/RU browser assertions, no wrapper prop churn |

## Design Decisions

- Use a component-local user-message.tsx plus a small pure user-message-presentation.ts helper in web/components/run-transcript/ if extraction keeps transcript-view.tsx surgical. Keep state/segmentation implementation in this directory. Resolve translation keys directly in a shared transcript namespace in existing message catalogs; do not require every TranscriptLabels caller to change.
- Only parsed kind=text and role=user enter the new path; custom renderers remain first. Preserve the existing short-user article branch verbatim when not eligible. Skills folding applies only to eligible long prompts, reconciling short-message parity.
- Scan ordered messages once per messages update for exact long complete USER text; use a Map keyed by full original string, not a quadratic pairwise comparison. Exclude preview-bearing rows even after lazy resolution so decisions do not change from action-time fetching. Reset comparison at /clear. Never remove a row or require the original row to remain mounted: every repeat can expand its own stored content.
- Recognize the actual generated `## Packaged skills` heading, its known explanatory paragraph, and contiguous `- slug: `path/SKILL.md`` entries (backtick delimiters in actual text). Parse only outside fenced code; stop before the next non-list content; require at least one valid generated entry, and reject a mixed/malformed list rather than partially hiding it. Preserve LF/CRLF and every surrounding slice; multiple valid sections receive ordinal section identities. This is rendering, not Markdown sanitization or a general parser rewrite.
- Preview uses ordinary text segments in order, substituting the collapsed chip for skills metadata; no hidden full path list should occupy preview lines. Native summary controls disclosure; avoid button-in-summary nesting by keeping Copy adjacent. Full body appears once when open, with original whitespace behavior and nested skills disclosure. Copy always uses raw original text.
- Query contract: repeated `transcript-open` query parameters encode versioned tuples `[1,messageId,section]` as JSON URLSearchParams values; section is `message` or `skills:<ordinal>`. Globally unique retained message IDs supply scope without adding wrapper APIs. Keep only explicit open entries (closed is default), sort/deduplicate on user writes, and tolerate unknown/malformed entries as untrusted view state without crashing or altering other parameters. No message content/path/hash in the URL.
- Read URL state via a component-local external-store subscription (useSyncExternalStore) to popstate plus one namespaced same-document event for own writes; deterministic closed SSR snapshot avoids hydration mismatch. On toggle construct URL from current window.location, preserve hash and window.history.state, replaceState, then notify sibling instances. Never replace history.state with an empty object; never call router navigation for disclosures. Do not prune entries for temporarily unloaded messages. Toggles update the current history entry without adding navigation steps. Browser back/forward between entries restores the choices captured in each entry; it need not undo individual toggles. Browser restoration does not write history. Suppress redundant native onToggle writes when controlled open already matches URL, including initial mount.
- Bounded USER rows: original text is already exposed by existing fullContentHref GET as text. Fetch only that supplied same-origin endpoint on user expand/copy, check response.ok, use text(), hold loaded full text in local memory, deduplicate simultaneous action requests, abort on unmount/message change, and ignore stale completions. Never serialize loaded content to URL. Before text arrives use localized “Show full message” and existing byte-preview notice; after load show true N chars. Display a localized retryable alert on failure and preserve the original download link. Do not add backend changes or automatically download content merely because a shared URL opens a row. A URL-open bounded row presents an explicit Load full content action until clicked. Full-content GET failures use at most two retries for network/5xx errors with visible localized retry status, then show the final localized error; 4xx fail immediately. Clipboard writes are not automatically retried.
- Copy and fetch errors are presentation errors, not new domain error codes. No catch-and-ignore, no copied state on failure. Clipboard success uses existing feedback idiom and scoped timer cleanup. No changes to assistant CopyButton unless a strictly necessary safe extraction is smaller.

## Tasks

### Phase 0 — Complete presentation specification

- [x] T1. Specify the presentation state and owning documentation before code.
  - Files: docs/system-analytics/workbench.md; narrow references in docs/screens/runs/flow-run.md and scratch-run.md.
  - Tests first: define the acceptance scenario table below as the executable test checklist; run docs link/structure validation on the additions. No production test is needed for prose alone.
  - Describe purpose, derived entities, closed/open/loading/error states, toggles/URL restoration, full-copy/error process, exact-repeat eligibility, lossless skills grammar, existing bounded-content access and failure/cancellation paths. Each expectation names its enforcing component or test. Mark new behavior Designed until implemented; do not alter the recorded-prompt state machine.
  - Enumerate changed URL contract here; HTTP/SSE/DB/ERD/schema/error/deployment artifacts are explicitly unchanged.
  - Logging: none for documentation.
  - Exit: complete internally consistent spec, no contradictory threshold/copy/repeat table, valid links. No code before this checkpoint.

### Phase 1 — Lossless USER presentation and disclosure behavior

- [ ] T2. Add pure presentation classification and exact-repeat derivation (depends on T1).
  - Files: new web/components/run-transcript/user-message-presentation.ts and __tests__/user-message-presentation.test.ts; minimal transcript-view.tsx integration.
  - Tests first (Vitest unit project, node environment): thresholds 1999/2000/2001, 12/13 lines including CRLF/trailing blanks; complete long repeats separated by assistant/tool/short answer; unequal whitespace/newlines; short repeats unchanged; bounded rows excluded; /clear reset; missing predecessor and prepend/eviction recomputation. Skills fixtures: real generated shape with 21 entries at beginning/middle/end, multiple sections, fences and malformed/mixed/empty lists; joining original slices exactly reproduces source. Use pure data tests only for these stable transformations.
  - GREEN: immutable typed derived descriptors, linear ordered scan and conservative segmentation; never edit TranscriptMessage or lib backend code.
  - Logging: none; no prompt/path data in diagnostics.
  - Verify: test file listed by `pnpm --dir web exec vitest list --project unit components/run-transcript`; focused tests green after captured RED.

- [ ] T3. Implement native USER message and skills disclosures with full-copy access (depends on T2).
  - Files: user-message.tsx, transcript-view.tsx; web/messages/en.json and ru.json; __tests__/user-message.test.ts; web/e2e/run-transcript-history.spec.ts.
  - Tests first: static rendering tests under Vitest unit project for four-line preview markup, closed native details, count/toggle/copy labels, repeat row anchors and preserved attachments/delivery/time, unchanged short-user markup and unchanged assistant/tool behavior. Browser tests in existing authenticated run-transcript-history spec verify four rendered lines at desktop/mobile, skills 21 count and full list, first/duplicate expansion and exact clipboard text, keyboard Enter/Space, visible touch copy, clipboard denial/unavailability retry, and safe content escaping.
  - GREEN: use details idiom from CompactionRow, preserve original article styling, add no assistant/tool collapse. Expanded repeats render their own exact content, not a fragile pointer. Metadata and attachments remain visible outside the clipped text.
  - Bounded tests first: seed a large USER fixture through existing full-content handling, assert no fetch while closed, explicit expansion/copy returns exact full text, no false full count, HTTP/network failure and retry, simultaneous requests, unmount/stale result protection; existing full download action remains reachable. Native URL-restored open state alone does not fetch full text.
  - Logging: standard existing endpoint logs only; localized clipboard/download error alert, no console or new telemetry.
  - Verify: run focused Vitest + Playwright spec after RED, then refactor only feature-owned code.

- [ ] T4. Persist independent disclosure state in URL (depends on T3).
  - Files: new web/components/run-transcript/use-user-message-expansion.ts (or equally small component-local helper); same E2E spec and pure URL codec tests within __tests__/user-message-presentation.test.ts.
  - Tests first: parse/serialize duplicate/unknown/malformed URL tuples; browser reload/pasted URL restores message and skills independently; close/reopen parent retains nested choice; back/forward; current query/hash/history.state preserved; two transcript/peek instances do not clobber entries; prepend/eviction/refresh preserve stable identities; no raw text or skills paths in URL; no URL write loop from native onToggle or hydration. Verify invalid and stale IDs cannot force row creation or fetch.
  - GREEN: implement the query contract and popstate/same-document synchronization above; retain state for unloaded IDs. Restore states after hydration without altering scroll ownership, route selection or history fetching. Respect message-specific custom rendering.
  - Logging: none for view-state transitions; malformed view entries are not domain failures.
  - Phase exit: all focused tests green, then full web unit and integration suites green using separate commands `pnpm --dir web test:unit` and `pnpm --dir web test:integration`. Failures must be repaired within scope or explicitly recorded as a blocked verification with evidence; never silently delete/skip tests. Any proposed quarantine requires tracked owner justification and review rather than automatic unrelated test edits.

### Phase 2 — Regression qualification and documentation checkpoint

- [ ] T5. Verify history/scroll integration and unchanged consumers (depends on T4).
  - Files: extend web/e2e/run-transcript-history.spec.ts only as needed; inspect existing web/components/runs/__tests__/agent-run-transcript.test.ts, node-transcript-panel.test.ts, web/components/scratch/__tests__/scratch-transcript.test.ts and web/components/run-transcript/__tests__/compaction-preview.test.ts.
  - Tests first: browser fixture approximating two identical 16.5k prompts with 21 skills plus clarification/assistant turns. Assert default prompts have bounded visual height and duplicate body is absent, latest remains the initial scroll target, disclosure keeps the same reading region without programmatic latest jump, paging anchors and live-follow work, original eviction leaves duplicate independently expandable, node and scratch consumers behave consistently. Retain existing slow-load/pagination/live-refresh cases unchanged; extend fixtures without invalidating their assistant-only text assertions.
  - No known existing assertion requires migration: short USER and all assistant/tool behavior stay identical. If discovered otherwise, enumerate the exact assertion and rationale here before updating it; avoid blanket snapshots.
  - Runner integrity: confirm Vitest list includes the new .test.ts files (not .tsx, unmatched by current include glob); `pnpm --dir web exec playwright test --list e2e/run-transcript-history.spec.ts` confirms browser registration. Use existing E2E fixture DB and runner (`pnpm --dir web test:e2e e2e/run-transcript-history.spec.ts`); no new test project/dependency.
  - Logging: no production changes; keep test failure evidence without actual private prompts.
  - Verify: focused regression suites, browser scenarios, web typecheck and ESLint with zero new warnings. Use `pnpm --dir web exec eslint` with the exact changed TS/TSX file paths (no broad --fix); prettier check changed files. Record actual commands and results.

- [ ] T6. Finalize docs and review the complete diff (depends on T5).
  - Tests first: documentation link/requirement checks against T1 contract; compare every acceptance row to its passing evidence. No trivial tests for prose.
  - Use aif-docs for mandatory docs checkpoint. Mark the new presentation contract Implemented only once tested; references remain concise. No public site-docs or API docs change is required by this internal presentation task.
  - Run `pnpm validate:docs`; check `git --no-pager diff --check` and review changed files against this scope. Re-run full unit/integration suites only if T5/T6 changes behavior/tests since Phase 1 checkpoint. Verify clipboard failures, bounded previews, unknown URL state, keyboard support and two-surface history with an adversarial review; each fix cycle repeats relevant review/tests.
  - Logging: no new logs. Confirm no message text is placed in URL/logs and no fallback silently substitutes a preview for full text.
  - Exit: all acceptance criteria mapped to passing tests, full suites green at final behavioral HEAD, no unverified success claims; report environmental test blockers precisely if encountered. Do not deploy, commit or implement during this planning run.

## Commit Plan

1. After T1: `docs: specify compact user transcript presentation`.
2. After T2–T4: `feat: compact long user transcript messages` (tests, translations and URL state together).
3. After T5–T6: `test: qualify compact user transcript navigation` (final docs status in same checkpoint).

## Verification Matrix

| Scenario | Primary evidence |
| --- | --- |
| Threshold boundaries and exact matching | T2 unit data tests |
| Lossless skills parsing and malformed input | T2 exact-reconstruction tests |
| Four visual lines, native disclosure, short parity | T3 static tests + desktop/mobile browser geometry |
| Complete copy, permissions/failures, bounded content | T3 clipboard/full-content browser tests |
| Shared URL, browser restoration, independent rows/chips | T4 browser navigation tests |
| Initial latest scroll, pagination, refresh, eviction | T5 real history browser suite |
| Shared scratch/node/run, assistants/tools/compaction | T5 existing component regressions |
| EN/RU, accessibility and docs parity | T3 locale/keyboard browser checks + T6 docs gate |

## Unresolved Questions

None. The prior intake answer resolves the threshold, initial scroll and chip UI. Remaining assumptions are non-blocking and enumerated in PlanReviewV1; decisions is empty.
