# Implementation Plan: Flow Editor Prompt Assists

> For agentic workers: implement this plan task-by-task. The implementation
> phase is strict TDD: each behavior change must go RED -> GREEN -> refactor
> before moving on.

Goal: make Flow Studio coding-node prompts first-class authoring fields for
package skills and Mustache template variables. Coding nodes must let authors
insert package-local skills through the existing canonical `@skill:<slug>`
storage grammar, and must show node-aware `{{ }}` variable suggestions based on
the current flow position, form schemas, and structured outputs of earlier
nodes. Variables are classified on two orthogonal axes — graph availability
(`definite | conditional`) AND value presence (`required | optional`) — and
references that may be absent at runtime never hard-fail: the editor inserts
them through a new additive `{{ path ?? '' }}` default operator that the strict
renderer resolves to the literal when the path is absent.

Branch: none (detached HEAD `9747b074` in this worktree)
Created: 2026-06-28
Spec target: `.ai-factory/specs/feature-flow-editor-prompt-assists.md`

## Settings

- Testing: yes. Implementation is strict TDD with RED evidence, GREEN evidence,
  and a refactor checkpoint per behavior task.
- Logging: verbose where runtime/server code is touched. Pure client/editor
  helpers do not log; runtime prompt normalization logs DEBUG token decisions
  only when an existing logger is available.
- Docs: yes. Phase 0 is a mandatory docs/spec checkpoint before code. API
  contracts, DB docs, migrations, and system analytics are explicitly audited.

## Roadmap Linkage

Milestone: "M27/M35/M36 Flow Studio authoring continuation; M14 capability
materialization authoring surface"

Rationale: the feature is an authoring-side continuation of Flow Studio editor
work and uses the M14 capability grammar already implemented by the unified
capability composer. It introduces no new runtime milestone, engine bump, route,
DB table, or run state. The one runtime touch — the additive `{{ path ?? '' }}`
default operator in `templating.ts` — is a backward-compatible render-time
helper (no engine floor, ADR-091 precedent), recorded in ADR-115 as a
render-time templating addendum rather than an engine-versioned DSL change.

## Problem Statement

Flow Studio already has a capability composer and package-derived skill catalog
for `ai_coding`, `judge`, and `orchestrator` prompt fields, but the authoring
experience is incomplete:

- selected skill chips store canonical `@skill:<slug>`, but raw typed or pasted
  `/skill` / `$skill` in the coding-node composer is not yet promoted through the
  existing matcher backstop;
- prompt authors can use strict Mustache paths such as
  `{{ steps.plan.vars.verdict }}`, but the editor does not show which variables
  are actually available at the selected node;
- structured outputs and form submissions already land in `node_attempts.vars`,
  but the authoring surface does not inspect `output.result.schema` or
  `settings.form_schema` to enumerate field-level `steps.<id>.vars.*` paths.

## Ground Truth Confirmed

- `NodeSideForm` renders `CapabilityComposer` for `ai_coding`, `judge`, and
  `orchestrator` prompts when a `promptCatalog` is present.
- `LocalPackageEditor` builds `promptCatalog` from package-local
  `skills/<slug>/SKILL.md` files and chooses the prompt adapter from the package
  runner config.
- `CapabilityComposer` stores selected skills as canonical `@skill:<slug>` and
  renders `/`, `$`, and `@` suggestions.
- `normalizeCapabilityTokens` already turns canonical skills into runner wire
  forms (`/skill` for Claude, `$skill` for Codex) in `runner-agent.ts` after
  Mustache rendering.
- `matchCapabilityTokens` already promotes raw `/skill`, `$skill`, and
  `@agent` text to canonical tokens, but it is not wired into the editable
  coding-node path.
- Runtime template context already exposes `task`, `run`, `executor`, `steps`,
  `env`, and `artifacts`; docs drift in `docs/flow-dsl.md` was corrected from
  stale `runner.*` rows to `executor.*`.
- The strict renderer (`web/lib/flows/templating.ts:54-62`) throws
  `MaisterError("CONFIG")` on BOTH a missing key AND a present-but-`undefined`
  value, and the Proxy makes even Mustache section guards (`{{#x}}…{{/x}}`)
  throw. So context-optional paths (`executor.router` is set to `undefined` when
  no CCR sidecar — `context.ts`), optional schema fields, and `artifacts.*.uri`
  hard-fail at LAUNCH today. There is no native-safe form — hence the additive
  `{{ path ?? '' }}` operator (Locked Decision 2).
- Structured output from `ai_coding`/`judge` sentinel blocks and
  `cli`/`check` `MAISTER_OUTPUT_FILE` is validated against `output.result.schema`
  and merged into `node_attempts.vars`, which downstream nodes read through
  `{{ steps.<nodeId>.vars.<field> }}`.
- Form nodes persist submitted form values as their node attempt `vars`, also
  readable through `steps.<nodeId>.vars.*`.
- Flow artifacts declared by upstream node outputs are exposed through the
  runtime `artifacts.<artifactId>.kind|uri|validity|nodeId` context; prompt
  assists should surface these only when the producing node is available to the
  selected node.

## Locked Decisions

1. No DSL shape change. `action.prompt` remains a string in `flow.yaml`. The
   manifest Zod shape, node graph, and validator are untouched.
2. One scoped runtime change is in scope: an **additive `{{ path ?? <literal> }}`
   default operator** in the strict renderer (`web/lib/flows/templating.ts`).
   `definite + required` variables insert as plain text
   (`{{ steps.plan.vars.verdict }}`); `conditional` OR `optional` variables
   insert with an explicit default (`{{ steps.plan.vars.verdict ?? '' }}`). A
   **bare** `{{ path }}` stays strict — absent/undefined still throws
   `MaisterError("CONFIG")` (typo protection preserved). This is the ONLY runtime
   behavior change; it is render-time-only and backward compatible (no existing
   prompt uses the operator), so no `engine_min` floor (ADR-091 precedent —
   render-time additive features carry no compile gate). The change is recorded
   in **ADR-115** in Phase 0 (see T0.1).
