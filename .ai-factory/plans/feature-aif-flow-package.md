# AI Factory Flow Package for MAIster — Implementation Plan

**Branch:** `feature/aif-flow-package` · **Created:** 2026-06-08 · **Consumer:** `/aif-implement`
**Design reference:** `docs/plans/2026-06-08-aif-flow-package-design.md` (read first)

Replace the invalid `plugins/aif` stub with a complete AIF (ai-factory 2.x) package — 5 flows + all skills/agents/rules vendored — plus the MAIster platform changes that make it run: manifest `metadata`, skill+agent materialization with repo-local precedence, buttoned+free-text question nodes, and a light commit gate. Interactivity is MAIster-native HITL (no adapter fork); git ownership stays with MAIster via a per-run `.ai-factory/config.yaml` override.

## Settings

- **Testing:** yes — TDD for every platform change (failing test → implement → green).
- **Logging:** verbose — `pino` DEBUG at materialization decisions and HITL question lifecycle; WARN on schema/validation rejects; never log secrets.
- **Docs:** yes — update `web/CLAUDE.md` / `docs/` where contracts change (flow.yaml `metadata`, question node, materialization).

## Roadmap Linkage

- **Milestone:** M20. Dogfood + external validation
- **Rationale:** This package + its platform enablers are the prerequisite for registering MAIster in itself and shipping ≥1 PR through a MAIster flow — the core of M20.

## Conventions

Follow `web/CLAUDE.md`. Throw `MaisterError` with `code` (never plain `Error`); strict TS (no `any`); EN+RU i18n for new UI strings; tests per project conventions (`renderToStaticMarkup`, `.test.ts` globs, testcontainers for integration). Surgical changes; commit per task.

## Dependencies / order

```
T1 vendor bundle ─┐
T2 pkg config/README ─┤ (content; any time before T7)
T3 metadata schema ───┼─► T7 author 5 flows ─► T8 dogfood wiring ─► T9 e2e verify
T4 question node ─────┤
T5 commit gate ───────┤
T6 materialization ───┘
```
Build platform features (T3–T6) before authoring flows (T7) so manifests validate and run.

---

## Phase 1 — Package content

### Task 1: Vendor the AIF bundle from upstream GitHub `2.x`
- **Deliverable:** all AIF skills + claude subagents + rules vendored into `plugins/aif/capability/`.
- **Files:** create `plugins/aif/capability/skills/aif-*/**` (from `2.x:skills/`), `plugins/aif/capability/agents/**` (from `2.x:subagents/claude/`), `plugins/aif/capability/rules/**`; remove old stub `plugins/aif/{skills,agents,rules}` leftovers.
- **Steps:** sparse `git clone --branch 2.x https://github.com/lee-to/ai-factory` to a temp dir → `cp -R skills/ subagents/claude/ rules/` into `plugins/aif/capability/`. Verify `find … -name SKILL.md | wc -l` matches upstream; spot-check `aif-plan/SKILL.md` frontmatter intact.
- **Logging:** n/a (static content).
- **Tests:** none (content); a guard test may assert the bundle has ≥1 SKILL.md.

### Task 2: Package config template + README + inert setup
- **Files:** create `plugins/aif/config/ai-factory.config.yaml` (MAIster-compat: `git.create_branches:false`, `git.base_branch:main`, default `paths.*`); rewrite `plugins/aif/README.md` (provenance + links, 5 flows + `route_when`, consumption via `capability_imports`+`flows[]`, "run `aif-init` first if no `.ai-factory/DESCRIPTION.md`"); rewrite `plugins/aif/setup.sh` → no-op `exit 0` (no npm).
- **Logging:** `setup.sh` echoes a one-line notice to stderr.
- **Tests:** `bash plugins/aif/setup.sh` exits 0.

---

## Phase 2 — Platform features (TDD)

