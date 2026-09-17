# Implementation Plan: Truncate the Backlog task-card description

Branch: claude/task-card-description-truncate-bfefb1
Created: 2026-09-17
Refined: 2026-09-17 (/aif-improve — SDD + TDD restructure, hook-order defect fixed)

## Settings

- Testing: yes
- Logging: minimal
- Docs: yes

## Roadmap Linkage

Milestone: "none"
Rationale: Skipped by user — a self-contained board presentation fix that belongs to no milestone.

## Problem

A Backlog card renders the task's full description with no length limit.
`web/components/board/task-card.tsx:161-169` passes `multiline field="prompt"` to
`TaskInlineEditableField`; its view branch
(`web/components/board/task-card-editing.tsx:561-565`) falls through to
`<MarkdownBody text={value} variant="compact" />`. Descriptions of a few thousand
characters (headings, GFM tables, fenced code) turn one card into a page-tall wall
and make the Backlog column unscannable.

## Chosen design

Render a ~120-character plain-text excerpt of the description. When the description
is longer, a disclosure button expands the full markdown **in place** inside the
card and collapses it again. No popover, no tooltip, no navigation.

Why in place and not a popover: the board's column row is `overflow-x-auto`
(`web/components/board/board.tsx:213`), so a non-portaled popover is clipped, and a
portaled one needs anchor positioning, outside-click/Esc, focus return and
re-anchoring across two scroll axes — a large, fragile surface for a read-only
preview. In-place disclosure works in all three board layouts (columns, swimlanes,
list), on touch and with a keyboard, for free.

---

# Phase 0 artifact — Specification

This section is the spec. Phases 1-3 implement exactly this and nothing else. A
disagreement between code and this section is resolved by amending this section
first, never by letting the code drift.

## S1. `markdownExcerpt` contract

```ts
markdownExcerpt(source: string, maxChars = 120): { text: string; truncated: boolean }
```

### S1.1 Algorithm (normative)