3. Canonical capability storage remains `@skill:<slug>` / `@agent:<slug>`.
4. Skill suggestions stay package-local for Flow Studio portability. Do not
   pull project/global/platform capabilities into package-authored flow prompts.
5. Variable suggestions carry TWO orthogonal axes.
   **(a) Graph availability** — node-aware:
   - `definite`: the producer dominates the selected node; every static path
     from the entry node to the selected node passes through the producer;
   - `conditional`: the producer can reach the selected node, but at least one
     static path to the selected node bypasses it;
   - `unavailable`: future/successor nodes, omitted from suggestions.
   The selected node's own `steps.<id>.*` values are omitted for action prompts
   because they do not exist before that node executes.
   **(b) Value presence** — `required | optional`. A path is `optional` when the
   value may be absent EVEN IF its producer ran: optional context fields
   (`executor.router`, `steps.<id>.exitCode` on non-`cli`/`check` producers),
   schema fields whose JSON Schema does not mark them `required`, optional
   artifact fields (`artifacts.<id>.uri`), and every `conditional`-availability
   path (the producer itself may not run). The two axes compose: the editor
   inserts the `?? ''` default form when a path is `conditional` OR `optional`,
   and plain text only when `definite` AND `required`. (Per the owner's call,
   the weakly-useful optional context fields `executor.router` /
   `steps.<id>.exitCode` are surfaced as `conditional`/`optional` suggestions,
   not omitted — they are rarely needed but valid.)
6. Field-level `vars.*` suggestions come only from a declared schema:
   `output.result.schema` or `settings.form_schema`. Arbitrary stdout is exposed
   only as `steps.<id>.output` (always a string, never absent → `required`).
   Each schema field carries its JSON-Schema `required`-ness onto the presence
   axis above.
7. Artifact suggestions come only from upstream declared `output.produces`
   entries and use the runtime `artifacts.*` shape
   (`kind|uri|validity|nodeId`). Future artifacts are omitted and conditional
   artifacts carry the same availability badge as their producing node. `uri` is
   optional in the runtime shape → it is `optional` on the presence axis and is
   inserted with the `?? ''` default.
8. Missing or invalid schema files do not crash the editor. They produce a
   warning entry for the root (`steps.<id>.vars`) and a validation message.
9. Schema-file lookup must use the existing schema-ref/path helpers and accept
   only package-root `schemas/*.json` files. Do not resolve arbitrary draft file
   paths, `../` paths, nested schema paths, rules, skills, or installed package
   files as schema sources.
10. Raw slash/dollar promotion is an editor serialization backstop scoped to the
    prompt field's package-local skill catalog. It runs at the **blur/save
    commit boundary**, NOT on every keystroke — promoting mid-type would feed the
    promoted `@skill:` token back into the controlled TipTap editor and pop a
    chip while the author is still typing (cursor-jump hazard). It must not run
    as a manifest-wide YAML normalizer, must not mutate extension strings, and
    must not infer agents unless an explicit agent catalog is supplied later.
11. The editor may provide both keyboard suggestions (`/`, `$`, `{{`) and a
    compact `{}` variable button with tooltip, but no explanatory text block in
    the prompt surface.
12. `env.*` keys are runtime-filtered and are not enumerable in the editor. The
    catalog may expose an `env` root/manual example, but must not invent keys.
13. No new dependency: reuse TipTap and the existing `CapabilityComposer`.
14. Beyond the scoped `??` operator in §2, no new HTTP route, SSE event, DB
    migration, env var, sidecar, port, `MaisterError` code, or `engine_min` bump.
    The `??` operator adds NO new error code (it removes a throw for the guarded
    form; the bare form keeps throwing `CONFIG`). If Phase 0 surfaces a need for
    anything else in this list, stop and amend this plan before implementation.

## Acceptance Criteria

- AC1. In editable coding-node prompts, package skills are discoverable by `/`
  and `$`, inserted as canonical `@skill:<slug>`, and sent as the effective
  runner's native command syntax.
- AC2. Raw typed or pasted `/skill` and `$skill` that exactly match the package
  catalog are promoted to canonical storage; non-matches like `/usr/bin`,
  `$HOME`, and incomplete tokens remain literal.
- AC3. Typing `{{` in a coding-node prompt opens variable suggestions; selecting
  a variable inserts its `insertText` as plain text (bare `{{ path }}` for
  `definite`+`required`, `{{ path ?? '' }}` otherwise — see AC8b).
- AC4. Variable suggestions include static globals (`task.*`, `run.*`,
  `executor.*`), `steps.<id>.output` (always-present string), `steps.<id>.exitCode`
  (only for `cli`/`check` producers; `optional` elsewhere), schema-known
  `steps.<id>.vars.*` fields from available previous nodes, and declared upstream
  `artifacts.<artifactId>.*` fields.
- AC5. Structured-output schemas and form schemas enumerate nested object fields
  using dotted paths, including optional fields, with type AND `required|optional`
  metadata in the suggestion description. A schema field absent from the JSON
  Schema `required` list is classified `optional` on the presence axis.
- AC6. Successor/future nodes are not suggested. Conditional upstream nodes are
  suggested with a conditional badge/warning, not falsely described as definite.
- AC7. Declared rework `commentsVar` values are suggested as top-level variables
  and marked as empty unless a rework path injects comments.
- AC8. Unknown `{{ }}` paths in the current prompt surface non-blocking editor
  warnings; the runtime strict renderer still owns hard failure for the bare form.
- AC8b. Inserting a `conditional` OR `optional` variable produces the
  `{{ path ?? '' }}` default form; inserting a `definite` AND `required` variable
  produces plain `{{ path }}`. The usage analyzer treats a `?? ''`-guarded path
  as safe (no warning), and a BARE reference to a `conditional`/`optional` path as
  an advisory warning ("may be absent at runtime — add a default").
- AC8c. The strict renderer resolves `{{ path ?? '<literal>' }}` to the literal
  when `path` is absent/undefined and to the value otherwise, and NEVER throws for
  the guarded form. A bare `{{ path }}` keeps throwing `MaisterError("CONFIG")` on
  absent/undefined. No `engine_min` bump; existing prompts render byte-identically.
