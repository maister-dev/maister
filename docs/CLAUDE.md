# CLAUDE.md — `docs/` (MAIster Documentation)

> Read `../CLAUDE.md` first for the product spine, locked decisions, and
> current scope labels. This file is the contract for **how** to maintain the
> `docs/` folder — what lives where, in what format, and which rules apply
> when editing.

## Purpose of this folder

`docs/` is the canonical knowledge base for MAIster. It answers four
questions a human or agent should never have to dig through code for:

1. **What is the product?** — Vision, product view, JTBD.
2. **Why does it look like that?** — Architectural decisions and trade-offs.
3. **How is it built?** — C4 architecture, components, contracts.
4. **What are the contracts?** — OpenAPI, AsyncAPI, ERDs, error taxonomy.

When code and docs disagree, the **source code wins** (code is executable
truth). The fix is to update docs in the same PR.

## Artifact glossary

### Product layer

| File | What it answers |
| ---- | ---------------- |
| [`VISION.md`](VISION.md) | Product one-liner, principles, validation goal. |
| [`PRODUCT_VIEW.md`](PRODUCT_VIEW.md) | Target user, product model, JTBD, current scope, Phase 2. |
| [`getting-started.md`](getting-started.md) | Local setup, scripts, prerequisites. |

### Architecture layer

| File | What it answers |
| ---- | ---------------- |
| [`architecture.md`](architecture.md) | C4 Context + Container + Component diagrams, component table, dependency rules. |
| [`decisions.md`](decisions.md) | ADR log. Every locked architectural decision lives here. |

### Contract layer (`api/`)

| Path | Content | Format |
| ---- | ------- | ------ |
| [`api/web.openapi.yaml`](api/web.openapi.yaml) | Web tier HTTP API (REST). | OpenAPI 3.0.3 |
| [`api/supervisor.openapi.yaml`](api/supervisor.openapi.yaml) | Supervisor HTTP API (REST). | OpenAPI 3.0.3 |
| [`api/async/web-runs.asyncapi.yaml`](api/async/web-runs.asyncapi.yaml) | Browser-facing run SSE stream. | AsyncAPI 2.6.0 |
| [`api/async/supervisor-sse.asyncapi.yaml`](api/async/supervisor-sse.asyncapi.yaml) | Supervisor SSE event stream. | AsyncAPI 2.6.0 |
| [`api/async/outbound-webhooks.asyncapi.yaml`](api/async/outbound-webhooks.asyncapi.yaml) | Outbound webhook wire contract: envelope v1, headers, HMAC signature, per-type payloads (ADR-077). | AsyncAPI 2.6.0 |
| [`api/external/acp.asyncapi.yaml`](api/external/acp.asyncapi.yaml) | Narrow ACP stdio contract used by the supervisor. | AsyncAPI 2.6.0 |

### Data layer (`db/`)

The canonical per-file index is [`db/README.md`](db/README.md)
(gate-enforced complete; R7 — do not duplicate it here). Highlights: the
consolidated ERD is **generated DBML** ([`db/erd.dbml`](db/erd.dbml),
ADR-159 — never hand-edit; [`db/erd.md`](db/erd.md) is its wrapper);
per-domain ERDs are hand-maintained Mermaid; the narrative column/index/
cascade reference is [`database-schema.md`](database-schema.md).

### System analysis (`system-analytics/`)

Domain-grouped analyst artifacts: state machines, sequence diagrams, use
cases, process flows, expectations, edge cases. One file per domain,
structured per §R5. The canonical per-file index with one-line
descriptions is
[`system-analytics/README.md`](system-analytics/README.md)
(gate-enforced complete; R7 — do not duplicate it here).

### Screen reference (`screens/`)

Screenshot-free reference of the user-facing screens and shared chrome — one
file per screen / block / chrome element. Describes the **surface** (layout,
roles, navigation, states); links to `system-analytics/*` for behavior (R7).
The canonical index, global nav/IA map, per-doc template, and classification
rule live in [`screens/README.md`](screens/README.md) (gate-enforced
complete; do not duplicate it here).

### Cross-cutting reference