### Task 3: Manifest `metadata` block (schema)
- **Files:** modify `web/lib/config.schema.ts` (`flowMetadataSchema` + `metadata` key on `flowYamlV1Schema`); test `web/lib/__tests__/config.schema.test.ts`.
- **TDD:** failing test — a manifest with full `metadata` (title/summary/labels/route_when/links[{kind,title,url}]/sources[{component,origin}]) parses + round-trips; `metadata` optional; bad link URL rejected. Implement `flowMetadataSchema` (strict sub-objects) and wire `metadata: flowMetadataSchema.optional()`. Persists via existing `manifest` jsonb (no migration).
- **Logging:** WARN on metadata validation reject (existing config-load logging path).

### Task 4: Question UI for form HITL — option buttons + free-text
- **Goal:** let a flow `form` "intake" node ask a question with **option buttons AND a free-text input**.
- **Already built (verified — do NOT rebuild):** a `human`/`form` HITL answer is written to `node_attempts.vars` (`web/lib/flows/graph/ledger.ts markNodeSucceeded`) and read downstream as `{{steps.<nodeId>.vars.<field>}}` (`web/lib/flows/templating.ts`; `runner-graph.ts runReviewHuman` / `runner-human.ts` return `vars` from `input-<stepId>.json`). `kind:"form"` accepts any JSON validated against the stored `schema` jsonb (`web/lib/services/hitl.ts handleFormHumanResponse` → `assertHitlResponse`). **No enum migration, no new node type, no runner/response/var work.**
- **Files (read first):** `web/components/board/hitl-decision-controls.tsx` (form branch = JSON textarea today), `web/lib/services/hitl.ts`, `web/lib/flows/graph/runner-graph.ts` (`runReviewHuman`) + `web/lib/flows/runner-human.ts`.
- **Sub-step 4a — confirm/extend graph form-collection mode (verify FIRST):** the graph `human` node today is review-oriented (`runReviewHuman`: decisions/rework). Confirm a graph node can be a **non-review intake form** (collect `response`→`vars`, single `success` transition). If only review mode exists, add a minimal form-collection handler. Test: reaching the node → `NeedsInput`; submit → `vars` persisted → next node runs.
- **Sub-step 4b — UI (TDD):** extend `HitlDecisionControls` so a `form` HITL whose schema declares per-field options renders **buttons** (reuse the permission grid at `:226`) **and** keeps a free-text field; the picked/typed value is written into the `response` JSON posted to `/respond`. `renderToStaticMarkup` test: buttons + input present. EN+RU labels.
- **Sub-step 4c — intake form schema:** author the intake `form_schema` (fields: `tests`, `logging`, `docs`) with option hints, consumed by 4b and validated by `assertHitlResponse`.
- **Logging:** DEBUG question lifecycle (option vs free-text).

### Task 5: Light commit gate
- **Files:** create `plugins/aif/capability/scripts/commit-gate.sh`.
- **Behavior:** exit 0 only when (a) working tree clean (`git status --porcelain --untracked-files=no` empty) **and** (b) `git log -1 --pretty=%s` matches Conventional Commits regex. Else exit 1 with reason on stderr.
- **Tests:** scratch git repo — clean conventional commit → 0; dirty tree or non-conventional → 1.
- **Note:** flows reference it via `command_check`; if the bundle path is not stably resolvable in the worktree at gate time, inline the two checks in the flow `command_check.command` instead (decide in T7 after confirming symlink layout).

### Task 6: Capability materialization (Option B) + repo-local precedence + config override
- **Goal:** at run setup, deliver bundle skills+agents into worktree `.claude/`, **preferring repo-local copies**, and write a per-run `.ai-factory/config.yaml` override.
- **Files (read first):** `web/lib/capabilities/agent-map.ts`, `web/lib/capabilities/materialize.ts`, `web/lib/capabilities/resolver.ts`, `web/lib/capabilities/import.ts`; ADR-043/044 in `docs/decisions.md`.
- **TDD:**
  1. **Skills/agents material** — `agent-map.ts` resolves skill/agent `material` from the imported bundle cache (`~/.maister/capabilities/<id>@<sha>/…`).
  2. **Repo-local precedence** — `materialize.ts` writes `<worktree>/.claude/skills/<id>/SKILL.md` (and `.claude/agents/<id>.md`) only if absent; pre-existing repo copy wins.
  3. **Config override** — write/patch `<worktree>/.ai-factory/config.yaml` → `git.create_branches:false`, `git.base_branch:<run base>`, preserving other keys.
  4. **Wire** into the pre-`POST /sessions` materialization path; integration test asserts worktree contains skills/agents + override.