1. **Plain-text derivation.** Reduce the markdown source to human-readable text:
   - ATX heading markers, blockquote markers, unordered bullets (`-`, `*`, `+`),
     ordered markers (`1.`), horizontal rules → removed.
   - Emphasis markers `**`, `*`, `~~` → removed, content kept.
   - `__`/`_` → removed ONLY where the run could delimit emphasis. CommonMark
     refuses an underscore run flanked by word characters on both sides, so
     `snake_case` is literal there and MUST stay literal here — otherwise the
     collapsed excerpt reads `snakecase` while the expanded Markdown directly
     below it reads `snake_case`. (`*` is not given the same exemption:
     CommonMark DOES allow intra-word `*` emphasis. A glob such as
     `web/**/*.ts` is therefore still stripped — accepted, since its asterisks
     are flanked by `/`, not word characters, and no flanking rule would save
     it.)
   - Inline-code backticks and fenced-code delimiters → removed, content kept.
   - Raw HTML tags → **KEPT verbatim** (amended 2026-09-17, review finding C1).
     `MarkdownBody` mounts remark-only with no `rehype-raw` (ADR-078 D10), so
     `<div>` renders as literal text in the expanded body directly below. This
     is the same rule as the intra-word underscore above: the excerpt MUST NOT
     strip a marker the renderer shows. The rule this replaces ("HTML tags →
     removed, text content kept") was never derived against the renderer, and
     the regex written from it (`/<[^>]*>/g`) additionally deleted everything
     between any `<` and a later `>` — `Use Array<string> for the list` became
     `Use Array for the list`.
   - CommonMark **autolinks** — `<scheme:rest>` and `<user@host>` → angle
     brackets removed, inner text kept. These are real markup: the renderer
     turns `<https://example.com>` into a link whose text is
     `https://example.com`, so keeping the brackets would diverge in the other
     direction. (Verified by rendering each form through `MarkdownBody`; the
     old blanket strip deleted autolinks entirely, which matched neither.)
   - `[label](url)` → `label`. `![alt](url)` → `alt`.
   - GFM table pipes and alignment rows (`|---|:--:|`) → removed; cell text kept,
     separated by a space.
2. **Normalization.** Collapse every whitespace run, newlines included, to one
   space; trim both ends.
3. **Measurement.** Operate on code points (`Array.from`), never UTF-16 units.
4. **Short case.** `length <= maxChars` → `{ text: plain, truncated: false }`.
5. **Truncation.** Let `floor = Math.ceil(maxChars * 0.6)` (72 at the default).
   Let `lastSpace` be the highest index `i < maxChars` whose character is
   whitespace, or `-1`.
   `cut = (lastSpace >= floor) ? lastSpace : maxChars`.
   `text = codePoints.slice(0, cut).join("").trimEnd() + "…"`,
   `truncated: true`.

The `…` (U+2026) is appended **after** the budget, so `text` may be `maxChars + 1`
code points long. This is deliberate — the budget governs content, not the marker.

### S1.2 Acceptance table (tests derive from this, one `it.each`)

`maxChars = 120` unless stated.

| #   | Input                                            | Expected `text`              | `truncated` |
| --- | ------------------------------------------------ | ---------------------------- | ----------- |
| 1   | `Fix the 500 on collect`                         | `Fix the 500 on collect`     | `false`     |
| 2   | `` (empty)                                       | `` (empty)                   | `false`     |
| 3   | `## Симптом\n\nВкладка артефактов`               | `Симптом Вкладка артефактов` | `false`     |
| 4   | `**bold** and _italic_ and ~~strike~~`           | `bold and italic and strike` | `false`     |
| 5   | ``Use `deriveFromToolCall` here``                | `Use deriveFromToolCall here`| `false`     |
| 6   | ` ```ts\nconst a = 1;\n``` `                     | `const a = 1;`               | `false`     |
| 7   | `[the projector](web/lib/x.ts)`                  | `the projector`              | `false`     |
| 8   | `![diagram](a.png)`                              | `diagram`                    | `false`     |
| 9   | `> quoted line`                                  | `quoted line`                | `false`     |
| 10  | `- one\n- two\n1. three`                         | `one two three`              | `false`     |
| 11  | `\| run \| count \|\n\|---\|---\|\n\| a \| 1 \|` | `run count a 1`              | `false`     |
| 12  | `---\ntext`                                      | `text`                       | `false`     |
| 13  | Cyrillic prose, 200 chars, spaced ~every 8       | cut at the last space ≥72, `…` | `true`    |
| 14  | one 200-char token, no whitespace                | exactly 120 code points + `…` | `true`     |
| 15  | 200 chars whose only space is at index 40        | exactly 120 code points + `…` | `true`     |
| 16  | 200 chars whose last space before 120 is at 100  | first 100 chars + `…`        | `true`     |
| 17  | emoji at code point 119, ASCII either side       | 119 chars + the whole emoji + `…`       | `true` |
| 18  | `**bold** and snake_case stays`                  | `bold and snake_case stays`  | `false`     |
| 19  | `Use Array<string> for the list`                 | `Use Array<string> for the list` | `false` |
| 20  | `See <https://example.com> now`                  | `See https://example.com now` | `false`    |

Rows 14 and 15 are the two sides of the `floor` guard and are both required; row 16
is the back-off hit. Rows 1-12 are the derivation rules, one per rule — do not add a
second case per rule, and do not add a "returns an object" test. Row 18 was
added 2026-09-17 with the intra-word underscore amendment above; rows 18-19 are
the ones that pin a marker being KEPT.

Rows 19-20 were added 2026-09-17 with the raw-HTML/autolink amendment above.
They are deliberately a PAIR, because the two angle-bracket forms resolve in
opposite directions and a single row would let the wrong blanket rule pass: 19
pins raw HTML surviving, 20 pins an autolink being unwrapped. Both expectations
were read off `MarkdownBody`'s rendered text, not chosen — the excerpt's job is
to agree with it.

Row 17 amended 2026-09-17 during T3: it first read "cut before the emoji", which
S1.1 does not produce. At code point 119 the emoji is the LAST code point inside
the 120 budget, so step 5 keeps it. That placement is what makes the row
load-bearing — its surrogate pair straddles UTF-16 index 120, so a UTF-16 slice
emits a lone surrogate exactly there, while the normative code-point slice keeps
the emoji whole. An emoji at code point 120 would indeed be cut away, but with
ASCII before it the two implementations agree and the row would prove nothing.

## S2. Card render contract

> **AMENDED 2026-09-17, after the owner's review of the shipped feature.**
> In-place editing was REMOVED from the board card: the title is now a plain
> link and the description is presentation only, because the full card editor
> already edits both and is the better surface. Two consequences, both load-
> bearing for anyone reading S3 below:
>
> 1. The `editing` state in the table below no longer exists on the card. S2 has
>    three states, not four, and the S2-d test was deleted rather than rewritten
>    — there is no longer a code path for it to guard.
> 2. **S3's entire rationale is gone.** `renderView` is not used by the card any
>    more, so the hook-order hazard it existed to avoid cannot occur, the
>    `TaskCardDescription` wrapper was deleted, and `TaskCard` renders
>    `CollapsibleDescription` directly (a Server Component may render a client
>    component across a serializable `text: string` prop). The WHY comment went
>    with it.
>
> What DID become true is the repair this plan predicted in T6 and I dropped as
> unnecessary: with `TaskCardDescription` gone, `TaskCard` reaches the real
> component instead of the mocked `task-card-editing`, its `useTranslations`
> runs unmocked, and `task-card-delegated` + `task-card-launch-reason` go red.
> Both now mock `@/components/board/task-card-description`. Measured, not
> assumed, in both directions.
>
> The task detail page is unchanged and KEEPS inline editing (S4 always put it
> out of scope), so `TaskInlineEditableField` remains in use.


`CollapsibleDescription` has exactly three observable states (was four until
2026-09-17; the `editing` row went with in-place editing — see the banner above):

| State     | Condition                                    | Renders                                                                     |
| --------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| plain     | `truncated === false`                        | `<MarkdownBody variant="compact">`, **no** toggle                            |
| collapsed | `truncated === true`, `expanded === false`   | excerpt text + toggle, `aria-expanded="false"`, label `board.descriptionExpand` |
| expanded  | `truncated === true`, `expanded === true`    | `<MarkdownBody variant="compact">` + toggle, `aria-expanded="true"`, label `board.descriptionCollapse` |

Expectations, each naming its enforcement point:

- **E1.** A short description is visually unchanged from today.
  *Enforced by:* the `plain` state reusing the exact `MarkdownBody` call the current
  code makes, plus test S2-a.
- **E2.** Collapsed state never overflows the card. The excerpt node carries
  `min-w-0 break-words [overflow-wrap:anywhere]` — the idiom already used at
  `web/components/board/flow-graph-view.tsx:597`. A 120-character unbroken token
  must wrap inside the 268px swimlane card.
  *Enforced by:* code review against this line; no automated check (jsdom has no
  layout engine — do not write a fake width assertion).
- **E3.** The toggle is reachable by keyboard and screen reader: a real `<button>`
  with `aria-expanded` and `aria-controls` pointing at the `useId()`-derived id of
  the description container.
  *Enforced by:* test S2-b/S2-c.
- **E4.** Both locales carry both keys.
  *Enforced by:* `web/lib/__tests__/i18n-parity.test.ts`, which fails on key-for-key
  EN/RU drift. Do not restate this as a convention in prose.
- **E5. WITHDRAWN 2026-09-17** (was: "entering edit mode from the expanded state
  does not crash and returns a collapsed card", enforced by test S2-d). The card
  has no edit mode, so the expectation has no subject and S2-d was deleted rather
  than rewritten. Kept as a struck entry, not silently dropped, because E5 was
  the expectation this plan was originally written to protect — see S3.
- **E6.** The excerpt reads exactly as the expanded body does. The two sit one
  click apart, so any marker the excerpt strips that `MarkdownBody` renders (or
  keeps that `MarkdownBody` unwraps) is a visible contradiction.
  *Enforced by:* `web/lib/__tests__/markdown-excerpt-renderer-parity.test.ts`,
  which asserts each case against the renderer's own output rather than against a
  hand-written string. Added 2026-09-17 with review finding C1, whose defect —
  a blanket `/<[^>]*>/g` — this expectation had no mechanism to catch.

## S3. Component decomposition — SUPERSEDED 2026-09-17

**This section no longer describes the code, and none of it is normative.**
Rewritten in place (review finding C2) because the original text survived the
in-place-editing removal unchanged: it still prescribed a three-level component
chain that no longer exists, under a heading reading "load-bearing, do not
collapse", and still carried a `MUST` — a `WHY` comment at the `renderView` call
site — that no code path could satisfy. A stale normative bullet outlives the
narrative that corrects it, so the bullets are gone rather than annotated.

**As built:**

```
TaskCard (RSC)
  └── CollapsibleDescription  ("use client")   ← owns the hooks
```

`TaskCard` renders `CollapsibleDescription` directly across a serializable
`text: string` prop. No `renderView` and no wrapper component are involved.

**Why the original design existed, and why the hazard is gone.** The plan was
written around a real React defect: `TaskInlineEditableField` invokes its
`renderView` callback inside its own render body while returning early when
`editing` is true, so any hook called from that callback registers against
`TaskInlineEditableField` and is skipped on the editing render — *"Rendered
fewer hooks than expected"* the moment the edit pencil is clicked. That was
verified by inlining `useState` into the callback and watching all four card
tests fail with exactly that message. The card no longer uses `renderView` at
all, so the hazard is unreachable from this surface.

**Still live for the task detail page.** `TaskInlineEditableField` keeps that
`renderView` seam and is still used by
`web/components/social/task-detail-prompt-editor.tsx` and the task detail page.
The constraint — *a `renderView` callback body constructs an element and calls no
hooks* — remains true for any FUTURE caller, and is recorded here for that
reason. It is a property of `TaskInlineEditableField`, not of this card.

## S4. Scope boundaries

Out of scope, must not change:

- The task detail page (`/projects/{slug}/tasks/{number}`) keeps rendering the full
  description through `TaskDetailPromptEditor`'s own `renderView`.
- Edit mode. **Do not modify `TaskInlineEditableField` at all** — `renderView` is
  the existing seam and is sufficient.
- In-flight cards. `web/components/board/flight-card.tsx` does not render the prompt.
- `BacklogCard` and `web/lib/queries/board.ts`. The full prompt already ships to the
  client because `TaskCardEditModal` needs it for the edit form.
- The Tailwind `truncate`-on-raw-markdown surfaces at
  `web/components/social/relations-editor.tsx:300` and
  `web/components/inbox/hitl-card.tsx:298`. They may adopt the helper later.
- No "open the task" link is added. The `KEY-N` chip already links to the task page
  and `TaskCardEditModal` already exposes the full text and parameters.

## S5. Accepted limitation — do not "fix" it

A description that is short in characters but tall when rendered (a small GFM table,
a short fenced code block) stays fully expanded with no toggle, because the trigger
is character count alone. Do not add a line-count or rendered-height heuristic:
there is no evidence it occurs in practice and it adds a knob with an arbitrary
threshold. If it shows up it is a separate, evidenced change.

Second accepted limitation, recorded 2026-09-17 (review finding): the derivation
is line-based and has no notion of being *inside* a fence, so a `---` line within
a fenced code block is dropped as a horizontal rule — ` ```\n---\n``` ` excerpts to
the empty string. Fixing it means tracking fence state across the line filter,
which buys a more faithful preview of a case (a code block whose content is only
rule punctuation) that no observed description has. Left as is, deliberately.
Note this cuts the OTHER way from E6: it is a divergence from the rendered body
that the parity test does not cover, because the parity corpus is angle brackets.
If a third such case appears, widen the corpus rather than adding another
special-case regex.

## S6. Contract surfaces

| Surface                    | Changes? | Spec file                                             |
| -------------------------- | -------- | ----------------------------------------------------- |
| HTTP route                 | no       | —                                                       |
| Wire field semantics       | no       | —                                                       |
| SSE / WebSocket event      | no       | —                                                       |
| Domain error code          | no       | —                                                       |
| Env var / config path      | no       | —                                                       |
| DB column / table / index  | no       | —                                                       |
| `package.json` script      | no       | —                                                       |
| Flow DSL step type / field | no       | —                                                       |
| Screen behavior            | **yes**  | `docs/screens/projects/project-board.md` (T1)           |
| Domain expectation         | **yes**  | `docs/system-analytics/tasks.md` (T2)                   |

**No API contract and no DB migration exist in this change**, and none will be
invented to satisfy a template. There is no route, wire field, SSE event or error
code. There is no new table, column or index; the payload is untouched.

Amended 2026-09-17: this originally read "`PATCH /api/projects/{slug}/tasks/{number}`
is reused unchanged by the existing editor". After the in-place-editing removal the
card issues no `PATCH` at all — its edits go through the full card editor's `PUT`,
and `PATCH` stays the task detail page's inline save. The claim this sentence
exists to make (no contract changed) is unaffected; both routes are untouched.

**Deployment touchpoints: none** — no env var, config file, sidecar binary, bound
port or host-mounted file, so no `Dockerfile` / `compose*.yml` / `.env.example` task.

**Spec-before-code ordering.** Phase 0 lands the docs before any production code, per
`.ai-factory/skill-context/aif-plan/SKILL.md`. The branch is not promoted until
Phase 3 completes, so no published HEAD ever describes absent behavior.

## S7. Test integrity

**Runnability — verified, no runner config change:**

| Test file                                                      | Project | Matching include glob                  |
| -------------------------------------------------------------- | ------- | -------------------------------------- |
| `web/lib/__tests__/markdown-excerpt.test.ts`                   | `unit`  | `lib/**/__tests__/**/*.test.ts`        |
| `web/lib/__tests__/markdown-excerpt-renderer-parity.test.ts`   | `unit`  | `lib/**/__tests__/**/*.test.ts`        |
| `web/components/board/__tests__/task-card-description.test.ts` | `unit`  | `components/**/__tests__/**/*.test.ts` |

Globs from `web/vitest.workspace.ts`. All three land in already-globbed families,
so `web/vitest.workspace.ts` MUST NOT be edited. Project default environment is
`node`; the component test and the parity test opt in with the per-file
`// @vitest-environment jsdom` directive, as
`web/components/board/__tests__/launch-popover.interaction.test.ts` already does
in the same project. The parity test is the first `lib/` file to take that
directive — it is a `lib` test by subject (the helper is the unit under test) and
needs a DOM only because its oracle is a real render.

**No overlap, no trivial tests.** Each of the three files tests a different axis
and none re-derives another's expectations:

- `markdown-excerpt.test.ts` — one row per derivation rule, table-driven from
  S1.2, expectations written out literally.
- `markdown-excerpt-renderer-parity.test.ts` — the E6 invariant, expectations
  taken from `MarkdownBody`'s output. It does NOT restate rows 19-20: those pin
  the two angle-bracket directions as fixed strings so a renderer change is
  visible as a conflict between the two files rather than silently ratified by
  both.
- `task-card-description.test.ts` — the three S2 states only; it never
  re-derives excerpt text.

Forbidden: "renders without crashing", "exports a function", asserting React's
own attribute plumbing.

**Assertion migration is in scope (T6), and these are the files:**
`web/components/board/__tests__/task-card-delegated.test.ts` and
`web/components/board/__tests__/task-card-launch-reason.test.ts`. Both render
`TaskCard` via `renderToStaticMarkup` and mock `task-card-editing`; once `TaskCard`
imports the new component they need the equivalent mock, or the real component
renders, its `useTranslations` throws unmocked, and both suites go red.

**Amended twice on 2026-09-17. Net result: the mock IS required and both suites
carry it.** The two amendments are kept in order because the pair is the lesson.

1. *During T6 — predicted breakage did not occur.* Measured, not assumed: both
   suites ran against the wired `TaskCard` before any repair and stayed green (6
   passed). The reason was the then-current three-level split — the intermediate
   wrapper declared no hooks and only constructed `TaskInlineEditableField`,
   which these suites already mock to `() => null`; a mock never invokes
   `renderView`, so `CollapsibleDescription` was never constructed and
   `useTranslations` never called. T6 step 4 was dropped rather than performed.
2. *After the in-place-editing removal — the breakage arrived.* With the wrapper
   deleted, `TaskCard` imports `CollapsibleDescription` directly, so the
   `task-card-editing` mock no longer shields it, `useTranslations` runs
   unmocked, and both suites went red. Each now mocks
   `@/components/board/task-card-description`. Measured in this direction too.

The load-bearing point is not which answer was right. It is that the prediction
was checked against a run in both directions instead of being inherited: a
dropped repair became necessary the moment the structure it depended on changed.

*(This paragraph was itself corrected on 2026-09-17 by review finding C2, which
caught it still asserting "no mock was added" after both mocks had landed.)*

**RED tests are never committed red.** The red state is observed and its output
recorded in the task; the commit lands at green (see Commit Plan).

---

## Commit Plan

- **Commit 1** (after T1-T2): `docs(board): specify backlog card description excerpt behavior`
- **Commit 2** (after T3-T6): `feat(board): truncate backlog task-card description with in-place expand`
- **Commit 3** (after T7, only if the refactor changed anything): `refactor(board): …`

## Tasks

### Phase 0: Specification (docs before code)

- [x] **T1: Specify the behavior in the project-board screen doc**

  `docs/screens/projects/project-board.md:75` asserts "the displayed description
  renders Markdown in the card body" — false once a long description shows an
  excerpt. Rewrite the Backlog-cards bullet (lines 71-82) to state the S2 contract:
  a long description shows a plain-text excerpt with an expand/collapse control
  revealing the full Markdown in place; a short description still renders Markdown
  directly; editing is unchanged and always opens on the full source.

  Add `web/components/board/task-card-description.tsx` to **both** source lists —
  the header `**Source:**` block (lines 21-26) AND the "Linked artifacts"
  `- Source:` block (lines 284-291). The file lists components twice; updating one
  leaves the other stale.

  Do NOT touch the `stateDiagram-v2` (lines 206-218) — it models task states, and
  collapsed/expanded is presentation, not a task state.

  LOGGING: none — documentation.

  Acceptance: the bullet describes all four S2 states; both source lists name the
  new file; `pnpm validate:docs` green.

  Files: `docs/screens/projects/project-board.md`

- [x] **T2: Add the Backlog-card compactness expectation to system analytics**

  `docs/system-analytics/tasks.md` already carries the sibling contract for the
  flight card at lines 98-102 ("identity-first and compact… the worktree branch and
  the inline HITL form are **not** on the card"). Add the symmetric Backlog-card
  statement to `## Expectations` (line 486): a Backlog card shows at most a ~120
  character plain-text excerpt of the description; the full Markdown is reachable
  in place via a disclosure control; the authored source is never altered.

  One bullet. Do not create a new document and do not restate the screen doc.

  LOGGING: none — documentation.

  Acceptance: one bullet added naming its enforcement point (the S1 helper +
  its test); `pnpm validate:docs` green.

  Files: `docs/system-analytics/tasks.md`

### Phase 1: RED — failing tests from the spec

- [x] **T3: Write the `markdownExcerpt` tests (normative source: S1.2; starts after Phase 0)**

  Create `web/lib/__tests__/markdown-excerpt.test.ts` as a single `it.each` table
  transcribed from S1.2, plus one focused case for a non-default `maxChars` to prove
  the `floor` is derived and not hardcoded at 72.

  Run it and **observe RED**: the module does not exist, so the suite fails to
  resolve `@/lib/markdown-excerpt`. Record the failure output in the task notes.
  Do not create the module in this task.

  LOGGING: none — test code.

  Acceptance: `pnpm --filter maister-web exec vitest run --project unit markdown-excerpt`
  fails, and the failure is a missing module, not a syntax error in the test.

  Files: `web/lib/__tests__/markdown-excerpt.test.ts`

- [x] **T4: Write the card render tests (normative source: S2; starts after Phase 0)**

  Create `web/components/board/__tests__/task-card-description.test.ts` with
  `// @vitest-environment jsdom` on line 1, using the `createRoot` + `act` + mocked
  `next-intl` pattern of
  `web/components/board/__tests__/launch-popover.interaction.test.ts`. Four tests,
  one per S2 state, and no more:

  - **S2-a** short description → `MarkdownBody` output present, no toggle in the tree.
  - **S2-b** long description mounts collapsed → excerpt text present, full body
    absent, toggle `aria-expanded="false"`, `aria-controls` resolves to an element
    that exists.
  - **S2-c** click toggle → full body present, `aria-expanded="true"`; click again →
    back to S2-b.
  - **S2-d** from expanded, enter edit mode, then cancel → **no React error is
    thrown** and the card returns collapsed. This is the S3 hook-order regression;
    assert on a thrown error explicitly (spy `console.error` or assert the act()
    call does not reject) so a future refactor that inlines the hooks fails loudly.

  Mocking rules, and they are load-bearing:

  - Mock `next/navigation` and `next-intl`.
  - Mock `@/components/social/task-markdown-editor` with a trivial stub.
    `TaskMarkdownEditor` pulls tiptap in through `next/dynamic`
    (`task-markdown-editor.tsx:16`), which has no Next.js runtime under vitest;
    without the stub S2-d hangs or throws on an unrelated seam.
  - Do **NOT** mock `TaskInlineEditableField`. S2-d is meaningless without its real
    early return at `task-card-editing.tsx:504` — that early return IS the hazard
    under test.

  Run and **observe RED**. Record the failure output.

  LOGGING: none — test code.

  Acceptance: all four fail for the right reason (missing component), and S2-d is
  written such that it would fail against a hooks-in-callback implementation.

  > **Superseded 2026-09-17 (after T4 completed).** The task above is left as the
  > execution record of what was actually done — all four tests were written and
  > observed red. It is no longer a specification: the in-place-editing removal
  > deleted **S2-d** (no edit mode on the card = no hazard to guard), and with it
  > the `task-markdown-editor` stub and the "do NOT mock `TaskInlineEditableField`"
  > rule, both of which existed only to serve S2-d. The shipped file has three
  > tests and mocks only `next-intl`. Do not re-derive S2-d from this task.

  Files: `web/components/board/__tests__/task-card-description.test.ts`

### Phase 2: GREEN — minimal implementation

- [x] **T5: Implement `markdownExcerpt` (depends on T3)**

  Create `web/lib/markdown-excerpt.ts` implementing S1.1 exactly. Self-contained
  pure function. Do NOT reach for remark/mdast — they are only transitive deps of
  `react-markdown`, and parsing markdown to preview a card is disproportionate.

  Write the minimum that turns T3 green. Resist generalizing beyond S1.1.

  LOGGING: none. A pure client-reachable display helper; `no-console` is enforced on
  the web slice and there is no server boundary. Do not add logging to satisfy a
  template.

  Acceptance: T3 fully green; no other suite changes state; `lint` clean.

  Files: `web/lib/markdown-excerpt.ts`

- [x] **T6: Implement the card surface and repair the existing suites (depends on T4, T5)**

  1. **i18n** — add to the `board` namespace of BOTH `web/messages/en.json` and
     `web/messages/ru.json`:
     - `descriptionExpand` — EN `"More"`, RU `"Ещё"`
     - `descriptionCollapse` — EN `"Less"`, RU `"Свернуть"`
  2. **`web/components/board/task-card-description.tsx`** (`"use client"`) exporting
     both components per S3:
     - `CollapsibleDescription({ text })` — owns every hook (`useState` for
       expanded, `useMemo` for `markdownExcerpt(text)`, `useId`, `useTranslations`),
       renders the S2 states. Excerpt node carries
       `min-w-0 break-words [overflow-wrap:anywhere]` per E2. Toggle is a real
       `<button>` with `ChevronDownIcon`/`ChevronUpIcon`
       (`@heroicons/react/24/outline`, `h-3.5 w-3.5`) plus the visible localized
       label, styled `font-mono`, ~`text-[10px]`, muted, amber on hover/focus.
     - `TaskCardDescription({ slug, taskNumber, prompt, canEdit })` — renders
       `TaskInlineEditableField` with
       `renderView={(value) => <CollapsibleDescription text={value} />}` and the
       S3 `WHY` comment at that call site.
  3. **Wire in** — in `web/components/board/task-card.tsx` replace the
     `multiline field="prompt"` block (lines 161-169) with `<TaskCardDescription>`,
     passing `slug`, `card.number`, `card.prompt`, `canAct`. Keep the existing
     className so card typography is unchanged.
  4. **Repair** — add
     `vi.mock("@/components/board/task-card-description", () => ({ TaskCardDescription: () => null }))`
     to `task-card-delegated.test.ts` and `task-card-launch-reason.test.ts`.

  LOGGING: none — presentational client component under `no-console`.

  Acceptance: T4 green; both repaired suites green;
  `pnpm --filter maister-web exec vitest list --project unit` lists both new files;
  `pnpm --filter maister-web test` green; `lint` clean with no new warnings
  (`react/jsx-sort-props`, `import/order` are enforced and auto-fixable).

  Files: `web/components/board/task-card-description.tsx`,
  `web/components/board/task-card.tsx`, `web/messages/en.json`,
  `web/messages/ru.json`,
  `web/components/board/__tests__/task-card-delegated.test.ts`,
  `web/components/board/__tests__/task-card-launch-reason.test.ts`

### Phase 3: REFACTOR and verify

- [x] **T7: Refactor under green and verify against the spec (depends on T6)**

  STATUS 2026-09-17 — COMPLETE, including the in-app visual pass.
  The review pass found nothing to change (SRP/DRY/KISS/conventions all hold, the
  S3 WHY comment is present), so there is no Commit 3 refactor. Automated
  verification: 8026 unit tests, a production `next build` (79 pages — the only
  check that proves the RSC boundary, since `TaskCard` is a Server Component and
  `TaskCardDescription` is `"use client"`), typecheck, lint, `validate:docs`.
  Three guards were falsified rather than assumed.

  Verified live on `/projects/aidev-mipt-course`, RU locale, 296px card, against
  the real 829-char Backlog description (the owner signed in; the agent does not
  enter credentials):

  | S2 state  | Observed                                                              |
  | --------- | --------------------------------------------------------------------- |
  | collapsed | `aria-expanded="false"`, label `Ещё`, 119 code points ending `…`, no heading rendered, `aria-controls` resolves |
  | expanded  | `aria-expanded="true"`, label `Свернуть`, 4 real Markdown paragraphs, 806 chars |
  | round trip| expand → collapse returns to 119 chars / 1 paragraph / `…`             |
  | editing   | opens on the FULL source (803 chars, not the excerpt); toggle unmounts; cancel returns COLLAPSED |

  E2 confirmed with real layout, not review alone: the excerpt node carries
  exactly `min-w-0 break-words [overflow-wrap:anywhere]`, `scrollWidth` does not
  exceed the 296px card, and the document does not scroll horizontally in either
  state. Console across the whole expand → edit → cancel cycle: EMPTY — no
  "Rendered fewer hooks than expected", no warnings.

  With the suite green, review and clean up without changing behavior:

  - **SRP** — `markdownExcerpt` derives text and nothing else; `CollapsibleDescription`
    renders and nothing else. If the strip-markdown step has grown into a tangle of
    inline regexes, extract it as a named local function in the same module (do NOT
    export a second public symbol — nothing else needs it).
  - **DRY** — no duplicated class strings between the collapsed and expanded
    branches; no second copy of the excerpt logic in the component.
  - **KISS** — no options object, no configurable strip rules, no memo cache beyond
    the single `useMemo`. If a reviewer would call it overcomplicated, it is.
  - **Conventions** — `kebab-case.tsx`, named exports, `@/` alias, no `any`,
    comments only for the S3 WHY invariant.

  Then verify every S2 row and every acceptance line above against the running app.

  LOGGING: none.

  Acceptance: behavior identical before and after the refactor (suite stays green
  throughout); the S3 WHY comment is present; full verification list below passes.

  Files: as touched by the refactor

## Verification

### Integration-lane baseline (recorded 2026-09-17, T6)

`pnpm --filter maister-web test` does not go fully green on this host, and not
because of this change. Measured three ways, same 7 files:

| Run                                      | Files failed | Tests failed |
| ---------------------------------------- | ------------ | ------------ |
| full lane, parallel, changes PRESENT      | 7            | 8            |
| the 7 files, serial, changes PRESENT      | 5            | 6            |
| the 7 files, serial, changes ABSENT (HEAD)| 6            | 7            |

The pristine-HEAD baseline fails MORE than the working tree, and the failing set
drifts run to run within the same files (`owner-agent-budget` in one run,
`owner-agent-live-message` in the next), so these are flaky-or-broken at the
branch base, not deterministic regressions. `execution-host` D3 failed only in
the parallel run — a load flake under 14 concurrent Postgres containers.
`project-pull` + `projects-remotes` are the known host-specific pair.

Independently, the change is unreachable from that lane: `@/lib/markdown-excerpt`
is imported only by `task-card-description.tsx` and its own test,
`task-card-description` only by `task-card.tsx` and its own test, and none of the
7 failing files reference a message catalog or a board component.

Unit lane, which DOES cover this change, is green: 787 files / 8025 tests.


- `pnpm --filter maister-web lint` clean, no new warnings.
- `pnpm --filter maister-web test` green.
- `pnpm validate:docs` green.
- Every row of S1.2 and S2 demonstrably holds.
- Manual, on the Backlog column: a long-description card becomes title + ~2 lines +
  toggle; expanding restores the full Markdown; collapsing restores the short
  height; a short-description card is pixel-identical to before; the edit pencil
  opens the full source; **expanding then clicking edit then cancel does not throw**.