| File | What it answers |
| ---- | ---------------- |
| [`configuration.md`](configuration.md) | `maister.yaml` v2 + `flow.yaml` v1 + env vars. |
| [`error-taxonomy.md`](error-taxonomy.md) | `MaisterError` codes + UI actions. |
| [`supervisor.md`](supervisor.md) | Supervisor daemon prose reference. |
| [`flow-dsl.md`](flow-dsl.md) | Flow graph DSL and runner behavior. |
| [`flow-installer.md`](flow-installer.md) | Flow plugin install pipeline. |
| [`flow-aif-plugin.md`](flow-aif-plugin.md) | Bundled `aif` Flow plugin. |
| [`deployment.md`](deployment.md) | Production VPS install: systemd, Postgres, reverse proxy, git auth. |

### Planning & historical layers

| Path | What lives there |
| ---- | ---------------- |
| [`plans/`](plans/README.md) | Dated design docs that fed implementation. Historical records with mandatory kept-current `Status` headers; index in `plans/README.md`. |
| [`pv/`](pv/) | Product-vision working docs (roadmap rationale, feature briefs). Each carries a status banner; `improvement-roadmap.md` is fully historical. |
| [`spikes/`](spikes/) | Dated spike reports, including `2026-05-29-m8-spike-findings.md` (kept for its measurements). |
| [`superpowers/`](superpowers/) | Brainstorm→spec→plan outputs of the superpowers workflow; all shipped, headers current. |
| [`ru/`](ru/README.md) | Russian operator/user documentation (separate audience product per R8; EN docs stay canonical for architecture/API). |

## Rules

### R1. Format whitelist

Allowed in `docs/`:

- **Markdown** (CommonMark + GitHub-flavored tables and code fences).
- **Mermaid** diagrams, fenced as ` ```mermaid `.
- **YAML** for OpenAPI 3.0.3, AsyncAPI 2.6.0, JSON Schema, and `*.yaml`
  config examples inside Markdown fences.
- **DBML** for exactly one artifact: the generated consolidated ERD
  `db/erd.dbml` (ADR-159). Never hand-edit it — regenerate via
  `pnpm --filter maister-web db:erd`.

Anything else (PlantUML, draw.io XML, PNG screenshots, PDF) needs an ADR
in `decisions.md` first.

### R2. Mermaid is the only authored diagramming language

Every architectural, sequence, state, ERD, or flow diagram MUST be a
Mermaid block. The reasons are version control, AI-readability, and
zero-tool review. Hand-drawn images are rejected. Single exception: the
consolidated ERD is generated DBML (`db/erd.dbml`, ADR-159) — per-domain
ERDs stay Mermaid.

Mermaid usage requirements:

- First line declares the type: `C4Context`, `C4Container`, `C4Component`,
  `flowchart TD|LR`, `sequenceDiagram`, `stateDiagram-v2`, `erDiagram`,
  `classDiagram`.
- Every diagram must render in the [Mermaid Live Editor](https://mermaid.live)
  without errors. Validate before committing — see §Validation.
- Use C4 notation (`C4Context`, `C4Container`, `C4Component`) for the
  three top architectural views in `architecture.md`. Use plain
  `flowchart` / `sequenceDiagram` / `stateDiagram-v2` everywhere else.
- One diagram per concept. If a diagram exceeds ~25 nodes, split it.
- A block MUST stay under 50,000 characters — renderers enforce
  `maxTextSize` even though `mermaid.parse()` does not; the validator
  fails oversized blocks.
- Add a sentence of prose above each diagram naming the purpose. Never
  leave a diagram unannotated — readers should know what to look for
  before they scan it.

### R3. API contracts are OpenAPI 3.0.3 (REST) or AsyncAPI 2.6.0 (events)

- HTTP and HTTPS APIs are described as **OpenAPI 3.0.3** YAML files under
  `docs/api/`. One file per logical service.
- Event-based interactions (SSE, WebSocket, MQ, Kafka, intra-process event
  buses with cross-boundary semantics) are described as **AsyncAPI 2.6.0**
  YAML files under `docs/api/async/`. One file per channel set.
- Third-party APIs MAIster consumes are described in `docs/api/external/`.
  Use the upstream spec verbatim if it is published; otherwise write a
  narrow OpenAPI/AsyncAPI excerpt covering only the surface MAIster uses.
- Every spec MUST be valid against its meta-schema (Swagger/OpenAPI
  validator, AsyncAPI validator). See §Validation.
- API specs are the source of truth for the surface they describe.
  Implementation drift is a bug — fix code OR fix the spec, never both
  silently. Code-first generation is allowed; hand-edits must round-trip
  through the validator.

### R4. The ADR template is the only way to record decisions

The ADR log is a hub + records: [`decisions.md`](decisions.md) holds the
index, one stub per ADR (heading + Status + Date + link), the template,
and the editing rules; each full record lives in
`decisions/adr-NNN.md`. New decisions: create the record file from the
template, then add the stub and index row. Numbering is sequential and
immutable (superseded ADRs stay; do not renumber). One decision per ADR.
Decision text is immutable; direction changes get a new superseding ADR,
non-direction deltas go into a dated `**Amendments:**` list in the
record. `pnpm validate:docs` enforces the stub ↔ record bijection and
status equality.

Outside the ADR log, prose may *cite* an ADR (`see ADR-005`) but MUST
NOT restate its rationale at length. Single source of truth.

### R5. Process and domain description structure

Every `system-analytics/*.md` file MUST contain, in this order:

1. **Purpose** — one paragraph, name the domain and its boundary.
2. **Domain entities** — bulleted list of nouns (link to ERD if persisted).
3. **State machine** (where applicable) — `stateDiagram-v2`.
4. **Process flows** — `flowchart` or `sequenceDiagram` for each
   end-to-end scenario.
5. **Expectations** — bulleted acceptance contract. See §R5a for
   fill-in rules. Domains added after this rule landed MUST include
   this section.
6. **Edge cases** — bulleted list of known failure / boundary modes,
   each linked to the relevant `MaisterError` code.
7. **Linked artifacts** — pointers to API spec, ERD, ADR, source files.

The diagrams and bullets are the artifact. Prose between them is glue,
not commentary.

Additional **topical sections** (a frozen sub-spec, a cost dimension, an
ADR-scoped contract) are allowed for large domains: they belong AFTER
Process flows and BEFORE Expectations, never before Purpose and never after
Linked artifacts. A state-and-action matrix may stand in for the State
machine + Process flows pair where transitions are operation-driven rather
than event-driven.

### R5a. Expectations section fill-in rules

The **Expectations** section is the steady-state contract for the
domain — what a reviewer (human or AI) can use as an acceptance
checklist against the code, the DB, and the wire.

- One bullet = one MUST-hold invariant, guarantee, or observable
  behavior. One sentence each.
- Phrase as a normative statement (MUST / NEVER / always / exactly /
  at most / at least), not a description. RFC-2119 spirit; no formal
  capitalization required.
- Cover at minimum, when applicable to the domain: cardinality and
  uniqueness rules, state-transition invariants, concurrency / cap
  behavior, persistence vs in-memory boundaries, idempotence, retry /
  recovery semantics, security-relevant defaults.
- Every bullet MUST be testable — turnable into an assertion, a SQL
  constraint check, or a review checklist item. If it cannot, it does
  not belong here.
- DO NOT restate diagrams or duplicate Edge cases. Expectations are
  the contract; Edge cases are the named deviations from it.
- Reference identifiers verbatim (`runs.status`, `worktree_path`,
  `MaisterError("CONFIG")`, env-var names). No paraphrasing.
- Cap at ≤ 12 bullets. If a domain needs more, the boundary is wrong —
  split the file.
- Tag implementation status only when the expectation does NOT hold
  yet at the current milestone (e.g. `(Phase 2)`).

### R6. Implementation status is explicit

Every architecture or system-analytics file MUST mark each described
piece as one of:

- **Implemented** — present in the current branch.
- **Designed** — contract accepted, not yet coded.
- **Phase 2** — plausible later work, not part of the current target.

Use a parenthetical tag such as `(Implemented)`, `(Designed)`, or
`(Phase 2 — see PRODUCT_VIEW §Phase 2)`. This keeps the docs honest
about what is real today without turning old milestone labels into
blockers.

Milestone numbers (`M11a`, `M43`, …) are **changelog vocabulary, not
status**: do not add them to new or edited current-plane passages — use
the three tags above; `M-NN` belongs in the ADR log, `.ai-factory/
ROADMAP.md`, and commit history. Existing milestone tags are being
removed opportunistically (de-milestoning pass); don't add new ones.

### R7. Cross-reference, do not duplicate

Configuration, error taxonomy, DB schema, supervisor wire contract,
ADRs — each has exactly one canonical file. Other docs link to it.
If two files describe the same thing, one of them is wrong; collapse
them.

### R8. Russian and English

The product UI is bilingual (EN + RU). Documentation in `docs/` is
**English by default** — it is a contract for code and AI agents, both of
which read English. Russian-language product/operator guides may live under
`docs/ru/` when explicitly requested by the user; UI copy still belongs in
i18n message catalogs under `web/`.

### R9. Surgical edits

Apply the root CLAUDE.md surgical-changes rule to docs too:

- Touch only what the request requires.
- Don't reformat adjacent prose, don't reflow tables, don't "improve"
  unrelated diagrams while passing through.
- If you spot a real bug in an unrelated section, file it as a TODO at
  the bottom of `decisions.md` — do not fix it silently.

## Validation

Before any docs PR merges, the diff MUST pass:

| Artifact | Validator | How |
| -------- | --------- | --- |
| Mermaid blocks | `pnpm validate:docs` (repo root) | Parses every changed `docs/**/*.md` block via `mermaid.parse()` AND fails blocks over 50,000 chars (renderer `maxTextSize`); exits non-zero on any error. Use `pnpm validate:docs:all` to check the entire `docs/` tree regardless of git status. The Claude Code Stop hook in `.claude/settings.json` runs this gate automatically before the agent finishes a turn. |
| ADR anchors | `pnpm validate:docs` | Every `decisions.md#adr-NNN` link must resolve to a real `### ADR-NNN:` header. |
| Relative links | `pnpm validate:docs` (`validate:docs:links[:all]`) | Every relative markdown link in changed `docs/**/*.md` must resolve to an existing file/dir. |
| Canonical indexes | `pnpm validate:docs` | Every `.md` under `system-analytics/`, `db/`, `screens/`, `plans/` must be linked from that directory's README (the canonical index). |
| Consolidated ERD | `pnpm validate:docs` (`pnpm --filter maister-web db:erd --check`) | Regenerates the DBML from the Drizzle schemas and fails when `db/erd.dbml` drifted (ADR-159). |
| OpenAPI 3.0.3 | `npx @redocly/cli lint <file>` or [editor.swagger.io](https://editor.swagger.io) | Zero errors; warnings reviewed. |
| AsyncAPI 2.6.0 | `npx @asyncapi/cli validate <file>` | Zero errors. |

CI exists (`.github/workflows/ci.yml`: lint/typecheck/unit lane plus a
label-gated integration lane); the docs gates above also run locally and
through the Claude Code Stop hook. Wiring `validate:docs` into CI is an
open follow-up.

## Adding a new artifact

1. **New domain doc** → add a file under `system-analytics/` following §R5.
   Link from this file's glossary.
2. **New API** → create the OpenAPI/AsyncAPI YAML under `api/` (or
   `api/external/` if upstream). Link from `architecture.md` Component
   table. Reference it from the spec that *invokes* it.
3. **New decision** → append an ADR to `decisions.md` (next sequential
   number). Do not rewrite history; supersede if needed.
4. **New ERD** → add a Mermaid `erDiagram` to the relevant `db/*.md`.
   The consolidated `db/erd.dbml` regenerates from the Drizzle schemas
   (`pnpm --filter maister-web db:erd`) — never hand-edit it.
5. **New screen** → add a file under `screens/` following the per-doc template
   in [`screens/README.md`](screens/README.md) (one file per screen / block /
   chrome element; flat plus `chrome/` until an area reaches ≥ 3 files). Add a
   row to the screen-reference glossary above and link the screen's behavior
   doc under `system-analytics/` rather than restating it (R7).

## Anti-patterns

- ❌ Writing an architecture decision in `architecture.md` instead of
  `decisions.md`.
- ❌ Embedding a screenshot of a diagram instead of the Mermaid source.
- ❌ Restating the `maister.yaml` schema in a system-analytics file —
  link to `configuration.md` instead.
- ❌ Reintroducing old planning archives as active docs. Git history keeps
  those records; active docs describe current contracts.
- ❌ Adding a "see also" section that duplicates the glossary above.
- ❌ Letting an OpenAPI/AsyncAPI file diverge from code without filing
  the diff as a defect.

## See also

- [`../CLAUDE.md`](../CLAUDE.md) — root contract for the whole repo.
- [`../web/CLAUDE.md`](../web/CLAUDE.md) — web slice contract.
- [`decisions.md`](decisions.md) — every locked decision behind the docs
  themselves.
