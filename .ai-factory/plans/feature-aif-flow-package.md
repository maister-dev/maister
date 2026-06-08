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

### Task 4: Graph `form` collection node (intake) + buttons/free-text UI

**4a finding (verified 2026-06-08):** there is NO native form-collection graph node. The graph node union is `ai_coding | judge | cli | check | human` (`config.schema.ts:636`); every `human` node goes through `runReviewHuman` (`runner-graph.ts:390`) and is **decision-driven** — `finishHumanSchema` requires `decisions.min(1)` (`:416`), `humanSettingsSchema` has **no `form_schema`** (`:552-565`), and the transition is the chosen decision (`runner-graph.ts:1476-1489`). The var/`{{steps.<id>.vars.<field>}}` mechanism and `kind:"form"` schema-validated responses DO exist and are reused. **User decision: build the form node now.** This is milestone-sized (new core-engine HITL node type) — execute as a focused TDD effort with integration tests.

**Blueprint (verified template = `web/lib/flows/runner-human.ts runHumanStep`):**
1. **Schema** (`web/lib/config.schema.ts`): add `formSettingsSchema = { form_schema: string≥1, roles?, criticality? }.strict()` and `formNodeSchema = { ...nodeCommon, type: literal("form"), settings: formSettingsSchema }`; add to the `nodeSchema` discriminated union. The node uses `transitions.success`. **Cascade:** adding the union member breaks every exhaustive `switch(node.type)/switch(def.type)` (runner dispatch `runner-graph.ts:351`, enforcement, compile, graph validation `config.ts`, flow-graph view) — TS strict flags each; handle them (form = no capability enforcement; treated like an action node for transitions).
2. **Runner** (`web/lib/flows/graph/runner-graph.ts`): `case "form": return runFormCollect(...)`. `runFormCollect` mirrors `runHumanStep`: first visit → `readAndValidateFormSchemaDoc(flowInstallPath, settings.form_schema)`, create `kind:"form"` HITL + `needs-input.json`, return `{needsInput:true}`; resume → read `input-<nodeId>.json` → return `{ok:true, vars: existing, needsInput:false}` (NO `decision` ⇒ finish outcome `"success"` per `:1476-1489`, follows `transitions.success`). **Thread `flowInstallPath` into `executeNodeAction` ctx** (not currently present — find it on the loaded run / flow record).
3. **HITL response** (`web/lib/services/hitl.ts`): reuse `handleFormHumanResponse` (kind=form, validates against stored `schema`, writes `input-<nodeId>.json`). Verify it writes the input artifact keyed by the node id the runner reads.
4. **UI** (`web/components/board/hitl-decision-controls.tsx`): for a `form` HITL whose schema declares per-field options, render **buttons** (reuse permission grid `:226`) + a **free-text** field; write the value into the `response` JSON. `renderToStaticMarkup` test. EN+RU i18n.
5. **Intake schema** (`plugins/aif/flows/dev/schemas/intake.json`): fields `tests`/`logging`/`docs` with option hints, valid under `assertHitlResponse`.
6. **Tests:** integration (testcontainers, docker UP) — reaching the form node → `NeedsInput`; submit → `vars` persisted → `success` transition → next node runs; downstream prompt interpolates `{{steps.intake.vars.tests}}`. Plus the UI unit test.

**Scope guardrail (post-rogue-subagent):** touch ONLY the files named above. Do NOT run repo-wide `lint --fix`/formatter. Verify `git diff --stat` shows only intended files before each commit.