- **Logging:** DEBUG per skill/agent: materialized-from-bundle vs kept-repo-local; INFO config override applied. Keep enforcement `instruct` (write files regardless of verdict).

---

## Phase 3 — Flows + dogfood

### Task 7: Author the 5 flow graphs
- **Files:** create `plugins/aif/flows/{dev,bugfix,evolve,roadmap,init}/flow.yaml` (+ `dev/schemas/intake.json` for the intake form). Each: `schemaVersion:1`, `name`, `metadata` (T3), `runner_profiles`, `compat.engine_min` (graph→≥1.1.0; artifacts→≥1.2.0), `nodes[]` per design §9 with the T4 form intake + commit gate (T5).
- **Graphs:** `aif-dev` (intake→plan→improve→plan_review→implement→checks→code_review→review→[fix↺checks | commit]→done); `aif-bugfix`; `aif-evolve`; `aif-roadmap`; `aif-init` (per design §9).
- **`intake` node:** `form` collecting `tests`/`logging`/`docs` only (the flow itself fixes the path — no `mode` input). Downstream prompts interpolate `{{steps.intake.vars.tests}}` etc. (correct context syntax — NOT `{{intake.*}}`).
- **`checks` node:** an `ai_coding` node running `/aif-verify` (stack-agnostic; emits `aif-gate-result`) instead of a hardcoded `pnpm` command — keeps the package portable.
- **Validate:** `pnpm --filter maister-web validate-authored-flow --source-dir ../plugins/aif/flows/<name>` passes for all 5. **Add a vitest** (`web/lib/__tests__/`) that loads all 5 shipped `flow.yaml` and asserts each passes `flowYamlV1Schema` + graph validation (transitions resolve, no unknown goto, rework `maxLoops` on cycles) — regression guard.
- **Logging:** n/a (manifests).

### Task 8: Dogfood wiring (MAIster registers itself)
- **Files:** dogfood `maister.yaml` — `capability_imports:[{id:aif-bundle, source:file://…/plugins/aif/capability, version:local-dev}]` + 5 `flows[]` entries (design §4). Install via `pnpm --filter maister-web install-flow …` per flow.
- **Verify:** flows appear in catalog; node `settings.skills` refIds resolve at a dry-run launch (no `CONFIG` unknown-ref).

### Task 9: End-to-end verification (dogfood)
- **Steps:** launch `aif-dev` on a real backlog task → worktree on `maister/<run>`; confirm `.claude/skills` + `.ai-factory/config.yaml(create_branches:false)` present; plan → `intake` question (buttons+text) → plan_review → implement (permission HITL on edits) → checks → code_review → review → commit (gate passes) → promotion (local_merge). Smoke-run the other 4 flows to `done`. Restart web+supervisor mid-`NeedsInput` → reconcile holds. Gates: `pnpm --filter maister-web lint` + full `test` green; supervisor build green.
- **Logging:** rely on existing run-event logging.

## Commit Plan

5+ tasks → checkpoints (each task also commits on green):
- **CP-A** (T1–T2): `feat(aif): vendor 2.x bundle + package config/README`
- **CP-B** (T3–T4): `feat(flows): flow.yaml metadata + question-node HITL (buttons+free-text)`
- **CP-C** (T5–T6): `feat(capabilities): light commit gate + bundle materialization with repo-local precedence`
- **CP-D** (T7): `feat(aif): author dev/bugfix/evolve/roadmap/init flow graphs`
- **CP-E** (T8–T9): `test(aif): dogfood wiring + e2e verification`

## Out of scope (Phase 2)

Adapter fork / native AskUserQuestion passthrough; `aif-dev-light`; `aif-autonomous-flow`; connect-time init prompt; `/aif-loop` `/aif-qa` + utility skills as first-class flows; Codex-runner agent-materialization parity.
