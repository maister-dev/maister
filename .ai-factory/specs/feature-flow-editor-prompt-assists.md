# Feature Spec: Flow Editor Prompt Assists

Status: Implemented
Date: 2026-06-28
Plan: `.ai-factory/plans/feature-flow-editor-prompt-assists.md`

## Goal

Flow Studio coding-node prompts (`ai_coding`, `judge`, `orchestrator`) should
behave like first-class agent prompt editors:

- package-local skills are discoverable by `/` and `$`;
- stored prompt text uses the existing canonical `@skill:<slug>` grammar;
- raw typed or pasted `/skill` and `$skill` are normalized at the editor
  commit boundary when they exactly match package-local skills;
- `{{` opens node-aware template variable suggestions that only offer values
  available at the selected node and make runtime absence explicit.

## Non-Goals

- No DSL shape change: `action.prompt` stays a string.
- No new API route, OpenAPI path, AsyncAPI event, DB table, migration,
  deployment setting, sidecar, port, or `MaisterError` code.
- No project/global/platform capability catalog in package-authored flow
  prompts.
- No CLI/check command-field variable popup in this slice.
- No support for arbitrary template expressions. The new default operator is
  limited to `{{ <dotpath> ?? <quoted-string-literal> }}`.

## Runtime Templating Contract

Current `renderStrict` throws `MaisterError("CONFIG")` when a path is missing or
present-but-`undefined`. That strict behavior remains for bare tags:

```mustache
{{ steps.plan.vars.verdict }}
```

This feature adds one backward-compatible render-time escape hatch for paths
that may legitimately be absent:

```mustache
{{ steps.plan.vars.summary ?? '' }}
{{ executor.router ?? "none" }}
```

Semantics:

- if `<dotpath>` resolves to a value other than `undefined`, render that value;
- if `<dotpath>` is missing or resolves to `undefined`, render the literal;
- the guarded form never throws for absent/undefined paths;
- the bare form keeps throwing `CONFIG`;
- resolved guarded values are substituted after strict Mustache render so they
  are not re-parsed as template syntax;
- no `compat.engine_min` bump is required because this is a render-time additive
  feature and existing prompts render byte-identically.

## Variable Classification

Each `TemplateVariableEntry` carries two orthogonal axes.

### Graph Availability

- `definite`: every static path from the entry node to the selected node passes
  through the producer.
- `conditional`: the producer can reach the selected node, but at least one
  static path bypasses it.
- `unavailable`: future/successor/current-node outputs are omitted.

Graph edge contributors:

- `transitions.*` targets whose values are node ids;
- `rework.allowedTargets`;
- `decide` and `output.result.on_mismatch` outcomes through matching
  `transitions` keys;
- `finish.human.decisions` through matching `transitions` outcomes.

Legacy linear `steps[]` manifests degrade to a simple predecessor chain. Cycles
and rework loops must use visited sets/fixed-point traversal.

### Value Presence

- `required`: the value is guaranteed present if the producer ran.
- `optional`: the value may be absent even if the producer ran.

Optional paths include:

- `executor.router`;
- `steps.<id>.exitCode` for non-`cli`/`check` producers;
- schema fields not listed in the JSON Schema `required` array;
- `artifacts.<id>.uri`;
- every `conditional` graph-availability entry.

Insertion text:

- `definite + required` inserts `{{ path }}`;
- `conditional` or `optional` inserts `{{ path ?? '' }}`.

## Variable Sources

Static globals:

- `task.id`, `task.title`, `task.prompt`, `task.attemptNumber`;
- `run.id`, `run.attemptNumber`, `run.projectSlug`;
- `executor.id`, `executor.agent`, `executor.model`, `executor.router`.

Step variables:

- `steps.<id>.output`;
- `steps.<id>.exitCode`;
- `steps.<id>.vars`;
- field-level `steps.<id>.vars.<field>` from declared schemas only.

Schema sources:

- `output.result.schema`;
- `settings.form_schema`;
- already-loaded package draft files under root `schemas/*.json` only.

Invalid/missing schema refs produce warnings, not thrown editor errors. The
resolver must use existing schema-ref/path helpers and must not parse `../`
paths, nested schema paths, rules, skills, installed package files, or arbitrary
draft files.

Artifact variables come from upstream declared `output.produces` entries:

- `artifacts.<artifactId>.kind`;
- `artifacts.<artifactId>.uri`;
- `artifacts.<artifactId>.validity`;
- `artifacts.<artifactId>.nodeId`.

`env.*` keys are runtime-filtered and are not enumerated.

Declared `rework.commentsVar` values are suggested as top-level conditional
variables, seeded empty unless a rework path injects comments.

## Skill Prompt Contract

- Composer chips continue to store canonical `@skill:<slug>`.
- Runtime canonical-to-wire normalization remains in `runner-agent.ts`.
- Raw `/skill` and `$skill` promotion is editor-only and runs at blur/save
  commit boundaries, not on every keystroke.
- Raw promotion is scoped to prompt fields and package-local catalog entries of
  `kind: "skill"`.
- No manifest-wide YAML normalizer is allowed.

## Acceptance Criteria Mapping

| Requirement | Acceptance criteria |
| --- | --- |
| Slash commands for coding agents | AC1, AC2, AC12 |
| Existing `@skill:<slug>` runner mechanics reused | AC1, AC2 |
| Autosuggest/autocomplete in the input | AC1, AC3, AC4 |
| Inline variables with `{{ }}` grammar | AC3, AC4, AC5, AC8b, AC8c |
| Know variables available at selected node | AC4, AC6, AC7 |
| Structured outputs from previous nodes | AC4, AC5 |
| Avoid runtime hard-fail suggestions | AC8b, AC8c |
| No API/DB/engine expansion beyond explicit need | AC10 |

## Contract Surface Matrix

| Surface | Change |
| --- | --- |
| Flow DSL manifest | None; `action.prompt` stays string |
| Runtime templating | Add `{{ path ?? '<literal>' }}` only |
| Runner normalization | Reuse existing canonical-to-wire path |
| HTTP/OpenAPI | None |
| AsyncAPI/SSE | None |
| DB/migrations | None |
| Deployment | None |
| Error taxonomy | None |
| Docs/system analytics/screens | Implemented |
| ADR | Add ADR-115 for the render-time default operator |

## Phase 0 Contract Audit

Commands run before production code:

- `rg --files-with-matches "action\.prompt|promptComposer|CapabilityComposer" web/components web/lib docs --glob '!**/*.map'`
- `rg -n "\{\{[^}]*runner\." docs/flow-dsl.md`
- `git --no-pager diff --name-only -- docs/api docs/db web/lib/db web/db supervisor`
- `git --no-pager diff --check`
- `pnpm validate:docs`

Results:

- Existing prompt-composer references are confined to docs, flow editor,
  scratch composer, capability composer, and config/test surfaces.
- `docs/flow-dsl.md` has zero `{{ runner.* }}` template-context examples.
- Phase 0 changed no API, DB, migration, supervisor, or deployment paths.
- Whitespace checks and docs validation pass at Phase 0 HEAD.