- AC9. Read-only viewer/inspector surfaces degrade safely without fetching or
  computing edit-only catalogs.
- AC10. No API, DB, migration, AsyncAPI, deployment, or engine-min change ships
  for this feature. The single in-scope runtime change is the additive `??`
  default operator in `templating.ts` (ADR-115 + `flow-dsl.md`
  Templating doc); anything beyond it requires an explicit Phase 0 amendment.
- AC11. All new tests are runnable by existing configured lanes; no dead tests,
  skipped edge cases, or duplicated trivial coverage.
- AC12. After skill or variable edits, the hidden `flowYaml` still parses and
  validates as the same Flow DSL shape; raw-token promotion never corrupts YAML
  scalars, quotes, braces, or unrelated manifest fields.

## Contract Surface Trace

| Surface | Expected change | Plan action |
| --- | --- | --- |
| Flow DSL / Zod manifest shape | No shape change | Keep `action.prompt` as string; add docs for authoring aids only. |
| Runtime templating (`renderStrict`) | Additive `??` operator | Add the `{{ path ?? '<literal>' }}` default operator in `web/lib/flows/templating.ts`; bare `{{ path }}` stays strict. ADR-115 + `flow-dsl.md` Templating doc. |
| Runner prompt normalization | Existing behavior reused | Add raw-token promotion at the editor blur/save boundary for prompt-owned package skill strings only; keep canonical-to-wire normalization in `runner-agent.ts`. |
| HTTP API / OpenAPI | No route or body shape change | Phase 0 verifies no edit to `docs/api/web.openapi.yaml` or supervisor specs. |
| AsyncAPI / SSE | No event change | Phase 0 verifies no edit to `docs/api/async/*.yaml`. |
| DB / Drizzle migrations | No | Phase 0 verifies no schema/table/index change; no migration file. |
| `MaisterError` taxonomy | No | Bare strict template failures keep existing `CONFIG`; the `??` form removes a throw and adds no code. |
| Flow engine compat | No engine bump | `??` is render-time-only + backward compatible (ADR-091 precedent: render-time additive ⇒ no `engine_min` floor). |
| System analytics | Yes | Update `docs/system-analytics/flow-studio.md`; link existing structured-output context in `flow-graph.md` without changing runtime semantics. |
| Screen docs | Yes | Update `docs/screens/studio/editor.md` with skill and variable prompt assists. |
| Cross-cutting docs | Yes | Keep `docs/flow-dsl.md` template context aligned with runtime `executor.*`; document the `??` default operator in the Templating section. Fold the already-staged `runner.*`→`executor.*` table fix into Commit 1. |
| ADR log | Yes | Add ADR-115 in `docs/decisions.md` with the `??`-operator decision and no-engine-floor rationale. |
| i18n | Yes | Add EN/RU labels for variables, warnings, and availability badges. |
| Deployment | No | No env var, package dependency, sidecar, port, or compose change. |

## HTTP Route Identifier Audit

No HTTP route is added or changed. Therefore there are no new body-controlled
identifiers. If implementation discovers a need for a route, the plan must be
amended first with identifier labels (`url-param`, `auth-context`,
`server-state`, `body-controlled`) and OpenAPI updates.

## DB and Migration Audit

No DB write path is needed because:

- prompts are already stored as YAML strings in existing package draft files;
- variable suggestions are derived from the current manifest and package draft
  files in memory;
- structured outputs already persist in existing `node_attempts.vars`;
- forms already persist submitted values in existing `node_attempts.vars`.

If implementation adds any persisted preference, cache, validation result, or
catalog row, it must stop and amend this plan with a migration, ERD updates,
`docs/database-schema.md`, and relevant `docs/db/*.md` changes.

## Deployment Touchpoints

| New dep / runtime artifact | Required action |
| --- | --- |
| npm dependency | None. Reuse existing TipTap and React stack. |
| Env var | None. |
| Config file path | None. |
| Sidecar / binary | None. |
| Bound port | None. |
| Compose / Docker | No change. Phase 0 and final verification must confirm. |

## Test Strategy

