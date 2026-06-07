# Implementation Plan: M26 — Structured Node Output Channel (P1) + Run-Context File (P7)

Branch: feature/m26-structured-output-run-context
Created: 2026-06-07
Refined: 2026-06-07 (/aif-improve pass 1 — transport, schema-form, engine fan-out, gate-verdict projection; pass 2 — Codex adversarial: SDD artifact + multiagent execution model)

## Settings
- Testing: yes (full TDD per phase — QA-RED → impl-GREEN → reviewer, per project SDD)
- Logging: standard (INFO-level key events; no DEBUG firehose)
- Docs: yes (mandatory docs checkpoint; docs-first Phase 0 + completion checkpoint via /aif-docs)

## Roadmap Linkage
Milestone: "M26 — Flow-engine foundations: structured node output channel (P1) + run-context file (P7)"
Rationale: The last unfinished Wave-1 track in `docs/pv/improvement-roadmap.md` (the named "keystone pair"); completes the Wave-1 exit goal "every run emits structured signal" and unblocks every Wave-2 flow-engine increment (P2/P4/P6/P3). New milestone — append to `.ai-factory/ROADMAP.md` in Phase 0.

---

## Multiagent Execution Model (how this plan is executed)

This plan runs through the project's **SDD + agent-driven TDD** workflow (the model M11c / M15 / M19
used). `/aif-implement` is the coordinator; `implement-coordinator` + `implement-worker` carry
parallel tasks; `/codex:adversarial-review` is the per-phase challenge gate.

**Phase 0 (spec-freeze) gates everything.** No code task starts until the SDD spec
(`.ai-factory/specs/feature-m26-structured-output-run-context.md`) + ADR-063 + analytics docs are
**complete and internally consistent**. The SDD is the **single source of truth**; any later
deviation requires a **spec amendment**, never an ad-hoc code change.

**Per code task — role rotation (RED → GREEN → review):**

| Role | Agent | Responsibility |
|---|---|---|
| **QA-RED** | test author | Writes the failing test(s) FIRST from a specific SDD acceptance criterion; proves **RED for the right reason** before any implementation. |
| **impl-GREEN** | `implement-worker` | Owns an **explicit, disjoint file set**; writes the minimum to turn RED→GREEN; no scope beyond the task. |
| **reviewer** | code/bug reviewer (`review-sidecar`) | Bug-risk + convention + skill-context-rule review of the task diff. |
| **security / docs** | `security-sidecar` / `docs-auditor` | Security check (untrusted-output parsing) + docs-drift check, where the task touches those surfaces. |

**Per-phase checkpoint:** before each commit checkpoint, a `/codex:adversarial-review` pass
challenges the phase diff. A phase is **done only when** (a) RED-before-GREEN evidence exists for
every TDD task, (b) full suite green (`pnpm test:unit && pnpm test:integration`; e2e in Phase 4),
(c) reviewer + adversarial findings are resolved.

**Parallelism / write scopes:** tasks within a phase touching **disjoint** files MAY run as parallel
`implement-worker`s under `implement-coordinator`; tasks sharing a file (e.g. all touching
`runner-graph.ts`) run **sequentially**. Each task header names its owned files — two concurrent
workers MUST NOT share a write target.

**Spec-to-test trace:** every SDD acceptance criterion maps to ≥1 named test (the spec's
spec-to-test matrix). `/aif-verify` re-derives the matrix from the diff at the end.

---

## Goal

Give **every graph node** a way to emit a **schema-validated structured result** into the existing
`node_attempts.vars` channel (today only `human`/HITL nodes populate it), and maintain a
**session-independent run-context JSON file** under `.maister/` that projects run-level state
(intent + node vars + gate verdicts) and whose path is handed to each node. Together they enable
structured forward handoff, agent-driven dynamic routing (P4, later), and richer observatory
signals (E2) — without a DB migration and without a new dependency.

## Scope boundary (surgical)

- **In:** P1 (structured node output channel) + P7 (run-context file), **graph engine only**
  (`runner-graph.ts` / `node_attempts`). Opt-in per node.
