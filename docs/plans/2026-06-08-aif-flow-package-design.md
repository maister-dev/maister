# AIF Flow Package — Design

- **Date:** 2026-06-08
- **Status:** Approved design — open questions resolved 2026-06-08; implementation plan next
- **Owner:** Albert Kanishchev
- **Scope decision:** build everything in one pass before dogfooding (no phasing).

## Implementation deltas (as-built, 2026-06-09)

The sections below are the original design. These are the points where the
shipped code intentionally diverges or resolves an open choice — recorded here so
the design doc stays honest (code wins):

- **`review` takeover target:** §9 shows `takeover→commit`; shipped `aif-dev`
  routes **`takeover → checks`** so a human's local edits are re-validated
  (`/aif-verify` + `/aif-review`) before commit. Intentional improvement.
- **Prompt templating:** flows use flat vars — `{{ review_comments }}` (matching
  `commentsVar: review_comments`) and `{{ steps.intake.vars.<field> }}` — NOT the
  `{{review.comments}}` / `{{intake.*}}` forms sketched in §9.
- **Materialization site:** delivered as a standalone
  `web/lib/capabilities/materialize-bundle.ts` (`copyBundleArtifactsToWorktree`
  fs-copies the bundle's `skills/` + `agents/` with repo-local precedence), wired
  into `launchRun` — NOT the `agent-map.ts` / `materialize.ts` touch points named
  in §8.2.
- **Commit gate (§8.4):** an inline `command_check` (clean tree via
  `git status --porcelain --untracked-files=no` + a Conventional Commits subject)
  on all five flows' `commit` node, run after `/aif-commit` commits. (A
  `commit-gate.sh` helper was briefly shipped + wired but removed — it duplicated
  the inline check and would have littered the run worktree; the gate stays inline
  so nothing is materialized for it.) The per-run `.ai-factory/config.yaml`
  override is git-ignored per-worktree (`ensureWorktreeGitignore`) so it is never
  staged or promoted.
- **No `rules/` (§4 layout):** the package ships skills + agents only; a package
  may legitimately omit `rules/` — the `rules/*.md` entry in the §4 tree is
  illustrative, not required.
- **`flow_roles` (consumer caveat):** every human/form node uses `role: maintainer`
  and the package declares no role. A consuming `maister.yaml` that declares a
  non-empty `flow_roles[]` MUST include a `maintainer` entry or all five flows
  fail role-ref validation at install. The admin-operated dogfood declares no
  `flow_roles[]`, so it is unaffected.
- **Packaging model (§4 / F3):** the 6-entry `flows[]` + `capability_imports[]`
  wiring below is the dogfood path. A single-import `flow_packages[]` model is
  deferred to a Package-management milestone — see [`.ai-factory/PLAN.md`](../../.ai-factory/PLAN.md).
  When it lands, F3's "5 flows = 5 sources" premise is superseded for the package case.

---

## Provenance (what this package vendors and from where)

- Framework: **AI Factory `2.x`** — <https://github.com/lee-to/ai-factory/tree/2.x> (skills, subagents, rules; Apache-2.0 adapters consumed via ACP).
- Canonical flow map: `docs/workflow.md` — <https://github.com/lee-to/ai-factory/blob/2.x/docs/workflow.md>
- Config contract: `docs/configuration.md`, `docs/config-reference.md`.
- Evolve / Reflex Loop: `docs/evolve.md`, `docs/loop.md`.
- These links are also embedded as `metadata.links` / `metadata.sources` in every shipped `flow.yaml` (see §4).

---

## 1. Goal

Replace the current invalid `plugins/aif` stub with a complete, dogfood-ready **AIF package** for MAIster:

- 5 ready-made Flows as graphs: **dev, bugfix, evolve, roadmap, init**.
- All AIF skills + subagents + rules vendored into the package (full, not a subset).
- Flow-level **routing frontmatter + provenance links** (new `metadata` block in the manifest schema).
- **Capability materialization** (skills + agents) into the run worktree, **preferring repo-local copies** when present.
- Interactivity preserved via **MAIster-native HITL** (no adapter fork).

Success = run all 5 flows against the MAIster repo itself (dogfood) end-to-end.

## 2. Why the current stub is wrong

`plugins/aif/flow.yaml` parses, but is semantically invalid:

1. It is a single generic `plan→implement→checks→judge→review` graph — not AIF (AIF has ~27 skills and several distinct scenarios).
2. `setup.sh` runs npm `ai-factory init` — contradicts the "no npm" delivery model.
3. It bundles `agents/`, `rules/`, `skills/` that MAIster does not currently deliver to the agent (dead files).