- Runtime templating tests (`web/lib/flows/__tests__/templating.test.ts` or its
  existing home) cover the `??` operator: guarded path present → value; guarded
  path absent/undefined → literal, no throw; bare path absent → still throws
  `CONFIG`; nested dot-paths; single- and double-quoted and empty literals; a
  prompt mixing bare-required and `??`-guarded tokens. Because `templating.ts`
  is `server-only`, confirm the test runs in the project that loads server code
  (unit project's server config or `test:integration`), not a browser project.
- Pure helper unit tests cover graph reachability, variable catalog generation,
  schema field enumeration, raw token promotion, and variable-token warning
  classification.
- Presence-axis tests must prove `executor.router`, `steps.<id>.exitCode` on a
  non-`cli`/`check` producer, schema-optional fields, and `artifacts.<id>.uri`
  are classified `optional` and inserted with `?? ''`; `definite + required`
  paths insert bare.
- Graph helper tests must cover dominance/conditional classification, cycles,
  edges sourced from `transitions.*` AND `rework.allowedTargets` (a rework-only
  predecessor must be discovered), `decide`/`on_mismatch` targets, current-node
  omission, future-node omission, artifact availability, and a legacy linear
  `steps[]`-only manifest (no `nodes[]`) degrading to a predecessor chain rather
  than throwing.
- Serialization tests must prove the edited manifest still parses through the
  existing Flow schema and that raw-token promotion is scoped to prompt fields.
- Schema tests must prove only validated `schemas/*.json` draft files are read
  and that missing/invalid schemas become warnings instead of thrown editor
  errors.
- Component static tests cover prop wiring and no-catalog/read-only degradation.
- Browser E2E covers the interactive TipTap suggestion behavior that Node unit
  tests cannot exercise reliably.
- Existing structured-output runtime integration tests remain the runtime
  evidence; do not duplicate them unless behavior changes.
- Runnability must be confirmed for every new test path with the existing
  `web/vitest.workspace.ts` globs or by extending the runner in the same phase.

## Commit Plan

- Commit 1 (Phase 0): `docs(studio): freeze prompt-assist SDD + ADR` — also folds
  the already-staged `docs/flow-dsl.md` `runner.*`→`executor.*` table fix.
- Commit 1b (Phase 0b): `feat(flows): add additive {{ x ?? '' }} template default operator`
- Commit 2 (Phase 1): `feat(studio): add node-aware template variable catalog`
- Commit 3 (Phase 2): `feat(capabilities): extend composer with variable suggestions`
- Commit 4 (Phase 3): `feat(studio): wire prompt assists into coding nodes`
- Commit 5 (Phase 4): `test(studio): cover prompt assists end-to-end`
- Commit 6 (Phase 5): `docs: reconcile prompt-assist contracts and validation`

## Tasks

### Phase 0 - SDD and Contract Audit

- [x] **T0.1 - RED-free SDD freeze before code.**
  - Create `.ai-factory/specs/feature-flow-editor-prompt-assists.md`.
  - The spec must include: goals, non-goals, DSL invariants, canonical skill
    storage, raw-token promotion rules, variable catalog rules, the two-axis
    classification (graph availability × value presence), the `??` default
    operator grammar + semantics, schema enumeration, warning behavior,
    acceptance criteria, and the no-API/no-DB/no-engine-bump contract.
  - The spec must explicitly define the selected-node availability algorithm:
    dominance means definite, reachable-with-bypass means conditional, current
    node outputs are unavailable, future nodes are omitted, and cycles/rework
    cannot cause unbounded traversal. It must enumerate the exact edge sources
    (`transitions.*`, `rework.allowedTargets`, `decide`/`on_mismatch` targets,
    `finish.human.decisions` routed through matching `transitions` outcomes) and
    the legacy linear `steps[]`-only degrade path.
  - The spec must define the PRESENCE axis: a path is `optional` when absent even
    if its producer ran (`executor.router`, `steps.<id>.exitCode` off
    `cli`/`check`, schema-non-`required` fields, `artifacts.<id>.uri`, and every
    `conditional` path). Optional/conditional inserts use `{{ path ?? '' }}`;
    `definite + required` insert bare.
  - The spec must define the `??` operator: grammar
    `{{ <dotpath> ?? <string-literal> }}` (`''`/`""`/`'...'`/`"..."`), render-time
    resolution (guarded absent → literal, never throws; bare absent → still
    `CONFIG`), backward compatibility, and the no-`engine_min` rationale
    (ADR-091 precedent). The exact rework comments var path is `rework.commentsVar`.
  - The spec must cover artifact variables, env non-enumeration, schema path
    confinement, and prompt-field-only raw slash/dollar promotion at blur/save.
  - The spec must explicitly map every user requirement to an acceptance
    criterion or a non-goal.
  - Add ADR-115 in `docs/decisions.md` with the `??`-operator decision. The ADR
    states: the strict-throw-on-absent problem it solves, the grammar,
    render-time semantics, the editor two-axis driver, and the no-engine-floor
    call.
  - Files: `.ai-factory/specs/feature-flow-editor-prompt-assists.md`,
    `docs/decisions.md`.
  - Logging requirements: no runtime logging in this docs task.
  - Verify: `pnpm validate:docs` after T0.2.

- [x] **T0.2 - Update analytics and screen docs first.**
  - Docs-first ordering means these sections are marked **`(Designed)`** at this
    task per docs R6 (Implemented = present in branch) and flipped to
    `(Implemented)` in T5.1 once code lands. Do NOT label them Implemented now.
  - Update `docs/system-analytics/flow-studio.md` with a `(Designed)` section for
    coding-node prompt assists: package-local skill autocomplete, canonical
    storage, `{{ }}` variable catalog, the two-axis (availability × presence)
    classification, and the one scoped runtime change (the `??` default operator).
  - Update `docs/screens/studio/editor.md` with the prompt editor surface:
    skill suggestions, variable suggestions, `{}` affordance if implemented,
    optional-variable `?? ''` insertion, warnings, and read-only degradation.
  - Update `docs/flow-dsl.md`: (a) fold the already-staged `runner.*`→`executor.*`
    context-table fix (it is currently uncommitted in this worktree); (b) add a
    Templating-section subsection documenting the `{{ path ?? '<literal>' }}`
    default operator (grammar, render-time semantics, bare-vs-guarded, no
    `engine_min` floor).
  - Add or update a docs guard note so `runner.*` does not reappear as a
    template context alias.
  - Files: `docs/system-analytics/flow-studio.md`,
    `docs/screens/studio/editor.md`, `docs/flow-dsl.md`.
  - Logging requirements: no runtime logging in docs.
  - Verify: `pnpm validate:docs`.

- [x] **T0.3 - Contract guard checklist.**
  - Before production code, record the contract audit in the spec:
    - `rg -n "action.prompt|promptComposer|CapabilityComposer" web/components web/lib docs`
    - `rg -n "output.result|form_schema|node_attempts.vars|steps.<id>.vars" docs web/lib`
    - `rg -n "artifacts\\.|executor\\." docs/flow-dsl.md web/lib/flows web/lib/runs`
    - `rg -n "\\{\\{[^}]*runner\\." docs/flow-dsl.md` — template-context-scoped:
      bare `runner:` config keys / `runner_profiles` / unified-runner-config are
      legitimate and must NOT be flagged; only `{{ runner.* }}` template usage is.
    - `rg -n "openapi|asyncapi|migrations|engine_min" docs web/lib/config.schema.ts`
    - `git --no-pager diff --name-only -- docs/api docs/db web/lib/db web/db supervisor`
  - Acceptance: no API/DB/migration/supervisor contract edit is required at
    Phase 0 HEAD (the `??` operator touches only `web/lib/flows/templating.ts`,
    not these paths), and `{{ runner.* }}` has zero template-context hits; if this
    changes later, stop and amend the plan.
  - Files: spec note only.
  - Logging requirements: no runtime logging.
  - Verify: `git --no-pager diff --check`.

### Phase 0b - Runtime Optional-Default Operator (`??`)

This phase ships the only runtime change and lands BEFORE the editor inserts the
`?? ''` form (the editor depends on the renderer understanding it).

- [x] **T0b.1 - RED: `??` default operator tests.**
  - Add failing tests in the existing templating test home
    (`web/lib/flows/__tests__/templating.test.ts`; confirm exact path, create if
    absent and wire into the server-capable test project).
  - Cover:
    - `{{ executor.model ?? '' }}` with a present value → the value;
    - `{{ executor.router ?? '' }}` with router absent/undefined → `''`, no throw;
    - `{{ steps.x.vars.maybe ?? "n/a" }}` absent → `n/a`; present → the value;
    - bare `{{ executor.router }}` absent → still throws `MaisterError("CONFIG")`;
    - single-quote, double-quote, and empty literals all parse;
    - a template mixing a bare required token and a `??`-guarded token renders
      the required token strictly and the guarded token safely;
    - a `??` literal containing `{{`/`}}` is inserted verbatim post-render (not
      re-parsed by Mustache).
  - Expected RED: the operator is not recognized; guarded form throws today.
  - Files: test only.
  - Logging requirements: keep the existing DEBUG trace; no new logging.
  - Verify RED: focused vitest run of the templating test in the server project.

- [x] **T0b.2 - GREEN: implement the `??` operator in `renderStrict`.**
  - Update `web/lib/flows/templating.ts`. Suggested approach: a pre-render pass
    extracts `{{ <dotpath> ?? <string-literal> }}` tags, resolves `<dotpath>`
    with a NON-throwing deep getter over the raw (un-proxied) context, swaps each
    for a unique post-render placeholder, runs strict Mustache over the remainder
    (bare tags keep throwing via the proxy), then substitutes the resolved scalar
    for each placeholder. This preserves strict typo-protection for bare tags and
    avoids re-parsing resolved scalars.
  - The operator adds NO new `MaisterError` code and NO `engine_min` floor.
  - Files: `web/lib/flows/templating.ts`.
  - Logging requirements: DEBUG-log the guarded-token default decision only when
    the existing logger is present.
  - Verify GREEN: T0b.1 passes; run the full templating + runner-agent unit tests
    to prove no regression in existing strict behavior.
  - Refactor checkpoint: keep the pre/post-pass as small pure helpers.

### Phase 1 - Pure Variable Catalog and Prompt Analysis

- [x] **T1.1 - RED: template variable catalog tests.**
  - Add failing unit tests in
    `web/lib/flows/editor/__tests__/template-variable-catalog.test.ts`.
  - Cover:
    - static globals: `task.id`, `task.title`, `task.prompt`,
      `task.attemptNumber`, `run.id`, `run.attemptNumber`,
      `run.projectSlug`, `executor.id`, `executor.agent`, `executor.model`
      (all `required`), and `executor.router` (`optional` — present-but-undefined
      at runtime when no CCR sidecar);
    - predecessor node roots: `steps.<id>.output` (`required` string),
      `steps.<id>.vars` (root), and `steps.<id>.exitCode` classified `required`
      only for a `cli`/`check` producer, `optional` otherwise;
    - the selected current node's own `steps.<id>.*` values are omitted;
    - successor/future nodes are omitted for the selected current node;
    - graph edges are sourced from `transitions.*` AND `rework.allowedTargets`:
      a node reachable ONLY via a rework-allowed-target edge is still discovered
      as a predecessor;
    - branch-only predecessors are marked `conditional`;
    - a producer that dominates the selected node is marked `definite`;
    - cyclic/rework topology terminates and marks bypassable producers
      `conditional`;
    - a legacy linear `steps[]`-only manifest (no `nodes[]`) degrades to a
      predecessor chain (earlier steps available) without throwing;
    - presence axis: a JSON-Schema field absent from `required` is `optional`;
      a `conditional`-availability path is `optional` regardless of schema;
    - form `settings.form_schema` fields enumerate
      `steps.<formId>.vars.<field>`;
    - `output.result.schema` fields enumerate
      `steps.<nodeId>.vars.<field>`;
    - nested object fields produce dotted variable paths;
    - upstream declared artifacts enumerate
      `artifacts.<artifactId>.kind|uri|validity|nodeId`, with `uri` `optional`;
    - future/own-node artifacts are omitted and conditional artifacts are
      marked `conditional`;
    - `env.*` keys are not enumerated;
    - schema refs outside root `schemas/*.json` are ignored with warnings, not
      parsed;
    - missing/invalid schema gives a warning root but no thrown editor error;
    - declared `rework.commentsVar` appears as a top-level `conditional`
      variable (empty unless a rework path injects comments).
  - Expected RED: module/export does not exist.
  - Files: test only.
  - Logging requirements: pure test/helper path, no logging.
  - Verify RED:
    `pnpm --filter maister-web exec vitest run --project unit lib/flows/editor/__tests__/template-variable-catalog.test.ts`.

- [x] **T1.2 - GREEN: implement `template-variable-catalog.ts`.**
  - Create `web/lib/flows/editor/template-variable-catalog.ts`.
  - Export typed entries such as:
    - `TemplateVariablePath`
    - `TemplateVariableAvailability = "definite" | "conditional"`
    - `TemplateVariablePresence = "required" | "optional"`
    - `TemplateVariableEntry` (carries BOTH axes + an `insertText` field that is
      the bare path when `definite && required`, else `path ?? ''`)
    - `TemplateVariableCatalogResult`
  - Keep the helper pure and client-safe: no DB, env, filesystem, or
    `server-only` imports.
  - Reuse existing config/schema types where client-safe, and parse schema file
    contents from already-loaded draft files.
  - Use an explicit graph analysis:
    - build directed edges from manifest `transitions.*` whose target is a node
      id AND from `rework.allowedTargets` (and `decide`/`on_mismatch` targets,
      which are a subset of `transitions` keys);
    - omit terminal targets and unknown targets from traversal;
    - if the manifest has no `nodes[]` (legacy linear `steps[]`), degrade to a
      simple predecessor chain over `steps[]` order;
    - find candidate producers that can reach the selected node;
    - mark a producer `definite` only if every path from the flow entry to the
      selected node passes through that producer;
    - mark reachable non-dominating producers `conditional`;
    - omit the selected node's own outputs and all nodes that cannot reach the
      selected node;
    - use iterative visited sets/fixed-point traversal for loops and rework.
  - Compute the PRESENCE axis: schema fields off the JSON-Schema `required` list,
    `executor.router`, `steps.<id>.exitCode` off non-`cli`/`check` producers,
    `artifacts.<id>.uri`, and every `conditional`-availability path are `optional`;
    set `insertText` accordingly.
  - Resolve schema refs only through existing schema-ref/path validation helpers
    and only against loaded draft files under root `schemas/*.json`.
  - Derive artifact entries from upstream `output.produces` declarations and
    the runtime `FlowContext.artifacts` shape.
  - Export a static/global variable definition list used by tests and docs
    checks so `executor.*` cannot drift back to `runner.*`.
  - Files: `web/lib/flows/editor/template-variable-catalog.ts`.
  - Logging requirements: pure helper, no logging.
  - Verify GREEN: T1.1 command passes.
  - Refactor checkpoint: remove duplication only inside this helper and adjacent
    test fixtures.

- [x] **T1.3 - RED: prompt template token warning tests.**
  - Add failing tests for a pure scanner in
    `web/lib/flows/editor/__tests__/template-variable-usage.test.ts`.
  - Cover:
    - finds `{{ steps.plan.vars.verdict }}` and maps it to a known catalog
      entry;
    - parses the `{{ path ?? '<literal>' }}` form: extracts `path` (ignoring the
      default) for classification, and treats a `??`-guarded `conditional`/
      `optional` path as SAFE (no warning);
    - a BARE reference to a `conditional`/`optional` path emits an advisory
      "may be absent at runtime — add a default" warning;
    - ignores non-variable Mustache section syntax if unsupported by the editor
      catalog, but preserves runtime behavior;
    - warns for unknown/future paths (stronger severity than the bare-optional
      advisory);
    - warns for unavailable current-node output references;
    - treats `artifacts.<id>.*` the same way as step variables for
      known/conditional/unknown classification;
    - does not warn for canonical skill tokens or raw slash tokens.
  - Expected RED: scanner/export does not exist.
  - Files: test only.
  - Logging requirements: pure test/helper path, no logging.
  - Verify RED:
    `pnpm --filter maister-web exec vitest run --project unit lib/flows/editor/__tests__/template-variable-usage.test.ts`.

- [x] **T1.4 - GREEN: implement prompt template usage analysis.**
  - Implement `analyzeTemplateVariableUsage(prompt, catalog)` in the same
    editor helper area.
  - Keep warnings non-blocking. Runtime strict Mustache remains the hard gate.
  - Return typed warning objects that UI can render without string matching.
  - Files: `web/lib/flows/editor/template-variable-catalog.ts` or a sibling
    `template-variable-usage.ts` if separation is clearer.
  - Logging requirements: pure helper, no logging.
  - Verify GREEN: T1.1 and T1.3 commands pass.

### Phase 2 - Composer Variable Suggestions and Raw Slash Backstop

- [x] **T2.1 - RED: composer serialization and raw-token tests.**
  - Extend existing capability composer unit tests or add focused tests under
    `web/lib/capabilities/__tests__/composer-serialize.test.ts`.
  - Cover:
    - `{{ }}` text round-trips as plain text, not as a chip;
    - `matchCapabilityTokens` is applied to composer output when a catalog is
      present;
    - `/aif-plan ` and `$aif-plan ` become `@skill:aif-plan `;
    - `/usr/bin`, `$HOME`, and `/missing` stay literal;
    - canonical `@skill:aif-plan` stays canonical;
    - only `kind: "skill"` catalog entries are promoted in this feature slice;
    - non-prompt/freeform manifest strings containing `/aif-plan` are not
      normalized by any YAML-wide path;
    - the serialized prompt containing `@skill:*` and `{{ * }}` still validates
      inside a Flow manifest fixture.
  - Expected RED: composer output does not promote raw slash tokens.
  - Files: tests only.
  - Logging requirements: pure test path, no logging.
  - Verify RED:
    `pnpm --filter maister-web exec vitest run --project unit lib/capabilities components/capabilities`.

- [x] **T2.2 - GREEN: wire raw-token matcher into composer output.**
  - Update `web/components/capabilities/capability-composer.tsx` and, if needed,
    `web/lib/capabilities/composer-serialize.ts`.
  - Apply `matchCapabilityTokens` only to serialized text using the current
    prompt catalog filtered to package-local skills; do not mutate unsupported
    or unmatched raw text.
  - Run promotion at the **blur/save commit boundary**, NOT on every keystroke
    `onChange` — promoting mid-type would feed the `@skill:` token back into the
    controlled editor and pop a chip while the author is still typing. Do not add
    a manifest-level normalizer, YAML post-processor, or package draft rewrite
    step.
  - Keep canonical storage stable for selected chips and raw promoted matches.
  - Files: `web/components/capabilities/capability-composer.tsx`,
    `web/lib/capabilities/composer-serialize.ts` if needed.
  - Logging requirements: no client logging.
  - Verify GREEN: T2.1 command passes.
  - Refactor checkpoint: keep matcher usage as a small, testable seam.

- [x] **T2.3 - RED: variable suggestion interaction tests.**
  - Add or extend static component tests in
    `web/components/capabilities/__tests__/capability-composer.test.ts`.
  - Add Playwright coverage later in T4 for actual TipTap popup behavior.
  - Static/unit coverage should assert:
    - variable labels render when `variableCatalog` is provided;
    - variable entries use a distinct suggestion item type and cannot be
      selected as capability chips;
    - an `optional`/`conditional` entry inserts `{{ path ?? '' }}` (its
      `insertText`); a `definite`+`required` entry inserts `{{ path }}`;
    - skill entries cannot be inserted as `{{ }}` variables;
    - read-only/disabled composer does not expose variable controls;
    - missing `variableCatalog` preserves existing scratch/skill behavior.
  - Expected RED: props and labels do not exist.
  - Files: tests only.
  - Logging requirements: no client logging.
  - Verify RED:
    `pnpm --filter maister-web exec vitest run --project unit components/capabilities/__tests__/capability-composer.test.ts`.

- [x] **T2.4 - GREEN: extend `CapabilityComposer` with variables.**
  - Add optional `variableCatalog`, `variableWarnings`, and labels for:
    variable group names, conditional badge, unknown warning, and optional `{}`
    trigger button tooltip.
  - Introduce a discriminated suggestion state/type for capability suggestions
    versus variable suggestions. Do not reuse `ProjectCapabilityCatalogEntry`
    for variable rows.
  - Implement `{{` suggestions with TipTap using a safe `{` trigger that opens
    only when the preceding character is `{`, replacing the full `{{query`
    range with the entry's `insertText` (`{{ path }}` for `definite`+`required`,
    `{{ path ?? '' }}` for `conditional`/`optional`).
  - Add the optional compact `{}` icon button only when `variableCatalog` is
    present and non-empty; it opens the same variable picker without explanatory
    inline text.
  - Suggestion filtering matches path, label, source node id, and field name.
  - Files: `web/components/capabilities/capability-composer.tsx`, composer CSS
    location if needed, `web/messages/en.json`, `web/messages/ru.json` for
    labels.
  - Logging requirements: no client logging.
  - Verify GREEN: T2.3 command passes, then run composer-related unit tests.