**Increment status (2026-06-08, TDD agent-team; Coordinator owns core edits):**
- ✅ **Increment 1 — schema + type cascade** (`ffda3aa1`, Reviewer SHIP, 6 schema tests, typecheck clean): `formSettingsSchema`+`formNodeSchema` in the `nodeSchema` union (settings required, no action); `"form"` added to `node_attempts.node_type` (**NO migration** — plain-text column, TS-only enum; `hitl_requests.kind` + `assignments.action_kind` already had `"form"`); `"form"` added to `NodeKind` (recover-classify) + `ReconcileInput.currentNodeKind` (reconcile) — form is **session-less** (no `--resume`), classifies like human via existing fall-through (recover: `retry_safe?redispatch:discard-only`; reconcile: gate-redispatch/linear-crash). **Verified blueprint shrank:** `LoadedRun.flowInstallPath` already exists (NO ctx threading); the outcome logic (`runner-graph.ts:1479`) already maps non-human→`success` (NO edit); `current-node-kind.ts` is type-generic (NO edit).
- ⏳ **Increment 2 — runtime** (`runFormCollect`): dispatch `case "form"` (`runner-graph.ts:351`, default currently throws CONFIG) → `runFormCollect(node, loaded, {runtimeRoot, db})` mirroring `runReviewHuman` + `runHumanStep` form path: read-first `input-<nodeId>.json` (resume → `{ok:true, vars:existing, needsInput:false}`, NO decision ⇒ `success`); first visit → `readAndValidateFormSchemaDoc(loaded.flowInstallPath, def.settings.form_schema)` + write `needs-input.json` + insert `kind:"form"` HITL + `createHitlAssignmentForRun(actionKind:"form")` → `needsInput:true`. **Plus carry-forward (Reviewer find, conf 88): `services/runs.ts:91` role-validation skips non-human nodes — extend to validate `form` `settings.roles` too.** Integration test (testcontainers): reach form → NeedsInput; submit → vars persisted → `success` → next node; downstream `{{steps.intake.vars.tests}}` interpolates.
- ⏳ **Increment 3 — UI + intake schema**: `flow-graph-view.ts` `nodeRoleForType`/`nodeTypeLabelForRole` form case (today → "Other"); board form-HITL render (buttons+free-text) in `hitl-decision-controls.tsx` + EN/RU i18n + `renderToStaticMarkup` test; confirm HITL response route writes `input-<nodeId>.json` in the shape `runFormCollect` reads; `plugins/aif/flows/dev/schemas/intake.json`.

### Task 5: Light commit gate
- **Files:** create `plugins/aif/capability/scripts/commit-gate.sh`.
- **Behavior:** exit 0 only when (a) working tree clean (`git status --porcelain --untracked-files=no` empty) **and** (b) `git log -1 --pretty=%s` matches Conventional Commits regex. Else exit 1 with reason on stderr.
- **Tests:** scratch git repo — clean conventional commit → 0; dirty tree or non-conventional → 1.
- **Note:** flows reference it via `command_check`; if the bundle path is not stably resolvable in the worktree at gate time, inline the two checks in the flow `command_check.command` instead (decide in T7 after confirming symlink layout).

### Task 6: Capability materialization (Option B) + repo-local precedence + config override
- **DONE (committed `fc943967`, 4 unit tests green):** `web/lib/capabilities/materialize-bundle.ts` — `copyBundleArtifactsToWorktree({installedPath, worktreePath})` (copies bundle `skills/`+`agents/` into `<worktree>/.claude/`, repo-local precedence via `cp force:false` per-file skip) and `writeAiFactoryConfigOverride({worktreePath, baseBranch})` (`git update-index --skip-worktree` the tracked `.ai-factory/config.yaml` so the local override never pollutes the run diff / gets promoted, then patch `git.create_branches:false`+`base_branch`). Subtleties resolved: `force:false` (not the blueprint's `errorOnExist:false`, which would overwrite); skip-worktree (avoids diff pollution); comments not preserved (irrelevant — never committed).
- **WIRING DONE (TDD, 5 unit tests green):** `launchRun` (`web/lib/services/runs.ts`) now, right after `addWorktree` and **inside the existing `try`** (so a materialization failure hits the same `removeWorktree` compensation + abort as a DB-tx failure — no orphan worktree), queries `capabilityImports` by `projectId` + `packageStatus:"Installed"` → copies each bundle via `copyBundleArtifactsToWorktree({installedPath, worktreePath})` + once `writeAiFactoryConfigOverride({worktreePath, baseBranch: base})` (`base = input.baseBranch ?? project.mainBranch`, matches `workspaces.baseBranch` — refined from the blueprint's `project.main_branch`). **Gated on ≥1 Installed import** so non-AIF projects get no stray `.ai-factory/config.yaml`. Core graph runner untouched. Tests: `runs-launch-materialize.test.ts` pins per-Installed copy / config-once / base-threading / exclude-non-Installed / zero-import-skip. **Deviation:** used the light `fakeDb` harness (matches `runs-launch-branch.test.ts`) asserting the wiring contract, not the originally-planned testcontainers integration test — the copy/precedence/config behavior is already covered by `materialize-bundle.ts`'s own 4 unit tests, so an integration test would only re-exercise mocked-worktree git plumbing. Reviewer SHIP verdict.
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