## 3. Grounding findings that shape the design (verified in code)

| # | Finding | Source | Consequence |
|---|---------|--------|-------------|
| F1 | `flowYamlV1Schema` is a plain `z.object` → **strips unknown keys**; no description/labels/links field exists. Manifest is stored verbatim in `flow_revisions.manifest` (jsonb). | `web/lib/config.schema.ts` (flowYamlV1Schema), `web/lib/db/schema.ts` | Routing frontmatter + links require a **schema addition**; persistence is free once modeled. |
| F2 | Skills are **not materialized** today — class `skills` stays `instructed`; only `tools`+`permissionMode` reach `.claude/settings.local.json`. `capability_imports` registers an opaque `agent_definition` (empty manifest). | ADR-044; `web/lib/capabilities/materialize.ts`, `web/lib/flows/enforcement.ts` | Option B = **build skill+agent materialization** into the worktree `.claude/`. |
| F3 | One `flow.yaml` (one graph) per source; `flows[]` entries are `{id, source, version, runner}`. | `web/lib/flows.ts` (installRevision), `web/lib/config.ts` | 5 flows = **5 sources**; a shared bundle is a separate `capability_imports` source. |
| F4 | The MAIster repo **tracks** `.claude/skills/aif-*` (142 files), `.claude/agents/*` (19), `.ai-factory/config.yaml`. A run worktree (`git worktree add`) already contains them. | `git ls-files` | For dogfood, repo-local skills are already present → **repo-local precedence** is the live delivery path; materialization is the portability fallback. |
| F5 | `AskUserQuestion` is hard-disabled in the vendored adapter (`disallowedTools=["AskUserQuestion"]`, always appended; cannot be re-enabled via options). Supervisor implements no `elicitation/create`. **Decision: leave it disabled, do not fork.** | `supervisor/node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js:1474,1523` | Interactivity is delivered via **MAIster HITL** (§6), not the AskUserQuestion tool. |
| F6 | Working buttoned-question mechanisms: permission `options[]` → buttons (`hitl-decision-controls.tsx:226`), review `allowedDecisions[]` → buttons (`:188`), scratch free-text chat (`/api/scratch-runs/[runId]/messages`). | components + routes | aif flow decision/preference points = **HITL nodes** (render as buttons). |
| F7 | Dogfood `.ai-factory/config.yaml` has `git.create_branches: true`. AIF skills honor `git.create_branches:false` → no branch/worktree creation. | `.ai-factory/config.yaml:195`; `skills/aif-plan/SKILL.md` Step 0 | Per-run **worktree config override** to `create_branches:false` so AIF never fights MAIster's worktree/branch ownership (§7). |
| F8 | No per-node env injection (only session-wide `executor.env` / `adapterLaunch.env`). | `supervisor/src/spawn.ts:200-210` | Git-ownership handled via worktree config override (F7), not `HANDOFF_*` env. |

## 4. Package layout

One folder now (moves to its own repo later; `installFlowPlugin` auto-detects `file://`/absolute sources and `fs.cp`s them).

```
plugins/aif/
  README.md                         # provenance + links + how MAIster consumes it
  capability/                       # shared bundle — a capability_imports source
    skills/aif-*/…                  # ALL AIF skills vendored from ai-factory@2.x
    agents/*.md                     # AIF claude subagents (coordinators, sidecars, loop-*)
    rules/*.md
  config/ai-factory.config.yaml     # template used when a project has no .ai-factory/config.yaml
  flows/
    dev/flow.yaml      + schemas/*.json
    bugfix/flow.yaml
    evolve/flow.yaml
    roadmap/flow.yaml
    init/flow.yaml
  README assets…
```

`maister.yaml` wiring (dogfood example):

```yaml
schemaVersion: 2
project: { name: maister, repo_path: /…/mAIster, main_branch: main, branch_prefix: maister/ }
capability_imports:
  - { id: aif-bundle, source: file:///…/plugins/aif/capability, version: local-dev }
flows:
  - { id: aif-dev,     source: file:///…/plugins/aif/flows/dev,     version: local-dev }
  - { id: aif-bugfix,  source: file:///…/plugins/aif/flows/bugfix,  version: local-dev }
  - { id: aif-evolve,  source: file:///…/plugins/aif/flows/evolve,  version: local-dev }
  - { id: aif-roadmap, source: file:///…/plugins/aif/flows/roadmap, version: local-dev }
  - { id: aif-init,    source: file:///…/plugins/aif/flows/init,    version: local-dev }
```