### Phase 3 - Flow Studio Wiring

- [ ] **T3.1 - RED: `NodeSideForm` prompt-assist prop tests.**
  - Update `web/components/flows/node-form/__tests__/node-side-form.test.ts`.
  - Cover:
    - `ai_coding`, `judge`, and `orchestrator` prompts pass variable catalogs to
      `CapabilityComposer`;
    - `cli`, `check`, `human`, `form`, and `consensus` prompts do not receive
      this coding-node prompt composer unless separately supported later;
    - read-only viewer still degrades to the existing plain textarea when no
      prompt catalog is supplied;
    - read-only viewer does not compute schema catalogs or parse draft schema
      files unnecessarily;
    - warning markup is present for unknown/conditional current prompt vars.
  - Expected RED: props/labels do not exist.
  - Files: tests only.
  - Logging requirements: component behavior must not log.
  - Verify RED:
    `pnpm --filter maister-web exec vitest run --project unit components/flows/node-form/__tests__/node-side-form.test.ts`.

- [ ] **T3.2 - GREEN: pass variable assists through `NodeSideForm`.**
  - Extend `NodeSideForm` props with:
    - `promptVariableCatalog?: TemplateVariableEntry[]`
    - `promptVariableWarnings?: TemplateVariableWarning[]`
  - Pass these props to `CapabilityComposer` only for prompt-bearing coding
    nodes.
  - Add EN/RU labels under existing `promptComposer`.
  - Files: `web/components/flows/node-form/node-side-form.tsx`,
    `web/messages/en.json`, `web/messages/ru.json`.
  - Logging requirements: no client logging.
  - Verify GREEN: T3.1 command passes.