- **Out (explicitly):** legacy linear `steps[]` flows (use `runner.ts`/`step_runs`, unchanged —
  the bundled `aif` flow is already `nodes[]`); P2 prompt content injection; P3 diff-path
  assertions / `hash`·`size_bytes` activation; P4 `decide` table; P6 session continuity.
- **Not this plan:** the in-flight M22/ADR-062 `flow_graph_layouts` drop in the working tree is a
  **separate** change (tracked outside M26).

## Current state (verified anchors)

| Fact | Anchor |
|---|---|
| `node_attempts.vars` jsonb `NOT NULL default '{}'` — **exists, reuse, no migration** | `web/lib/db/schema.ts:1249-1325` |
| Only `human`/HITL nodes write vars; agent/cli/check/judge always return `vars: {}` | `runner-agent.ts:580,608,718,746`; `runner-cli.ts:156` |
| All vars writes funnel through `markNodeSucceeded(..., { vars })` (single UPDATE) | `web/lib/flows/graph/ledger.ts:128-160` |
| `reduceLedger` → `{{steps.<id>.vars.<key>}}`, highest-attempt-wins | `web/lib/flows/context.ts:119-143` |
| Gate verdicts live in a **separate** table `gate_results.verdict` (jsonb) | `web/lib/db/schema.ts:1357-1408`; `web/lib/flows/graph/gate-store.ts` |
| **Post-action seam** (result.ok true, before gates) — where P1 parse/validate hooks | `runner-graph.ts:1110 → 1139` (then `markNodeSucceeded` at `:1574`) |
| Agent stdout captured (`result.stdout` = full agent text snapshot) at the seam | `runner-agent.ts` (consumer snapshot → `StepResult.stdout`) |
| M17 `extraVars` convergence channel (durable `rework-comments-<step>.json` via `atomicWriteJson`) | `context.ts:163,217`; graph in-memory `pendingInjectedVars` `runner-graph.ts:790,937,942,1555` |
| Mustache strict, undefined leaf → `MaisterError("CONFIG")` | `web/lib/flows/templating.ts:40,55,88` |
| Agent prompt seam (after `renderStrict`, before dispatch/`sendPrompt`) | `web/lib/flows/runner-agent.ts:485-506` |
| **`form_schema` precedent = a `./path`** resolved vs flow install dir + escape-guard, validated against `formSchemaSchema` | decl `config.schema.ts:245`; resolve `runner-human.ts:63-70`; grammar `config.schema.ts:703`; validate `config.ts:1033` |
| Node manifest `output:` block (M12 `produces[]`, `.passthrough()`) — extension point | `web/lib/config.schema.ts:383-400`, composed `:573` |
| Hand-rolled validator (the grammar to reuse) | `web/lib/flows/hitl-validate.ts:23-63` + `formSchemaSchema` |
| Engine `1.2.0`; **two existing gates** (graph `1.1.0`, artifact `1.2.0`) to mirror | `engine-version.ts:17`; `ARTIFACT_ENGINE_MIN` `config.ts:606`; artifact gate `runner-graph.ts:1173` |
| `runtimeRoot() = MAISTER_RUNTIME_ROOT ?? process.cwd()`; run dir `<runtimeRoot>/.maister/<slug>/runs/<runId>/` | `web/lib/instance-config.ts:24`; `runner-graph.ts:115` |
| **Agent cwd = `worktreePath`** under `~/.maister/worktrees/...` (the user's repo) — a different tree from the run dir | `instance-config.ts:16`; `worktree.ts` |
| M14 materializes `<worktreePath>/.claude/settings.local.json` (no `additionalDirectories`) → agent fs-scope = its worktree cwd | `web/lib/capabilities/cleanup.ts:99`; `agent-map.ts` |
| `atomicWriteJson(path, data)` tmp+rename; `.maister/` gitignored | `web/lib/atomic.ts:11-35`; `.gitignore` |
| `aif` declares `compat.engine_min: 1.2.0`, **no `engine_max`** → engine bump safe | `plugins/aif/flow.yaml:15` |

---

## Decisions (locked — all open questions resolved with the user)

1. **Opt-in per node.** P1 parse/validate activates **only** for a node declaring `output.result`.
   A node without it behaves exactly as today (`vars: {}`). Additive, surgical.
2. **Reuse the existing `formSchemaSchema` grammar — no new dependency.** Generalize the
   `validateHitlResponse` validator (`hitl-validate.ts`) into a shared `validateStructuredOutput`;
   human form-responses AND node outputs validate through **one** grammar (add nested-object support
   if a node output needs it).
3. **`output.result.schema` is a `./path`** (NOT inline) resolved against `flowInstallPath` with the
   `runner-human.ts:63-70` escape-guard, read, validated against `formSchemaSchema` — consistent with
   `form_schema` and M12 `produces[].schema`.
4. **Hybrid transport** (the #10 finding — agents cannot write outside their worktree cwd):
   - **agent nodes → fenced JSON block in stdout.** Runner appends a one-line instruction ("end your
     response with a single ` ```json maister:output ` block matching the schema") and extracts that
     **sentinel-tagged** block from the captured `result.stdout` (full snapshot, pre-truncation).
     **No file write by the agent.**
   - **cli/check nodes → `MAISTER_OUTPUT_FILE`** env = abs path
     `<runDir>/output-<nodeId>-<attempt>.json`; the command writes JSON there; runner reads it.
5. **Validation failure → `MaisterError("CONFIG")`** (no new code) → attempt `Failed`
   (`errorCode: "CONFIG"`), mirroring `runner-human.ts:203`.
6. **`run.json` lives in the worktree, projects vars + gate results** (B3 + user decision): a single
   context blackboard at **`<worktreePath>/.maister/run.json`** (inside the agent cwd → readable by
   claude AND codex with no out-of-cwd/`.claude`-settings assumption). The runner git-excludes
   `.maister/` for the worktree (idempotent `info/exclude` append) so it never enters `git status`/the
   base→run diff. Shape `{ intent, nodes:{<id>:{summary,vars}}, gates:{<id>:{status,verdict?}},
   promoted:{} }` — `status` always present (the signal for null-verdict `command_check`/`human_review`).
   Logs (`<stepId>.log`, `run.events.jsonl`, `cost.jsonl`) stay at `<runDir>`.
7. **P7 is a derived projection, regenerated idempotently from the ledger** (`reduceLedger` +
   `gate_results` read + `task.prompt`) after each ledger transition. Correctness MUST NOT depend on
   it — a fresh/cleared/resumed session reconstructs `run.json` from `node_attempts`+`gate_results`+
   worktree. Best-effort write; missing/stale `run.json` self-heals next node.
8. **Engine bump `1.2.0` → `1.3.0`**, gated: a flow declaring `output.result` must declare
   `compat.engine_min >= 1.3.0`. Add `OUTPUT_ENGINE_MIN = "1.3.0"` mirroring `ARTIFACT_ENGINE_MIN`;
   output validation runs only at `engine_min >= 1.3.0`. `aif` has no `engine_max` → safe.
9. **Output size cap = env var** `MAISTER_NODE_OUTPUT_MAX_BYTES` (default 256 KiB), CONFIG on exceed,
   read via an `instance-config.ts` helper (mirrors `workbenchMaxFileBytes()`). Wired in `.env.example`
   + `docs/configuration.md` **only — NOT `compose.yml`** (`web` runs on the host, ADR-023; matches
   the `MAISTER_WORKBENCH_MAX_FILE_BYTES` precedent).
10. **P7 projection selection = hardcoded "all"** for M26 (intent + all node vars + all gate
    verdicts). Config-driven selector deferred to a later wave.
11. **Stale-file guard:** cli output file is **per-attempt** (`output-<nodeId>-<attempt>.json`) so a
    non-writing rework attempt N can never inherit attempt N-1's file. Agents have no file → moot.
12. **No DB migration. No new route. No new run status/enum. No new `MaisterError` code.**

### Identifiers / trust boundary (skill-context rule)
No new HTTP route. The only externally-influenced inputs are the **agent's fenced block** and the
**cli output file** — both treated as **untrusted content**: size-capped (`MAISTER_NODE_OUTPUT_MAX_BYTES`),
JSON-parsed defensively, validated against the **server-declared** schema before any value enters
`vars`. All paths are `server-state` (runner-derived from `runId`/`nodeId`/`attempt`), never
agent/body-controlled.

### Multi-store atomicity / crash windows (skill-context rule)
- **P1**: validated vars fold into `result.vars`, persisted by the **existing single**
  `markNodeSucceeded` UPDATE. No new write, **no new crash window**. Validation runs BEFORE the
  ledger write; failure → `markNodeFailed` (CONFIG), same single-write discipline. **No ACP deferred is
  open at this seam** — it runs only after the agent turn reached `end_turn` (`result.ok`), by which
  point `sendPrompt` has drained every permission deferred; `markNodeFailed` here leaks nothing (the
  skill-context deferred-release rule does not apply — no deferred is created/owned at this point).
- **P7**: `run.json` is a derived side-effect, **not** part of any transition's correctness. Crash
  before/after the write → next node entry regenerates it from the ledger. No recovery-sweep change.

### Contract surfaces → spec files (skill-context rule)
| Surface changed | Spec file(s) to update |
|---|---|
| New Flow DSL field `output.result { schema: ./path, required? }` | `docs/flow-dsl.md` + `web/lib/config.schema.ts` |
| Agent fenced-block (`maister:output`) + cli `MAISTER_OUTPUT_FILE` contract | `docs/flow-dsl.md` (per-node-type output contract) |
| Node-output + run-context runtime behavior, Expectations, Edge cases | `docs/system-analytics/flow-graph.md` (R5) |
| Engine `1.3.0` + `compat.engine_min` gate | `engine-version.ts` + `docs/flow-dsl.md` + `docs/configuration.md` |
| **New env var `MAISTER_NODE_OUTPUT_MAX_BYTES`** | `.env.example` + `docs/configuration.md` env table + `instance-config.ts` reader (**NOT `compose.yml`** — `web` is host-run, ADR-023) |
| Worktree git-exclude of `.maister/` for `run.json` | runner write path (`info/exclude` append); no spec file |
| New SDD spec | `.ai-factory/specs/feature-m26-structured-output-run-context.md` |
| New ADR (P1/P7 decisions) | `docs/decisions.md` (ADR-063 — current max is 062) |
| No new DB column / route / status / error code | — (assert "none" in the docs checklist) |

---

## Commit Plan
- **Commit 1** (Phase 0, tasks 1-3): `docs(m26): spec-freeze — SDD spec + ADR-063 + flow-graph analytics`
- **Commit 2** (Phase 1, tasks 4-6): `feat(m26): shared output-schema validator + output.result manifest + engine 1.3.0 gate`
- **Commit 3** (Phase 2, tasks 7-11): `feat(m26): hybrid output transport → node_attempts.vars + env size-cap wiring`
- **Commit 4** (Phase 3, tasks 12-14): `feat(m26): run.json projection (vars + gate verdicts) + per-node pointer`
- **Commit 5** (Phase 4, tasks 15-17): `feat(m26): aif structured handoff demo + e2e`
- **Commit 6** (Phase 5, tasks 18-19): `docs(m26): completion checkpoint + ROADMAP M26 flip`

---

## Tasks

### Phase 0 — Spec freeze (docs-first, NO code). Skill-context: analytics is an INPUT. Gates all code.
- [x] **Task 1: Create the M26 SDD spec.** Author `.ai-factory/specs/feature-m26-structured-output-run-context.md`
  in the project spec format (matching M24/M25): **Status** (Designed, Wave 1), **Value**, **Non-goals**
  (the Scope-boundary "Out" list), **Expectations** (normative MUSTs: opt-in `output.result`; agent
  fenced `maister:output` block / cli `MAISTER_OUTPUT_FILE`; validate-before-`Succeeded`; CONFIG on
  mismatch/oversize/bad-JSON; `run.json` = `{intent,nodes(vars+summary),gates(verdicts),promoted}`,
  separate from logs, regenerated from the ledger, no env secrets; engine 1.3.0 gate; per-attempt cli
  file; no migration/route/status/error-code), **Acceptance criteria**, **Contract trace** (the table
  above), and a **spec-to-test matrix** (each acceptance criterion → the named test that proves it).
  This is the frozen SSOT every later phase implements to. Verify: spec internally consistent with
  ADR-063 + analytics; every Phase 1-4 behavior has a matching Expectation + a matrix row.
- [x] **Task 2: ADR-063.** Append to `docs/decisions.md` capturing Decisions 1-12 (opt-in
  `output.result`; reuse `formSchemaSchema`; `./path` schema; **hybrid transport**; CONFIG on
  mismatch; `run.json` with vars **and** gate verdicts, separate from logs; derived/regenerated
  projection; engine 1.3.0 gate; env size-cap; per-attempt cli file; no migration/route/status/error
  code). State the M17 `extraVars`/`vars` convergence ("no parallel channel"). Verify:
  `pnpm validate:docs:all` green; references the SDD spec.
- [x] **Task 3: Analytics freeze.** `docs/system-analytics/flow-graph.md` (R5): node lifecycle gains
  the post-action **parse→validate→populate-vars** seam (per-type transport); add **Run-context
  file** subsection (location, `{intent,nodes,gates,promoted}` shape, regenerate-from-ledger,
  session-independence, gitignored, separate-from-logs); enumerate **Expectations** and **Edge
  cases** (missing block/file, invalid JSON, schema mismatch, oversize, stale per-attempt file,
  no-declaration=unchanged) each linked to `CONFIG`. Update `docs/flow-dsl.md` (`output.result`,
  fenced-block + `MAISTER_OUTPUT_FILE` contracts, `compat.engine_min: 1.3.0`) and the env-var/engine
  rows in `docs/configuration.md`. Tag **Designed** (→ Implemented in Phase 5). Verify:
  `pnpm validate:docs:all` green; every described piece traces to an SDD Expectation.
  **Phase 0 exit:** SDD + ADR-063 + analytics complete and mutually consistent; spec-to-test matrix
  covers every acceptance criterion. No code until this holds.
  <!-- Commit checkpoint: tasks 1-3 -->

### Phase 1 — Schema grammar + manifest declaration + engine gate. [each task: QA-RED → impl-GREEN → review]
- [ ] **Task 4: Shared output validator.** Generalize `validateHitlResponse` (`hitl-validate.ts`)
  into `validateStructuredOutput(value, schema) → {ok}|{ok:false,message}` over `formSchemaSchema`;
  add **nested-object** support; keep `hitl-validate.ts` delegating (HITL forms unchanged — migrate
  its existing tests, assert green). QA-RED: per-type pass/fail incl. nested + existing HITL cases.
  Logging: INFO on validation fail with node id (no values). Owns: `web/lib/flows/output-schema.ts`
  (or extend hitl-validate), `__tests__`.
- [ ] **Task 5: `output.result` manifest field.** Extend `nodeOutputSchema`
  (`config.schema.ts:383-400`) with `result: { schema: z.string() (./path), required?: boolean }`.
  Runtime path resolution reuses `runner-human.ts:63-70` (resolve vs `flowInstallPath` + escape-guard);
  resolved file validated against `formSchemaSchema`. Manifest-level Zod errors → `CONFIG`. QA-RED:
  valid decl parses; path-escape rejected; node without `output.result` unaffected. Owns:
  `config.schema.ts`, `config.ts`, `validateGraphManifest`, `__tests__`. (Shares `config.ts` with
  Task 6 → run Tasks 5,6 sequentially.)
- [ ] **Task 6: Engine 1.3.0 + gate.** Bump `MAISTER_ENGINE_VERSION`→`1.3.0` (`engine-version.ts:17`);
  add `OUTPUT_ENGINE_MIN="1.3.0"` in `config.ts` mirroring `ARTIFACT_ENGINE_MIN` (:606);
  `validateGraphManifest` rejects (`CONFIG`) a flow declaring any `output.result` without
  `compat.engine_min >= 1.3.0`; update the `engine-version.test.ts` assertion. QA-RED: gated
  accept/reject; flows without `output.result` valid at any engine_min. Owns: `engine-version.ts`,
  `config.ts`, `__tests__`. Phase exit: `pnpm test:unit` green (full suite) + adversarial pass.
  <!-- Commit checkpoint: tasks 4-6 -->

### Phase 2 — Runner integration: hybrid transport → parse → validate → populate vars. [QA-RED → impl-GREEN → review]
- [ ] **Task 7: Transport provisioning.** For nodes declaring `output.result`: **agent** → append the
  `maister:output` fenced-block instruction to the resolved prompt at the `runner-agent.ts:485-506`
  seam (combined with Task 12's pointer append); **cli/check** → inject
  `MAISTER_OUTPUT_FILE=<runDir>/output-<nodeId>-<attempt>.json` into the `execFile` env in
  `runner-cli.ts` (currently passes no `env` → add `{ ...process.env, MAISTER_OUTPUT_FILE }`). **Thread
  `attempt` into `RunCliStepCtx`** (not present today — pass it from the `runGraph` scope through
  `executeNodeAction`) so the per-attempt filename is buildable. QA-RED: instruction present for agent;
  per-attempt env var for cli; absent when no `output.result`. Owns: `runner-graph.ts`, `runner-cli.ts`,
  `runner-agent.ts`, `__tests__`. (Shares `runner-graph.ts` with Tasks 8/12 → sequential.)
- [ ] **Task 8: Parse + validate at the post-action seam.** Insert at `runner-graph.ts` **~1124-1138**
  (after `if (!result.ok)` returns and `result.vars` is mutable, before `if (node.gates.length > 0)`),
  when the node declares `output.result`: **agent** → extract the last `maister:output` fenced block
  from the 1 MiB-capped `result.stdout` (a block lost past the cap → **absent**); **cli** → read
  `output-<nodeId>-<attempt>.json`. Enforce `MAISTER_NODE_OUTPUT_MAX_BYTES`; `JSON.parse` defensively;
  `validateStructuredOutput` against the resolved schema. Success → set `result.vars` (→ `markNodeSucceeded` → `node_attempts.vars`).
  Failure (missing & `required`, bad JSON, mismatch, oversize) → `markNodeFailed` (`CONFIG`). Node
  WITHOUT `output.result` → untouched. QA-RED for every branch. Logging: INFO "node <id> output
  validated (<n> keys)" / WARN per failure class (no values). Owns: `runner-graph.ts`, `__tests__`.
- [ ] **Task 9: Env reader + wiring.** Add a `nodeOutputMaxBytes()` reader to
  `web/lib/instance-config.ts` (mirror `workbenchMaxFileBytes()`; default `262144`). Add
  `MAISTER_NODE_OUTPUT_MAX_BYTES` to `.env.example` and the env-var table in `docs/configuration.md`.
  **Do NOT touch `compose.yml`** — `web` runs on the host (ADR-023); a grep MUST confirm the var is
  absent from all compose overlays (the `MAISTER_WORKBENCH_MAX_FILE_BYTES` precedent). QA-RED: default
  read when unset; override honored. Owns: `instance-config.ts`, `.env.example`, `docs/configuration.md`.
  (Disjoint from Tasks 7/8 → MAY run parallel.)
- [ ] **Task 10: Forward-handoff end-to-end.** Two-node graph: node A emits (agent block + cli file
  variants), node B's prompt resolves `{{steps.A.vars.<key>}}` via `reduceLedger` (no new plumbing).
  QA-RED integration test; confirm the `include` glob matches the file (runnability rule). Owns:
  `web/lib/__tests__/*.integration.test.ts`, fixtures.
- [ ] **Task 11: Negative + back-compat.** Oversize / malformed / mismatch / absent-while-required /
  block-lost-past-1MiB-cap → attempt `Failed`/`CONFIG`, run unpromotable; stale per-attempt file never
  read across rework; an existing graph flow with no `output.result` is byte-identical (regression).
  (No ACP-deferred test — the seam runs post-`end_turn`, no deferred is open; B2.) Owns: `__tests__`.
  Phase exit: `pnpm test:unit && pnpm test:integration` green + adversarial pass.
  <!-- Commit checkpoint: tasks 7-11 -->

### Phase 3 — Run-context file (P7). [QA-RED → impl-GREEN → review]
- [ ] **Task 12: Projection builder + worktree write + pointer.** New `web/lib/flows/graph/run-context.ts`:
  `buildRunContext(ledger, gateResults, task)` →
  `{ intent: task.prompt, nodes:{<id>:{summary,vars}}, gates:{<id>:{status,verdict?}}, promoted:{} }`
  (hardcoded "all"; `status` from `gate_results.status` always, `verdict` when non-null). Write
  **`<worktreePath>/.maister/run.json`** via `atomicWriteJson` after each `node_attempts` terminal
  transition (success/fail/rework) + once at run start; regenerate from `reduceLedger` + gate read →
  idempotent/self-healing. **Ensure `.maister/` is git-excluded for the worktree** — idempotently
  append `.maister/` to the path from `git rev-parse --git-path info/exclude` so `run.json` never
  enters `git status`/the base→run diff. Append the `[Run context: <abs run.json path>]` one-line
  pointer to each agent node's prompt at the `runner-agent.ts:485-506` seam (shared with Task 7; both
  new-session and slash-in-existing). QA-RED: projection shape incl. gate `status` (command_check null
  verdict); idempotent regeneration; pointer present in both modes. Logging: INFO "run.json regenerated
  (<n> nodes, <m> gates)". Owns: `run-context.ts`, `runner-graph.ts`, `runner-agent.ts`, `__tests__`.
- [ ] **Task 13: Secret-safety.** Assert `run.json` draws only from `vars`+gate verdicts+intent and
  **never** from `context.env` (no env secrets leak into the file). Owns: `__tests__`.
- [ ] **Task 14: Session-independence.** A fresh/cleared/resumed session regenerates a correct
  `run.json` from the ledger with no dependency on prior in-process state. Owns: `__tests__`. Phase
  exit: full suite green + adversarial pass.
  <!-- Commit checkpoint: tasks 12-14 -->

### Phase 4 — aif demonstration + e2e. [QA-RED → impl-GREEN → review]
- [ ] **Task 15: aif structured handoff.** In `plugins/aif/flow.yaml`: declare `output.result`
  (`./schemas/*.json`) on one node (e.g. `plan`), consume `{{steps.plan.vars.<key>}}` downstream, set
  `compat.engine_min: 1.3.0`. Minimal (one field). Owns: `plugins/aif/flow.yaml`, `plugins/aif/schemas/`.
- [ ] **Task 16: Playwright e2e (happy).** Seeded authed graph run: node emits validated structured
  output, downstream consumes it, `run.json` exists with the projected vars **and** a gate verdict.
  Follow `web/e2e/*.spec.ts` seeded-DB pattern; confirm e2e project glob. Owns:
  `web/e2e/m26-structured-output.spec.ts`.
- [ ] **Task 17: Playwright e2e (negative).** A node whose output fails schema validation shows the
  `CONFIG` failure in run detail (attempt `Failed`) and the run does not promote. Owns: e2e spec.
  Phase exit: `pnpm test:e2e` (m26) green + full unit/integration green + adversarial pass.
  <!-- Commit checkpoint: tasks 15-17 -->

### Phase 5 — Docs completion checkpoint + roadmap flip.
- [ ] **Task 18: Docs checkpoint (/aif-docs).** Flip Phase-0 docs Designed → Implemented (R6);
  finalize `flow-dsl.md`, `flow-graph.md`, `configuration.md`; flip the SDD spec Status → Implemented;
  verify the contract-surface table is fully discharged (assert: no new DB column, route, status, or
  error code). One-line note in `web/CLAUDE.md` / root `CLAUDE.md` if the engine version / new field
  warrants it. Verify: `pnpm validate:docs:all` green; `/aif-verify` re-derives the spec-to-test matrix.
- [ ] **Task 19: ROADMAP + improvement-roadmap flip.** Add the **M26** entry to `.ai-factory/ROADMAP.md`
  (Completed) and update `docs/pv/improvement-roadmap.md`: mark the Wave-1 Foundations track and the
  "What already exists" P1/P7 lines as delivered (mirroring M24/M25 wording). Note Wave-1 complete →
  M20 dogfood unblocked.
  <!-- Commit checkpoint: tasks 18-19 -->

---

## Test integrity (skill-context rule, applied)
- Every new test names its runner project; integration tests in a new path family extend the vitest
  `include` glob in the **same** phase (Task 10).
- Each phase exit = **full suite green** (`pnpm test:unit && pnpm test:integration`; e2e in Phase 4)
  + a `/codex:adversarial-review` pass.
- The `hitl-validate.ts` generalization migrates its existing tests **in Phase 1** (Task 4).
- RED-before-GREEN evidence is required per TDD task (the QA-RED role proves the test fails first).

## Definition of done
- The frozen SDD spec drove implementation; `/aif-verify` confirms every acceptance criterion maps to
  a passing test (spec-to-test matrix).
- A graph node declares `output.result`; the runner validates its output (agent fenced
  `maister:output` block / cli `MAISTER_OUTPUT_FILE`) and populates `node_attempts.vars`; a downstream
  node consumes it via `{{steps.<id>.vars.<key>}}`.
- Schema mismatch / missing-required / bad-JSON / oversize → attempt `Failed` (`CONFIG`), no leaked
  ACP deferred, run does not promote.
- `run.json` exists per run with `{intent, nodes(vars+summary), gates(verdicts), promoted}`,
  regenerates idempotently from the ledger, carries no env secrets, and its path is injected into each
  agent node's prompt.
- Engine `1.3.0`; flows using `output.result` gated on `compat.engine_min >= 1.3.0`.
- Zero DB migrations; zero new routes/statuses/error-codes. `MAISTER_NODE_OUTPUT_MAX_BYTES` wired into
  `.env.example`/compose/configuration. Docs Implemented; ROADMAP M26 logged; full suite + m26 e2e green.

---

## Resolved decisions (was: open questions)
All design forks confirmed with the user on 2026-06-07:
1. ✅ Transport — **hybrid** (agent → stdout `maister:output` block; cli/check → `MAISTER_OUTPUT_FILE`).
2. ✅ cli env name — `MAISTER_OUTPUT_FILE`; per-attempt file `output-<nodeId>-<attempt>.json`.
3. ✅ P7 path — `<runDir>/run.json`, separate file from logs.
4. ✅ Size-cap — env var `MAISTER_NODE_OUTPUT_MAX_BYTES`, default 256 KiB (deployment-wired).
5. ✅ Schema grammar — reuse existing `formSchemaSchema` (no ajv); schema declared as a `./path`.
6. ✅ P7 selector — hardcode "all" now (intent + all node vars + all gate verdicts); knob later.
7. ✅ Milestone — **M26**.
8. ✅ Gate verdicts — **projected into `run.json`** alongside node vars.

## Codex adversarial review (pass 2) — dispositions
- ✅ **SDD artifact missing** → Task 1 creates `.ai-factory/specs/feature-m26-structured-output-run-context.md` as the frozen SSOT.
- ✅ **Agent execution model undefined** → `## Multiagent Execution Model` section + per-task role rotation + per-phase adversarial checkpoint.
- ↗ **`flow_graph_layouts` drop (data loss)** → out of M26 scope; tracked as a separate task (M22/ADR-062 working-tree change).