## 5. Manifest `metadata` block (new schema)

Add `metadata` to `flowYamlV1Schema` (permissive object, persisted via existing jsonb). Enables orchestrator routing + provenance.

```yaml
metadata:
  title: "AIF — Develop"
  summary: "Spec-driven delivery: plan → review → implement → review → fix."
  labels: [feature, enhancement, refactor]            # machine routing hints
  route_when: "A feature/enhancement/refactor with a clear spec."   # NL hint for an LLM router
  links:
    - { kind: framework, title: "AI Factory 2.x", url: "https://github.com/lee-to/ai-factory/tree/2.x" }
    - { kind: docs, title: "Dev Workflow", url: "https://github.com/lee-to/ai-factory/blob/2.x/docs/workflow.md" }
  sources:
    - { component: "skills/aif-*, agents/*", origin: "github.com/lee-to/ai-factory@2.x" }
```

Per-flow routing labels:

| flow | labels | route_when |
|------|--------|------------|
| aif-dev | feature, enhancement, refactor | clear-spec feature work |
| aif-bugfix | bug, hotfix, regression | a reported bug/error to fix |
| aif-evolve | maintenance, skills | periodic: distill fix-patches into better skills (not feature work) |
| aif-roadmap | epic, strategic, planning | large/multi-milestone initiative needing a roadmap |
| aif-init | setup, onboarding | one-time: project not yet AIF-initialized |

## 6. Interactivity — MAIster-native HITL (no adapter fork)

Per F5/F6, the AIF skills' own `AskUserQuestion` is disabled and stays disabled. Flow interactivity is delivered by MAIster HITL, which already renders as buttons:

- **Preferences** (tests, logging, docs) → a **`form` intake node** *before* the agent step. The answer is stored in `node_attempts.vars` and read downstream as `{{steps.intake.vars.<field>}}` (verified — the var mechanism already exists; `kind:"form"` needs no migration). AIF skills run non-interactively (prompt wrapper: "non-interactive; use these answers; do not ask"). No `mode` input — the flow itself fixes the path.
- **Approve / rework / takeover** → **human review nodes** (`allowedDecisions` → buttons).
- **Live tool gating** (Edit/Bash during implement/fix) → **permission HITL** (`session/request_permission` → buttons). This is the live ACP interactivity.
- **Ad-hoc free-text** conversation remains available via the **scratch** surface (out of flow scope).