- [ ] **T3.3 - RED: flow-editor selected-node catalog tests.**
  - Add unit tests for the editor composition seam where possible, using pure
    helper tests if React Flow makes static rendering too noisy.
  - Cover:
    - selected node id drives current variable catalog;
    - changing YAML/manifest recomputes schema-derived suggestions;
    - no selected node yields only global variables or no variable popup,
      according to the Phase 0 spec decision;
    - package draft schema files are the source of schema fields, not installed
      immutable files;
    - invalid schema refs such as `../secret.json`, `schemas/nested/x.json`, and
      `rules/foo.md` are ignored with validation warnings;
    - the editor composition helper returns a manifest-parseable prompt string
      after raw-token promotion.
  - Expected RED: catalog is not computed/passed.
  - Files: likely
    `web/components/flows/__tests__/flow-editor-sync.test.ts` and/or a new
    `web/lib/flows/editor/__tests__/prompt-assist-compose.test.ts`.
  - Logging requirements: pure helper path no logging; existing
    `debugLog` in `FlowGraphEditor` remains unchanged.
  - Verify RED:
    `pnpm --filter maister-web exec vitest run --project unit components/flows lib/flows/editor`.

- [ ] **T3.4 - GREEN: compute and pass node-aware variable catalogs.**
  - Update `FlowGraphEditor` to derive the selected node's variable catalog from
    the current manifest, topology, selected node id, and package draft files.
  - Update `LocalPackageEditor` to pass the relevant draft schema files into the
    graph editor using the already-lifted `draftFiles` state.
  - Filter schema draft files through the same root `schemas/*.json` validator
    used by the pure catalog helper before parsing JSON.
  - Do not add a server fetch. Do not read installed package files.
  - Files: `web/components/flows/flow-graph-editor.tsx`,
    `web/components/studio/local-package-editor.tsx`,
    `web/components/flows/flow-editor-tabs.tsx` if prop threading is needed.
  - Logging requirements: no new logging; existing dev-only `debugLog` may stay.
  - Verify GREEN: T3.3 command passes.
  - Refactor checkpoint: keep catalog derivation in pure helpers; React
    components should only wire props.

