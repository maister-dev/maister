# Plan: Package-based platform agents (M39)

**Branch:** `feature/studio-package-authoring-editor` (owner: continue here; plan path passed to `/aif-implement` manually — branch-stem discovery won't match)
**Created:** 2026-06-23
**Type:** re-architecture (migration + ~20-module identity re-key + new orchestration + project UI)
**Origin:** resolves the F4 finding from this branch's Codex adversarial review (F1–F3 done + verified).

## Settings

- **Testing:** YES — TDD (red→green). Tests cover functionality + edge cases, minimal overlap, no trivial checks.
- **Logging:** Verbose via the existing `pino` logger boundary (NO `console.log` — `no-console` is enforced).
- **Docs:** YES — SDD: contracts + migration + screen specs are Phase-0 deliverables, not a trailing sync.
- **Quality bar:** SOLID / KISS / DRY + project conventions (`web/CLAUDE.md`, `.ai-factory/rules/*`).

## Roadmap Linkage

- **Milestone:** "M39 — Package-based platform agents" (Stream-A follow-on; owner-confirmed). Rationale: completes the A4 package-root agent move (the F4 finding) by re-keying the M34 per-flow agent model to per-package and adding project-participant attach/enable + optional-flow enrichment + runner policy.
- **Confirmed design choices:** `terminate_restorable` reuses the existing recoverable `NeedsInputIdle` (no new run status); `autoApply='full'` auto-passes `human` review gates (fully autonomous).

## Reservations (skill-context: reserve at main HEAD + budget a renumber pass)

- **ADR-106** (`docs/decisions.md`) — next-free on this branch. ⚠ Renumber-check at merge: G4 holds ADR-104, Stream-B may hold ADR-106/107 → likely renumber (e.g. 108). Write the `### ADR-106` stub before citing it.
- **Migration 0062** (`web/lib/db/migrations`, journal max here = 0061). ⚠ Stream-B may hold 0062 → renumber-check against `_journal.json` at merge (verify number vs prose).
- **Renumber pass** is its own task at merge (Phase 7), AFTER rebasing onto the real main (this worktree's `main` is stale, pre-M38).

---

## Decisions (owner-confirmed)

- **Identity:** agents are PACKAGE-based — `.md` at the package root `maister-agents/`, id `<packageName>:<stem>` (packageName = the manifest `name`, capabilityRefId-shaped). The `AGENT_ID_PATTERN` `<x>:<stem>` grammar already fits.
- **Optional flow:** an agent MAY declare a same-package flow (`flow` frontmatter). WITH flow → launching the agent runs that flow with the agent's `.md` **augmenting** every `ai_coding` node (persona/system layer via the runner's native mechanism; the node keeps its own task prompt). WITHOUT flow → standalone ACP session on triggers.
- **Gating:** a package agent launches when the package is **attached** to the project + the install is **trusted** + the agent row is **enabled**. There is no flow-style `enablementState` — the attachment IS the enable.
- **Runner policy — auto-apply (Q2):** `autoApply: 'off' | 'permissions' | 'full'`. `off` = normal HITL. `permissions` = auto-approve `permission` HITL only — the **"с чел"** variant (`human`/`form` still pause). `full` = auto-approve `permission` + auto-pass `human` review — the **"без чел"** variant. `form` + `infra_recovery` ALWAYS pause regardless of mode (a form needs real structured data; infra needs an operator). `budget_breach` is governed by the budget axis below, not by autoApply. Future per-kind toggles ("разделить галки потом") are a non-breaking superset of this enum.
- **Runner policy — budget / no-escalate (b):** `onBudgetBreach: 'escalate' | 'terminate' | 'terminate_restorable'`. `escalate` (existing) = pause with a `budget_breach` HITL, run stays live + holds the slot. `terminate` (existing) = `Failed`, non-recoverable. `terminate_restorable` (NEW = the owner's no-escalate) = checkpoint the session (keep `acp_session_id`), free the slot, set the run to the EXISTING recoverable `NeedsInputIdle` with a `budget_breach` HITL recorded → restore = raise budget + `session/resume`. **No new run status** (skill-context: a new status fans out to every consumer — avoided by reusing `NeedsInputIdle`).
- **Config home + per-instance override (Q3):** the agent definition `recommended` block SEEDS defaults (`runner`, `branch_base`, `executionPolicy.{autoApply,onBudgetBreach}`); the per-project agent INSTANCE (`agent_project_links`) overrides EVERY field. Effective resolution = instance-override → agent `recommended` → project/platform default. The project panel edits all fields on the instance. Snapshotted onto the run (`runs.execution_policy` + runner snapshot + branch base) at launch (skill-context: the terminal path reads the snapshot, never a post-launch projection).
- **Branch base (c):** optional agent `recommended.branch_base` defaulting to the project's main branch, overridable on the instance (`agent_project_links.branch_base`). Workspace axis (`none|repo_read|worktree`) + `workspace_ref` unchanged.
- **Migration data policy (Q1):** pre-release — `DELETE FROM agents` then re-project via `resyncAgents`. FK fan-out (verified, schema:1167 / :812 / :850): `agent_project_links` + `agent_schedules` **cascade-delete**; `runs.agent_id` is **`onDelete SET NULL`** so run history survives. A post-migration **resync trigger** (startup reconcile + the existing admin `/api/admin/agents/resync`) re-projects from installed packages — without it the catalog stays empty until the next package install (hole closed).
- **DEFERRED (owner "maybe later"):** long-running / continuous project agents (Mγ).

## Reuse (exists — re-point the resolution anchor flow→package; DO NOT rebuild)

`agent_project_links` (attach/enable per project) · `agent_schedules` + cron dispatcher + domain-event consumer w/ self-exclusion (`lib/agents/triggers.ts`) · project agents API GET/POST/PATCH/DELETE (`app/api/projects/[slug]/agents/*`) · flow-binding `mode=session` / `mode=subagent` (`lib/agents/flow-binding.ts`) — the enrichment primitive · standalone `run_kind=agent` launch (`lib/agents/launch.ts`) · workspace axis + `workspace_ref` · runner-resolution chain (`lib/agents/launch.ts:366`, `lib/acp-runners/resolve.ts`) · `ExecutionPolicy`/`budgetState` (ADR-101/102, `schema.ts:1031/1312-1319`) · admin `agents-panel.tsx` (projection-view precedent for the new project panel).

---

## Tasks

### Phase 0 — SDD freeze (analytics + contracts + migration + screens). NO code until COMPLETE + INTERNALLY CONSISTENT.

**T0.1 — ADR-106 + agents domain analytics.** `docs/decisions.md` ADR-106 (package-based agent identity + gating + optional-flow + runner policy). Rewrite `docs/system-analytics/agents.md`: identity `<packageName>:<stem>`, resolution (attachment→packageInstalls.installedPath→`maister-agents/<stem>.md`), gating allow-list (attached + trusted + enabled — written EXACTLY as the code will gate), trigger lifecycle (enable agent ⇒ enable triggers), optional-flow enrichment vs standalone, runner policy (auto-apply / no-escalate=terminate-restorable), branch base.
  - *Acceptance:* every state transition + every refusal/precondition enumerated; gating stated as an allow-list; implementation-status tags present; no section describes code absent at phase HEAD.

**T0.2 — DB contract.** `docs/database-schema.md` narrative + the relevant `docs/db/*.md` Mermaid `erDiagram`: `agents.flow_ref_id` → `package_name` (NOT NULL) + `flow_ref` (nullable) + `branch_base` (nullable) + `recommended` extended with executionPolicy; reindex `agents_flow_ref_idx` → `agents_package_name_idx`. Note `agent_project_links` gains `branch_base`/`execution_policy_override` (nullable). BOTH artifacts updated.
  - *Acceptance:* ERD narrative AND Mermaid both reflect every column/index; migration data policy (delete+re-project) documented.

**T0.3 — API contract.** `docs/api/web.openapi.yaml`: agent id format → `<packageName>:<stem>` across `/api/admin/agents*`, `/api/projects/{slug}/agents*` (+ new config fields on the link: branch base, auto-apply, no-escalate, flow-ref override), `/api/agents/{agentId}/event`, and the `/api/v1/ext/runs/{delegate,plan,promote}` agent refs. Identifiers sub-bullet per route labelling each id (`url-param`/`auth-context`/`server-state`/`body-controlled`); no `body-controlled` cross-resource id when a `server-state` value exists.
  - *Acceptance:* every changed route has request/response/status + example payloads + the identifiers table; redocly/`validate:docs` green.

**T0.4 — Screen spec.** `docs/screens/...` for the project-settings **Agents** panel (attach/enable from attached packages, per-agent triggers cron/event, branch base, runner override, auto-apply/no-escalate toggles, "toggle agent ⇒ toggle triggers"). Strong expectations + acceptance criteria (affordances per `web/CLAUDE.md`: icon buttons, green-check success, view-only table + popup edits).
  - *Acceptance:* screen doc covers states (no attached packages / available / attached+enabled / disabled), interactions, and accessibility per the data-management-page bar.

**T0.5 — Config-schema contract.** Specify the agent `.md` frontmatter additions in `web/lib/config.schema.ts` terms: optional `flow` (same-package flow id), optional `branch_base`, `recommended.executionPolicy` ({autoApply, onBudgetBreach: 'terminate_restorable'}). Same-package `flow` validation rule stated.
  - *Acceptance:* schema delta written; `flow` cross-validation (must exist in the package manifest's `flows[]`) specified; reserved/unknown-key behavior stated.

> **Phase 0 exit:** all five artifacts complete + mutually consistent; ADR-106 stub committed; migration 0062 reserved. This is the single source of truth the code phases follow.

### Phase 1 — Schema + migration (TDD)

**T1.1 — Schema change** `web/lib/db/schema.ts`: `agents` — `flow_ref_id` → `package_name` (text NOT NULL) + add `flow_ref` (text null) + `branch_base` (text null); extend `recommended` type with `executionPolicy`. `agent_project_links` — add `branch_base` (null) + `execution_policy_override` (jsonb null). Reindex.
**T1.2 — Migration 0062** via `drizzle-kit generate` + hand-add the data step: `DELETE FROM agents` (cascade-deletes `agent_project_links` + `agent_schedules`; `runs.agent_id` SET NULL — history preserved), drop `flow_ref_id` + its index, add `package_name` (NOT NULL) + `flow_ref` + `branch_base` + the new index, and `agent_project_links.branch_base` + `execution_policy_override`. Verify `_journal.json` number == prose (skill-context).
**T1.3 — Post-migration resync trigger** — the destructive migration empties the catalog; re-project from installed packages: invoke `resyncAgents` from the startup reconcile path (a deploy that runs the migration repopulates the catalog) AND confirm the existing admin `/api/admin/agents/resync` covers the manual path.
  - *Acceptance:* `pnpm db:generate` clean; migration applies on a fresh testcontainer; after migrate+resync the catalog is repopulated from packages (integration); a pre-existing `runs.agent_id` survives as NULL (not deleted); journal number == prose. Logging: `pino` info with re-projection counts.

### Phase 2 — Definition + registration (TDD)

**T2.1 — `lib/agents/definition.ts`** add to the frontmatter schema + `ParsedAgentDefinition`: optional `flow` (same-package flow id, capabilityRefId), `branch_base`, and `recommended.executionPolicy: { autoApply?: 'off'|'permissions'|'full'; onBudgetBreach?: 'escalate'|'terminate'|'terminate_restorable' }`; `qualifyAgentId(packageName, stem)`. Strict (unknown keys refused, ADR-089).
  - *Acceptance:* render→parse round-trips the new fields; an invalid `autoApply`/`onBudgetBreach` enum value → CONFIG; `flow` shape validated.
**T2.2 — `lib/agents/registry.ts`** register from `package_installs` (scan `installedPath/maister-agents/*.md`), `package_name` anchor, id `<packageName>:<stem>`, validate `flow` ∈ the package manifest's `flows[]`; `resyncAgents` projects the newest Installed per package name; SET/CLEAR column symmetry. **`lib/flows.ts:808`** drop the per-flow `registerAgentsForRevision` call; wire package-level registration into `installPackageRevision` (`lib/packages/attach.ts`) after flow installs.
  - *Acceptance:* installing a multi-flow package with package-root `maister-agents/<stem>.md` registers `<packageName>:<stem>` rows (integration, real PG); an agent whose `flow` is absent from the manifest's `flows[]` is reported invalid + never written — AND a later package upgrade that REMOVES the referenced flow re-flags it on resync so launch refuses with PRECONDITION (edge case); a removed `.md` disables (never deletes) its row on resync. Trust/exec separation: registration never executes `.md` content.

### Phase 3 — Effective resolution + gating (TDD)

**T3.1 — `lib/agents/effective.ts`** `splitQualifiedAgentId` prefix = packageName; `resolveEffectiveAgentDefinition` resolves via the project's package attachment → `packageInstalls.installedPath/maister-agents/<stem>.md`; gate allow-list = attached + install trusted + agent enabled. `assertAgentPackageAttachable` + `listEnabledPackageRefs` package-level.
  - *Acceptance:* a package-root agent in an attached+trusted+enabled package resolves + launches end-to-end; each refusal (not attached / untrusted / disabled) returns PRECONDITION with the exact message; gate is an allow-list (a future state is rejected by default). Identifiers: `projectId` server-derived, never body.

### Phase 4 — Optional-flow enrichment "agent drives a flow" (TDD)

**T4.1 — Launch-with-flow** in `lib/agents/launch.ts` (+ `flow-binding.ts` reuse): when the effective agent has `flow_ref`, launch that flow as the run and inject the agent's `.md` as the persona/system layer (augment, not replace) on EVERY `ai_coding` node via the runner's native mechanism (reuse `mode=session` injection across all nodes). No `flow_ref` → standalone ACP session (existing path). Snapshot the resolved flow + agent persona onto the run.
  - *Acceptance:* an agent-with-flow run executes the flow and every `ai_coding` node's prompt = agent persona + the node's own task prompt (assert both present, order persona-then-task); a no-flow agent runs standalone on its trigger; branch on `run_kind`/has-flow BEFORE routing (skill-context: shared dispatch must branch on the discriminant). Test per arm (with-flow / without-flow).

### Phase 5 — Runner policy: auto-apply + no-escalate (TDD)

**T5.1 — Policy resolution + snapshot.** Resolve the effective `executionPolicy` for an agent launch in the Q3 order: `agent_project_links.execution_policy_override` (instance) → agent `recommended.executionPolicy` → project/platform default. Snapshot it onto `runs.execution_policy` at spawn (alongside the runner snapshot + branch base).
**T5.2 — auto-apply enforcement.** At the HITL boundary, read the mode from the run snapshot: `permissions` auto-resolves `permission` requests (approve); `full` additionally auto-passes `human` review; `form` + `infra_recovery` ALWAYS pause; `budget_breach` is never auto-applied (the budget axis owns it).
**T5.3 — no-escalate (`terminate_restorable`).** Wire into the ADR-101/102 budget terminal path: on breach with `terminate_restorable`, in ONE transaction checkpoint (keep `acp_session_id`) + transition to `NeedsInputIdle` + record a `budget_breach` HITL + free the slot (`promoteNextPending`); restore = raise budget → `session/resume`. Close status + ledger + HITL together (skill-context: atomic multi-store + enumerate crash-windows).
  - *Acceptance:* a `permissions`-mode run never persists a `permission` HITL pause but DOES pause at a `human` node; a `full`-mode run auto-passes `human` too; `form` pauses in every mode; a `terminate_restorable` breach lands in `NeedsInputIdle` (assert recoverable, NOT `Failed`), frees a slot (a queued run promotes), and resumes after a budget raise; the terminal path reads the run snapshot, never a post-launch projection. Per-arm tests for the meaningful `autoApply × onBudgetBreach` combos (no trivial/overlapping cases).

### Phase 6 — Project-view UI + trigger toggle (TDD)

**T6.1 — Project settings Agents panel** `components/settings/...` (parallel to admin `agents-panel.tsx`): list attached + available agents from the project's attached packages; attach/enable; and edit EVERY field ON THE INSTANCE (Q3), each seeded from the agent's `recommended` and overridable — triggers (cron/event), `branch_base`, runner override, `autoApply` (a 3-way control: off / `permissions` "с чел" / `full` "без чел"), `onBudgetBreach` (escalate / terminate / terminate_restorable). Wire to the project agents API (extend PATCH for the new instance fields; identifiers: `projectId`/`agentId` server-derived, never body).
**T6.2 — Toggle agent ⇒ toggle triggers.** Disabling an agent link disables its `agent_schedules` rows (today it only fails the launch gate) AND revokes live agent tokens (existing); enabling re-enables the schedules (does NOT resurrect the revoked ephemeral per-launch tokens). EN+RU i18n.
  - *Acceptance:* dom test (renderToStaticMarkup) for each panel state (no attached packages / available / attached+enabled / disabled) + the 3-way autoApply control; disabling an agent flips its schedules `enabled=false` AND revokes tokens (integration); re-enabling restores schedules only; affordances per `web/CLAUDE.md` (icon buttons, green-check); i18n parity (EN+RU).

### Phase 7 — Consumer fan-out sweep + finalize (TDD + green gate)

**T7.1 — Sibling sweep** every reader of `agents.id`/`flow_ref_id` to the package anchor: `lib/agents/{launch,triggers,project-links,tokens,flow-binding,dirty-watchdog}.ts`, `lib/domain-events/auto-launch.ts`, `lib/runs/run-kind-invariants.ts`, `lib/queries/{portfolio,project,run}.ts`, `lib/capabilities/adapter-home.ts`, `lib/tokens/verify.ts`, `app/api/admin/agents/[agentId]/route.ts`, `app/api/projects/[slug]/agents/*`, `app/api/v1/ext/runs/{delegate,plan,promote}/route.ts`, `app/api/agents/[agentId]/event/route.ts`, `app/(app)/agents/page.tsx`, Studio agent surfaces. Grep `agents.id`/`flow_ref_id` to zero stale refs.
**T7.2 — Assertion migration:** enumerate + update every existing agent test asserting `<flowRefId>:<stem>` / per-flow resolution (registry/effective/launch/triggers/flow-binding integration + e2e seeds).
**T7.3 — Renumber + docs finalize:** verify ADR-106 / migration 0062 vs the real main at merge (renumber pass); `validate:docs` + ADR-anchor check; EN+RU i18n parity.
  - *Acceptance:* `grep agents.id|flow_ref_id` shows no stale per-flow refs; full suite green (`pnpm typecheck && pnpm test:unit && pnpm test:integration`); no test left red without a quarantine task; redocly + docs gates green.

---

## Contract-surface → spec-file map (skill-context: trace every surface)

| Surface | Spec file |
| --- | --- |
| `agents` table columns + index | migration 0062 + `docs/database-schema.md` + `docs/db/*.md` ERD |
| agent id format + project/admin agent routes + ext run routes | `docs/api/web.openapi.yaml` |
| agent `.md` frontmatter (`flow`/`branch_base`/`recommended.executionPolicy`) | `web/lib/config.schema.ts` + `docs/flow-dsl.md` (agent section) |
| agent domain (identity/gating/triggers/enrichment/policy) | `docs/system-analytics/agents.md` + ADR-106 |
| project-settings Agents panel | `docs/screens/...` |
| no new error code expected | (reuse PRECONDITION/CONFLICT; if a new one is needed → `docs/error-taxonomy.md`) |

## Test integrity (skill-context)

- **Runnability:** integration tests land under a globbed path (`lib/agents/__tests__/*.integration.test.ts`); confirm the runner matches before listing a test as a deliverable. New `app/**` test paths → extend the runner config in the same phase.
- **Per-phase green:** each phase exits on `pnpm typecheck && pnpm test:unit && pnpm test:integration` green. Pre-existing red → explicit quarantine task with reason, never silent.
- **No trivial/overlapping tests** (owner): each test asserts a distinct behavior or edge case.

## Risks

- **Migration renumber/ADR collision** with G4 (ADR-104) + Stream-B (ADR-106/107, migr 0062) — renumber pass at merge (T7.3); reserve stubs now.
- **Stale `main` in this worktree** (pre-M38) — rebase onto the real main before the renumber pass.
- **Blast radius** (~20 modules + FK tables) — the Phase-7 grep-to-zero gate is the backstop.
- **Enrichment correctness** — augment-not-replace must preserve each node's own prompt; per-arm tests guard it.

## Commit Plan (7 phases → checkpoint per phase)

1. Phase 0 — `docs(agents): SDD freeze — package-based agents (ADR-106)`
2. Phases 1-2 — `feat(agents): package-keyed schema+migration 0062 + registration`
3. Phase 3 — `feat(agents): package-anchored effective resolution + gating`
4. Phase 4 — `feat(agents): optional-flow enrichment (agent drives a flow)`
5. Phase 5 — `feat(agents): runner auto-apply + no-escalate (terminate-restorable)`
6. Phase 6 — `feat(agents): project-settings agents panel + trigger toggle`
7. Phase 7 — `refactor(agents): consumer fan-out sweep + docs/renumber finalize`