> Resolved: question nodes render `options[]` as **buttons AND keep a free-text input** (mirrors AskUserQuestion's "pick or type your own"). Generalize the existing permission button grid + add a free-text field; the chosen/typed value is stored as a templating var injected downstream.

## 7. Git/worktree ownership (integration seam)

- MAIster owns worktree + branch (§7 product) and promotion (§8). AIF must not create branches.
- Mechanism: during run setup, write a per-run override of `.ai-factory/config.yaml` into the worktree with `git.enabled: true`, `git.create_branches: false`, `git.base_branch: <run base>`. AIF then plans/implements/commits **on MAIster's run branch** without creating its own. The developer's repo config (used for manual AIF) is untouched.
- This override lands in the same worktree-preparation step as capability materialization (§8.2).

## 8. Platform (web/supervisor) change inventory

### 8.1 `metadata` schema (small)
`web/lib/config.schema.ts`: add `flowMetadataSchema` + `metadata` key; types; it persists via existing jsonb. Optional minimal UI surfacing (flow detail: summary + links). + schema tests.

### 8.2 Capability materialization — Option B (medium-large)
Build skill + agent materialization into the run worktree `.claude/`, with **repo-local precedence**:

- For each resolved skill/agent ref: if `<worktree>/.claude/skills/<id>/SKILL.md` (resp. `.claude/agents/<id>.md`) already exists → use it (repo wins); else materialize from the imported bundle cache.
- Touch points (per prior recon): `web/lib/capabilities/agent-map.ts` (extend artifacts with `skills`/`agents` content), `web/lib/capabilities/materialize.ts` (write files into worktree, precedence check), resolver glue.
- Worktree `.ai-factory/config.yaml` override (§7) written in the same step.
- Keep enforcement `instruct` (no strict flip needed): materialization writes the files regardless of enforcement verdict so the agent has them.
- Tests: materialization unit + repo-local-precedence + integration (worktree contains skill files).

### 8.3 Question UI for form HITL (small)
A flow `form` "intake" node presents `options[]` as buttons **and keeps a free-text input** (pick a button or type a custom answer). Reuses `hitl-decision-controls.tsx`'s permission button grid + adds a text field. **No new node type / hitl kind / migration:** `kind:"form"` accepts any JSON validated against the stored `schema`, and the answer already becomes `{{steps.<nodeId>.vars.<field>}}` via `node_attempts.vars` (verified). The only new code is the UI render + (if needed) a graph form-collection node mode. + UI + response-contract tests.

### 8.4 Commit gate (small, light)
`command_check` gate on the `commit` node: **no unstaged tracked changes after commit** (`git diff --quiet`) **and the commit message is Conventional Commits**. No file-composition-vs-plan check (deliberately light). Blocking.

## 9. The five flows (graphs)

Nodes typed `ai_coding | check | human`; transitions form a directed graph; rework loops carry `maxLoops`. `/aif-*` prompts run the vendored skills.

**aif-dev** (`plan → review → implement → review → fix`):
```
intake(form: tests/logging/docs)            → plan
plan(ai_coding /aif-plan {{task.prompt}}; prefs {{steps.intake.vars.*}})  → improve
improve(ai_coding /aif-improve)                    → plan_review        # default-in; aif-dev-light omits (Phase 2)
plan_review(human: approve→implement | rework→plan [maxLoops 3])
implement(ai_coding /aif-implement →impl_diff)     → checks
checks(ai_coding /aif-verify →aif-gate-result)     → code_review
code_review(ai_coding /aif-review →ai_judgment)    → review
review(human: approve→commit | rework→fix | takeover→commit;
       pre_finish: artifact_required(impl_diff, blocking) + ai_judgment(advisory))
fix(ai_coding /aif-fix {{review.comments}})        → checks [rework maxLoops 3]
commit(ai_coding /aif-commit; pre_finish: command_check [no-unstaged + conventional-message]) → done
```

**aif-bugfix** (fast bug loop; emits a self-improvement patch):
```
fix(ai_coding /aif-fix {{task.prompt}} →impl_diff,patch) → checks → code_review
→ review(human: approve→commit | rework→fix [maxLoops 3]) → commit → done
```

**aif-evolve** (separate/periodic; reads `.ai-factory/patches/*` → skill-context):
```
evolve(ai_coding /aif-evolve) → review(human: approve skill-context diff | rework→evolve) → commit → done
```

**aif-roadmap** (planning only; big initiatives):
```
roadmap(ai_coding /aif-roadmap {{task.prompt}}) → review(human: approve) → commit → done
```

**aif-init** (one-time project configuration; AIF context, no npm):
```
setup(ai_coding /aif) → architecture(ai_coding /aif-architecture) → review(human: approve) → commit → done
```

## 10. Out of scope / Phase 2

- Native `AskUserQuestion` passthrough (adapter fork + `elicitation/create` HITL + UI). **Explicitly not done** (F5, user decision).
- `aif-dev-light` (dev without `/aif-improve`); `aif-autonomous-flow` (front-loaded questions, fully autonomous).
- Connect-time "run init?" prompt UX (init ships as a normal flow instead).
- Additional flows as first-class: `/aif-loop` (Reflex Loop), `/aif-qa`, and utility skills (`dockerize/ci/distillation/...`) — vendored as skills, not yet wrapped as flows.
- Codex-runner parity nuances for materialized agents.

## 11. Verification plan (dogfood)

1. Register MAIster in itself via `maister.yaml` (§4); install bundle + 5 flows.
2. Launch `aif-dev` against a backlog task → worktree created on `maister/<run>`; config override applied; skills/agents present (repo-local) → plan → intake HITL (buttons) → plan_review → implement (permission HITL on edits) → checks → code_review → review → commit; promotion (local_merge) succeeds.
3. `aif-bugfix`, `aif-evolve`, `aif-roadmap`, `aif-init` each run to `done`.
4. Restart web + supervisor mid-`NeedsInput` → reconcile holds.
5. Lint/tests/typecheck green; `pnpm --filter maister-web lint`.

## 12. Resolved decisions (2026-06-08)

1. **Question nodes:** option **buttons + free-text input** (pick or type). §6, §8.3.
2. **Commit gate:** light — no unstaged + Conventional Commits message; no file-composition check. §8.4.
3. **`aif-init`:** manually-launched flow now; connect-time "run init?" prompt = Phase 2.
4. **Vendor source:** copy skills/agents into the package **verbatim from upstream GitHub `2.x`**. For the MAIster dogfood, repo-local precedence (F4/§8.2) means the project's own `.claude/skills` copies win at materialization anyway, per our rules — so the bundle is the portability fallback.