### Phase 4 - Browser E2E and Edge Cases

- [ ] **T4.1 - RED: Flow Studio prompt-assist E2E.**
  - Extend `web/e2e/studio-local-edit.spec.ts` or add
    `web/e2e/studio-prompt-assists.spec.ts`.
  - Cover one browser path with minimum overlap:
    - select an `ai_coding` node;
    - type `/`, choose a package skill, assert hidden `flowYaml` contains
      `@skill:<slug>`;
    - type raw `/skill ` without selecting, blur/save, assert canonical storage;
    - type `{{`, choose a `definite`+`required` structured-output/form variable,
      assert prompt contains bare `{{ steps.<id>.vars.<field> }}`;
    - choose an upstream artifact variable (`uri` is optional) and assert the
      prompt contains `{{ artifacts.<id>.uri ?? '' }}`;
    - choose a `conditional` upstream variable and assert it inserts the
      `{{ path ?? '' }}` form AND shows a visible conditional marker;
    - assert a future node's variables do not appear;
    - assert the hidden `flowYaml` value parses after the edit, preserving
      braces and canonical skill tokens.
  - Add the spec to the existing E2E selection mechanism only if required, and
    document the runner command in the test file comment if this repo pattern
    uses one.
  - Expected RED: variable popup/raw matcher behavior is missing.
  - Files: E2E test only.
  - Logging requirements: no runtime logging.
  - Verify RED: run the focused Playwright command used by the existing Studio
    E2E lane.

- [ ] **T4.2 - GREEN: finish interaction details and edge-case fixes.**
  - Implement any missing keyboard/mouse behavior surfaced by T4.1.
  - Ensure text does not overflow suggestion rows; keep popup dimensions stable.
  - Ensure `{}` variable button, if implemented, is keyboard accessible and has a
    tooltip/aria label.
  - Files: `web/components/capabilities/capability-composer.tsx` and CSS/i18n
    files if needed.
  - Logging requirements: no client logging.
  - Verify GREEN: T4.1 focused E2E passes.

### Phase 5 - Documentation and Contract Reconciliation

- [ ] **T5.1 - Reconcile docs to as-built behavior.**
  - Flip the `flow-studio.md` / `editor.md` prompt-assist sections from
    `(Designed)` (set in T0.2) to `(Implemented)` now that code is in the branch.
  - Update the Phase 0 spec and docs if implementation made any acceptable
    scoped deviation.
  - Confirm docs still state:
    - no new route;
    - no DB migration;
    - no engine bump;
    - no new error code;
    - the `??` default operator is documented in `docs/flow-dsl.md` Templating
      and backed by Phase 0 ADR-115;
    - structured outputs are existing runtime behavior, not newly introduced by
      this UI feature;
    - `docs/flow-dsl.md` lists `executor.*`, not stale `runner.*`, for the
      current template context.
  - Files: `.ai-factory/specs/feature-flow-editor-prompt-assists.md`,
    `docs/system-analytics/flow-studio.md`,
    `docs/screens/studio/editor.md`, `docs/flow-dsl.md`.
  - Logging requirements: no runtime logging in docs.
  - Verify: `pnpm validate:docs`.

- [ ] **T5.2 - Contract audit before completion.**
  - Run and record:
    - `git --no-pager diff --name-only -- docs/api docs/db web/lib/db web/db supervisor`
    - `git --no-pager diff --name-only -- web/drizzle web/lib/db docs/database-schema.md docs/db`
    - `rg -n "engine_min|schemaVersion" docs web/lib/config.schema.ts`
    - `rg -n "\\{\\{[^}]*runner\\." docs/flow-dsl.md` — template-context-scoped
      only; `runner:` config keys are legitimate and not flagged
    - `rg -n "matchCapabilityTokens|normalizeCapabilityTokens" web/components web/lib`
  - Acceptance:
    - if the output is empty or docs-only as expected, no contract expansion;
    - `{{ runner.* }}` has no current-template-context doc hits;
    - matcher usage remains confined to prompt serialization/runtime capability
      normalization, not a manifest-wide normalizer;
    - if any API/DB/supervisor/migration file changed, implementation must have
      amended Phase 0, specs, docs, and tests before this task can complete.
  - Files: spec note only if needed.
  - Logging requirements: no runtime logging.
  - Verify: `git --no-pager diff --check`.

### Phase 6 - Suite Green and Implementation Handoff

- [ ] **T6.1 - Focused test gate.**
  - Run focused tests for new code:
    - the `??` templating test in its server-capable project (Phase 0b);
    - `pnpm --filter maister-web exec vitest run --project unit lib/flows/editor/__tests__/template-variable-catalog.test.ts lib/flows/editor/__tests__/template-variable-usage.test.ts`
    - `pnpm --filter maister-web exec vitest run --project unit lib/capabilities/__tests__/composer-serialize.test.ts components/capabilities/__tests__/capability-composer.test.ts components/flows/node-form/__tests__/node-side-form.test.ts`
    - focused Studio prompt-assist Playwright spec.
  - Acceptance: every new test is actually discovered by its runner and green.
  - Logging requirements: no runtime logging.

- [ ] **T6.2 - Full validation gate.**
  - Run:
    - `pnpm --filter maister-web typecheck`
    - `pnpm --filter maister-web test:unit`
    - `pnpm validate:docs`
    - `git --no-pager diff --check`
  - Run `pnpm --filter maister-web test:integration` — REQUIRED this feature,
    because Phase 0b modifies runtime prompt rendering (`templating.ts`).
  - Run Playwright Studio E2E on the host if the sandbox cannot start the dev
    server; do not mark E2E-covered behavior complete without either a green run
    or an explicit blocked note.
  - Logging requirements: no new logging.
  - Acceptance: all relevant lanes are green, or any unavailable lane is called
    out with the exact blocker and not treated as evidence.

## Test Integrity Checklist

- Every new unit test path is covered by `web/vitest.workspace.ts`; confirm with
  a focused command before implementation marks the task GREEN.
- Do not add tests that only assert rendering boilerplate. Every test must cover
  a requirement, edge case, or regression.
- Existing tests to migrate in-scope if behavior changes:
  - `web/components/capabilities/__tests__/capability-composer.test.ts`
  - `web/components/flows/node-form/__tests__/node-side-form.test.ts`
  - `web/e2e/studio-local-edit.spec.ts`
  - `web/lib/capabilities/__tests__/token-matcher.test.ts` if matcher
    expectations change.

## Explicit Non-Goals

- No support for CLI/check command field variable popups in this slice.
- No project/global/platform capability catalog in package-authored flow prompts.
- No live ACP `available_commands_update` integration in Flow Studio prompts.
- No new content-block, `@file`, attachment, or MCP prompt syntax.
- No schema editing changes; schema picker/builder work remains as already
  implemented.
- No runtime structured-output transport change.
- The `??` operator supports ONLY a quoted string-literal default (commonly
  `''`). No expression evaluation, no nested-variable defaults, no other
  operators, no change to the strict behavior of the bare `{{ path }}` form.
