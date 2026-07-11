# Implementation Plan: Agent Runner Parity and Package Skills Hardening

Branch: `feature/agent-runner-parity-package-skills-hardening`
Created: 2026-07-11

## Settings

- Testing: yes — SDD/TDD with explicit RED -> GREEN -> refactor checkpoints
- Logging: verbose — structured fields at resolution, materialization, cleanup, resync, and refusal boundaries
- Docs: yes — mandatory docs checkpoint

## Roadmap Linkage

Milestone: "none"
Rationale: Skipped by user; this is gap closure for the already-delivered M34 follow-up, not a new roadmap milestone.

## Outcome

Close the remaining correctness and proof gaps after commit `4745887fa` delivered the core request and was fast-forwarded into `main`:

1. Make read-only parity evidence fresh, adapter-identity-safe, mirror-checked, and wire-tested for every declared adapter.
2. Make L2 read-only materialization descriptor-driven instead of writing Claude settings for every adapter.
3. Make providing-package skill/subagent ownership and cleanup safe across every workspace and concurrent session.
4. Finish strict `capability_profile` typing through launch, resync, and Studio validation.
5. Freeze an SDD specification with requirement-to-contract-to-test traceability before implementation.
6. Mature operator/author UX for stale evidence and invalid profile states.
7. Replace the historical plan's overclaimed completion with executable gap-closure gates and an explicit behavior-preserving refactor phase.

The historical plan `.ai-factory/plans/agent-runner-parity-package-skills.md` remains unchanged as the delivery record for the merged implementation.

## Current-State Baseline

- All five adapter mirrors currently declare `readOnlyCapable`; Claude/Codex classify smoke as `not_required`, while Gemini/OpenCode/MiMo require cached read-only-session smoke.
- `resolveAgentRunner` retains `dangerously_skip_permissions` and non-Claude subagent refusals and uses the final workspace override before launch side effects.
- Supervisor L1 arbitration is adapter-generic and denies unknown permission kinds, but the wire harness is still OpenCode-specific and does not prove unknown-kind denial per adapter.
- Cached smoke stores `checkedAt`, but launch does not enforce freshness or a probe-contract version.
- L2 always writes `.claude/settings.local.json`, including non-Claude sessions.
- Standalone launch already resolves package skill roots from the pinned attached install and centralizes all four standalone trigger paths through `launchAgentRun`.
- Claude/Gemini use cwd materialization; Codex/OpenCode/MiMo use descriptor-backed generated homes. Coverage does not prove every adapter × workspace target.
- The cwd ownership manifest is a single fixed file and cleanup is reached only through the `repo_read` dirty-watchdog path.
- The definition parser is strict, bounded, deduplicating, and raises `MaisterError("CONFIG")`, but launch still accepts `Record<string, unknown>` and filter-drops values.
- Resync reports invalid definitions, but a now-invalid previously valid agent falls out of `seen` and may be disabled; the requested report-without-write behavior is not tested.
- Studio ultimately invokes the strict parser, but the profile editor accepts arbitrary JSON and current tests positively round-trip an invalid key.

## Locked Decisions

- Adapter capability and smoke evidence are keyed by stable adapter id, never by `capabilityAgent` aliases.
- Read-only launch requires descriptor support plus evidence policy. Required evidence is accepted only when status is `ok`, `probeVersion` matches the current probe contract, and `checkedAt` is within a code-owned seven-day maximum age. Diagnostics map expired, future-dated, and incompatible evidence to diagnostic-only `stale`; no new env var is introduced.
- `not_required` remains legal only with a descriptor comment and drift test naming the proof source; otherwise the adapter must use `required` and fail closed without fresh evidence.
- The supervisor L1 permission seam and L3 dirty-watchdog remain load-bearing. L2 is best effort and each adapter descriptor chooses its own materializer or explicitly chooses none.
- Providing-package skills come wholesale from every skill-bearing root in the pinned attached package manifest. Capability-record selection/disabled flags cannot omit package-owned passive skills.
- Claude package subagents are copied and ownership-recorded. Other adapters receive skills only unless their descriptor later gains an explicit native persona/subagent tract.
- Passive package skills rely on the existing attached-and-trusted package gate; `exec_trust` continues to gate executable stdio MCPs only.
- Ownership is session-scoped by `runId`. A cwd-level ownership index plus per-run records live under `.maister/agent-materialization/`, are updated under a bounded cross-process filesystem lock, and use explicit `preparing | active | releasing` states so crash recovery is deterministic. Cleanup never deletes a user-owned path or a path still leased by another live session.
- A now-invalid legacy profile is reported with source path and parse details and causes no agent-row write during that resync. The last valid row is preserved unchanged.
- The supervisor `GET /diagnostics` response changes: nested read-only evidence gains nullable `probeVersion` and diagnostic status `stale`. No new route, SSE event, web API shape, DB schema, migration, domain error code, environment variable, port, sidecar, or host mount is expected.

## Locked Non-Goals

- No ADR-041 flow-run write-tool enforcement flip.
- No `model` field in an agent definition; model remains runner-owned.
- No inline `mcp_servers`; MCPs remain catalog references.
- No `multiagent` declaration; `flow_ref` plus orchestrator covers composition.
- No freeform metadata or Anthropic import/export mapping.
- No YAML agent container, converter tooling, or package import/export workflow.
- No per-agent skill selection field or selection UI.
- No cross-package skill additions; `capability_profile` may only note this as a future extension.
- No change to flow-driven or flow-node-bound skill behavior.
- No M-gamma continuous daemons and no Managed-Agents-as-runner option.

## Numbering and Integration Preflight

- Latest accepted decision at local `main` is ADR-128. ADR-129 is the next free candidate, but is not treated as accepted until Task 0.1 writes its header before any citation.
- No migration number is reserved.
- Migration-free is a frozen design constraint for this slice: `runs.agent_workspace` already snapshots the effective workspace, package provenance is resolved from the pinned attachment, and materialization ownership is a durable filesystem artifact. If implementation discovers that a stable repo-read commit must be persisted, stop and re-plan the DB contract instead of smuggling in a column.
- The old Tact-3/ADR-121 and auto-promotion/ADR-126 overlap warnings are obsolete because those changes are already on `main`.
- Before implementation, rebase this branch onto local `main`, re-check ADR numbering at `main` HEAD, and review overlaps in `web/lib/agents/launch.ts`, `web/lib/acp-runners/*`, and both adapter registries.
- Integration remains rebase + owner fast-forward, no merge commit, no AI trailer.

## Contract Surface Matrix

| Surface | Code owners | Contract owners | Planned result |
| --- | --- | --- | --- |
| Adapter read-only capability and evidence | `web/lib/acp-runners/adapter-support.ts`, `web/lib/acp-runners/resolve.ts`, `web/lib/agents/launch.ts`, `supervisor/src/adapter-registry.ts`, `supervisor/src/adapter-smoke-cache.ts` | `docs/system-analytics/acp-runners.md`, `docs/supervisor.md`, `docs/api/supervisor.openapi.yaml` | Stable adapter-id lookup, cache v2 compatibility, `probeVersion`, diagnostic `stale`, freshness policy, mirror drift guard. |
| L1/L2/L3 enforcement | `supervisor/src/acp-client.ts`, `supervisor/src/__tests__/adapter-compatibility.integration.test.ts`, `web/lib/agents/dirty-watchdog.ts` | `docs/system-analytics/acp-runners.md`, `docs/system-analytics/agents.md` | Per-adapter wire proof, descriptor-owned L2, unchanged L1/L3 boundary. |
| Package capability materialization | `web/lib/agents/effective.ts`, `web/lib/agents/launch.ts`, `web/lib/capabilities/adapter-home.ts` | `docs/system-analytics/agents.md`, `docs/system-analytics/capabilities.md`, `docs/flow-dsl.md` | Pinned-manifest wholesale skills, Claude subagents, all five adapters and all three workspaces through layered coverage. |
| Ownership and cleanup | `web/lib/agents/materialization-manifest.ts`, `web/lib/agents/dirty-watchdog.ts`, `web/lib/gc/ephemeral-agent-gc.ts`, terminal paths in `web/lib/agents/launch.ts` | `docs/system-analytics/agents.md`, `docs/system-analytics/workspaces.md` | Run-scoped leases, all terminal paths, concurrency-safe deletion. |
| Typed agent profile | `web/lib/agents/definition.ts`, `web/lib/agents/launch.ts`, `web/lib/agents/registry.ts`, Studio artifact editor/validator | `docs/flow-dsl.md`, `docs/system-analytics/agents.md`, `docs/screens/studio/editor.md` | One canonical schema/type through parse, resync, launch, and Studio. |
| Operator and author UX | `web/components/settings/adapter-support-panel.tsx`, Studio frontmatter editor/validation summary, EN/RU messages | `docs/screens/settings-acp-runners.md`, `docs/screens/projects/project-settings-agents.md`, `docs/screens/studio/editor.md` | Actionable missing/stale/incompatible evidence states and strict profile errors without explanatory clutter. |
| Supervisor HTTP diagnostics | `supervisor/src/types.ts`, diagnostics route, `web/lib/supervisor-client.ts` | `docs/api/supervisor.openapi.yaml`, `docs/supervisor.md` | Existing route, changed nested response schema; route and client contract tests required. |
| Web HTTP / SSE | Existing web routes and event schemas | `docs/api/web.openapi.yaml`, `docs/api/async/supervisor-sse.asyncapi.yaml`, `docs/api/async/web-runs.asyncapi.yaml` | Explicitly audited and unchanged. |
| DB / deployment | `web/lib/db/schema.ts`, migration lineage, compose, Docker, env example | `docs/database-schema.md`, `docs/db/agents-domain.md`, `docs/db/runs-domain.md`, deployment docs | Explicit migration-free/deployment-neutral proof; stop and re-plan if this changes. |

## SDD Requirements and Traceability

The implementation spec created in Task 0.1 is the normative source. It uses these stable requirement ids and carries them into tests and acceptance evidence:

| Requirement | Expectation | Primary tasks | Contract / screen evidence |
| --- | --- | --- | --- |
| `A1` | Read-only compatibility is keyed by adapter id and both registry mirrors agree. | 1.1, 2.1 | ACP runner analytics + ADR-129. |
| `A2` | Required smoke is wire-proven, fresh, probe-compatible, and fail-closed before launch side effects. | 1.1, 2.1, 2.2 | Supervisor OpenAPI/prose + Settings screen. |
| `A3` | L1 denies write/unknown kinds inline; L2 is descriptor-owned; L3 catches real repo dirt. | 1.1, 2.2, 2.3 | ACP runner + agent analytics. |
| `A4` | Dangerous permission policy and non-Claude subagent refusals remain unchanged. | 1.1, 2.1 | Agent analytics refusal table. |
| `A5` | OpenCode native persona is implemented only if a bounded file-only tract is proven; otherwise the explicit no-tract outcome is documented. | 2.3 | ACP runner analytics/screens. |
| `B1` | All passive skills come from every root in the pinned attached providing package; catalog selection cannot omit them. | 1.2, 3.1 | Agents/capabilities analytics + Flow DSL. |
| `B2` | Claude receives skills plus package subagents; other adapters receive descriptor-supported skills only. | 1.2, 3.1 | Capabilities analytics. |
| `B3` | Ownership is run-scoped, path-confined, concurrent-safe, crash-recoverable, and never deletes user content. | 1.2, 3.2, 3.3 | Agents/workspaces analytics. |
| `B4` | Manual, cron, domain-event, and webhook entry points converge on the same standalone launcher; all workspace modes reach the correct materialization target. | 1.2, 3.3 | Agents analytics + project-agents screen. |
| `B5` | Attached-package trust permits passive skills; stdio MCP exec trust remains unchanged. | 1.2, 3.1 | Agents/capabilities analytics. |
| `C1` | `capability_profile` is exactly strict `{ mcps?: string[] }` with one canonical id schema, stable dedup, and bounds. | 1.3, 4.1 | Flow DSL + Studio screen. |
| `C2` | Invalid new/legacy definitions are reported with source context and never written; genuinely missing definitions retain disable semantics. | 1.3, 4.2 | Agents analytics. |
| `C3` | Studio surfaces field errors and blocks artifact commit/cut/publish for invalid profiles. | 1.3, 4.3 | Studio screen. |
| `Q1` | Every behavior change follows RED -> GREEN -> refactor with runnable, non-trivial, minimally overlapping tests. | 0.3, 1.1-1.3, 5.1-5.2 | Spec traceability + verification evidence. |
| `Q2` | Implementation follows strict typing, SOLID, KISS, DRY, project boundaries, structured logging, and `MaisterError` domain failures. | 2.1-5.2 | Architecture/rules + final review. |

## Commit Plan

- **Commit 1** (Tasks 0.1-0.3): `docs: freeze agent parity hardening specification`
- **Commit 2** (Tasks 1.1-2.4): `fix(runners): harden read-only adapter evidence`
- **Commit 3** (Tasks 1.2, 3.1-3.3): `fix(agents): make package materialization lifecycle-safe`
- **Commit 4** (Tasks 1.3, 4.1-4.3): `fix(agents): complete strict capability profile handling`
- **Commit 5** (Tasks 5.1-6.2): `chore(agents): refactor and verify hardening contracts`

## Tasks

### Phase 0: SDD and Contract Freeze

#### Task 0.1 - Create and freeze the SDD specification

- [x] Status: complete

Files:

- `.ai-factory/specs/feature-agent-runner-parity-package-skills-hardening.md`
- `docs/decisions.md`
- `.ai-factory/plans/feature-agent-runner-parity-package-skills-hardening.md`

Deliverables:

- Create the normative spec with status `Designed`, value, scope/non-goals, requirement ids `A1-A5`, `B1-B5`, `C1-C3`, `Q1-Q2`, domain invariants, refusal/precondition tables, failure modes, UI states, and acceptance criteria.
- Copy the traceability table from this plan into the spec and give every requirement at least one test owner and one contract/docs owner.
- Re-read ADR numbers from `main` HEAD; write the next free ADR header before citing it anywhere. Use ADR-129 only if still free.
- Record evidence/cache compatibility, stable adapter identity, L1/L2/L3 boundaries, pinned package ownership, materialization lifecycle, report-only resync, and migration-free reasoning.
- Mark implementation details `Designed`; do not claim `Implemented` until Task 6.1.

Logging requirements:

- This docs-first task adds no runtime logs; the spec must define the structured fields later tasks emit: `adapterId`, `runnerId`, `evidenceStatus`, `checkedAt`, `probeVersion`, `runId`, `workspace`, `ownershipState`, `ownedPathCount`, `agentId`, and `sourcePath`.

Acceptance:

- Every attached requirement and discovered gap maps to a stable requirement id.
- The spec contains no contradictory state/refusal/cleanup claims.
- ADR anchors pass `node scripts/validate-docs-adr-anchors.mjs`.

Dependencies: none.

#### Task 0.2 - Freeze API, DB, analytics, and screen contracts

- [x] Status: complete

Files:

- `docs/api/supervisor.openapi.yaml`
- `docs/supervisor.md`
- `supervisor/src/types.ts` and `web/lib/supervisor-client.ts` as schema references only in this phase
- `docs/system-analytics/acp-runners.md`
- `docs/system-analytics/agents.md`
- `docs/system-analytics/capabilities.md`
- `docs/system-analytics/workspaces.md`
- `docs/screens/settings-acp-runners.md`
- `docs/screens/projects/project-settings-agents.md`
- `docs/screens/studio/editor.md`
- `docs/api/web.openapi.yaml`, both run/supervisor AsyncAPI files, `docs/database-schema.md`, `docs/db/agents-domain.md`, and `docs/db/runs-domain.md` for explicit unchanged-surface audit

Deliverables:

- Specify the existing `GET /diagnostics` route's changed nested response: cache v2 compatibility, nullable `probeVersion`, diagnostic-only `stale`, exact seven-day/future-date/version semantics, and examples.
- Freeze analytics with Purpose, Domain entities, State machine where applicable, Process flows, Expectations, Edge cases, and Linked artifacts; enumerate exact allow-list refusals and cleanup/recovery transitions.
- Freeze Settings evidence states, project-agent launch refusal UX, Studio inline/blocking validation, and EN/RU concepts in screen artifacts.
- Record why Web OpenAPI, AsyncAPI, DB schema/ERDs, migrations, deployment, env, and error taxonomy are unchanged.
- If any audit disproves the migration-free or unchanged-surface assumption, stop and amend the spec/plan before RED tests.

Logging requirements:

- No runtime logs; each expectation must name the observable structured fields or user-visible state that proves it.

Acceptance:

- Supervisor OpenAPI, prose, analytics, screens, and the SDD spec agree exactly.
- Unchanged-surface audits are recorded as decisions, not implicit omissions.
- No migration SQL, journal entry, or snapshot is planned.

Dependencies: Task 0.1.

#### Task 0.3 - Run the pre-code completeness and test-design gate

- [x] Status: complete

Files:

- `.ai-factory/specs/feature-agent-runner-parity-package-skills-hardening.md`
- This plan
- `web/vitest.workspace.ts`
- `supervisor/vitest.workspace.ts`
- Existing test files named in later tasks

Deliverables:

- Check fullness/completeness, consistency, logical-hole absence, dependency ordering, contract traceability, and acceptance-criteria measurability before code.
- Enumerate crash windows for ownership `preparing -> active -> releasing`, cache v1->v2 handling, partial smoke writes, cleanup retry, and invalid resync.
- Map every requirement to focused tests using layered coverage: all adapters at descriptor/wire boundaries; all workspace modes at central launch/materialization; each trigger at the shared-launch seam; one end-to-end materialization proof.
- Use `vitest list` for each new/changed path family and update runner includes only if a promised test would otherwise not execute.
- Record expected RED reasons before implementation; do not commit a deliberately red checkpoint.
- Reject trivial tests that merely restate static constants when public behavior or a schema boundary can be exercised.

Logging requirements:

- No new production logging in this task; tests must assert structured refusal/cleanup context without snapshotting unstable prose.

Acceptance:

- Every promised test is discoverable by its named Vitest project.
- Every requirement has a non-duplicative proof target or an explicit non-code verification target.
- No GREEN implementation task starts until this gate is checked.

Dependencies: Task 0.2.

### Phase 1: RED Tests

#### Task 1.1 - Add runner evidence, identity, and wire-parity RED tests

- [x] Status: complete

Files:

- `web/lib/acp-runners/__tests__/adapter-support.test.ts`
- `web/lib/acp-runners/__tests__/resolve-agent.test.ts`
- `web/lib/acp-runners/__tests__/readiness.test.ts`
- `web/lib/agents/__tests__/agent-execution-policy.integration.test.ts`
- `supervisor/src/__tests__/adapter-registry.test.ts`
- `supervisor/src/__tests__/adapter-smoke-cache.test.ts`
- `supervisor/src/__tests__/adapter-compatibility.integration.test.ts`
- `supervisor/test/fixtures/mock-acp-compatibility.mjs`
- `web/components/settings/__tests__/adapter-support-panel.test.ts`

Cases:

- Both registry mirrors normalize to the same adapter-id capability/evidence matrix.
- Alias changes in `capabilityAgent` cannot select another adapter's evidence.
- Cache v1 preserves generic smoke but treats read-only evidence as stale until re-probed; cache v2 required evidence refuses missing, non-ok, future-dated, exactly/older-than-seven-days, and wrong/missing-probe-version entries.
- Each declared capable adapter completes read allow, write deny, and unknown deny through the real mock ACP wire, leaks no permission event, and leaves no pending permission.
- `dangerously_skip_permissions` and non-Claude subagent refusals remain intact.
- Diagnostics route and web client schemas accept the new nested fields/status and reject undocumented shapes.
- Settings diagnostics UI distinguishes missing, stale, wrong-version, error, ok, and not-required evidence.

Logging requirements:

- Assert refusal logs include `adapterId`, `workspace`, evidence status/freshness reason, and runner id; unknown-kind supervisor logs include `sessionId`, `toolCallId`, and `permissionKind`.

Acceptance:

- Tests initially fail only at the missing freshness/identity/matrix behavior.
- Web unit/integration and supervisor unit/integration projects execute the files.

Dependencies: Task 0.3.

#### Task 1.2 - Add materialization lifecycle RED tests

- [x] Status: complete

Files:

- `web/lib/capabilities/__tests__/adapter-home.test.ts`
- `web/lib/agents/__tests__/agent-execution-policy.integration.test.ts`
- `web/lib/agents/__tests__/dirty-watchdog.test.ts`
- Manual/webhook route tests and trigger integration tests that own the four standalone entry paths

Cases:

- All skills from every pinned manifest capability root materialize even if a corresponding capability record is disabled/non-selectable; other-package/newest-install skills do not.
- Claude copies and ownership-records skills plus package subagents; other adapters copy only skills.
- Descriptor tests cover every adapter; central launch integration covers `none`, `repo_read`, and `worktree` without repeating the full adapter Cartesian product.
- Manual, cron, domain-event, and webhook tests prove normalized convergence on `launchAgentRun`; one central integration proves materialization.
- Two concurrent runs sharing a cwd cannot delete each other's owned paths; all workspace modes clean up on success/failure; user-owned collisions survive.
- Ownership rejects absolute/traversal/empty/out-of-root paths, symlink escapes, duplicate/corrupt records, and stale locks.
- Crash-window tests cover intent-before-copy, copy-before-active, releasing-before-delete, delete-before-index-update, and idempotent recovery.

Logging requirements:

- Assert structured events at inventory resolution, copy/lease, release/cleanup, and dirty-watchdog boundaries; never log skill file contents or MCP secrets.

Acceptance:

- Tests fail only for the identified current gaps.
- The real-PG launch/trigger suites are runnable in the integration project.

Dependencies: Task 0.3.

#### Task 1.3 - Add strict-profile, resync, and UI RED tests

- [x] Status: complete

Files:

- `web/lib/agents/__tests__/definition.test.ts`
- `web/lib/agents/__tests__/registry.integration.test.ts`
- `web/components/flows/__tests__/frontmatter-artifact-editor.test.ts`
- `web/lib/flows/__tests__/artifact-validate.test.ts`
- Existing commit/cut/publish gate tests

Cases:

- Launch accepts only typed `AgentCapabilityProfile`; no invalid value is filter-dropped.
- Invalid-new, invalid-existing, and genuinely-missing resync cases have distinct report/write behavior.
- Studio reports unknown keys, unsafe ids, wrong types, count overflow, and blocks commit/cut/publish while valid round trips stay stable.
- EN/RU messages cover new states without raw technical dumps or duplicated explanatory prose.

Logging requirements:

- Assert server logs carry bounded issue codes/paths and provenance, never profile contents or secrets; client components add no console logging.

Acceptance:

- RED failures correspond only to missing strict boundary/UI/resync behavior.
- Component, unit, and real-PG integration files are discovered by their intended projects.

Dependencies: Task 0.3.

### Phase 2: Runner-Agnostic Read-Only Hardening

#### Task 2.1 - Key capability and evidence by stable adapter id

- [x] Status: complete

Files:

- `web/lib/acp-runners/adapter-support.ts`
- `web/lib/acp-runners/catalog.ts`
- `web/lib/acp-runners/resolve.ts`
- `web/lib/agents/launch.ts`
- `supervisor/src/adapter-registry.ts`
- `supervisor/src/adapter-smoke-cache.ts`
- `supervisor/src/types.ts`
- `web/lib/supervisor-client.ts`
- Supervisor diagnostics route tests and `web/lib/__tests__/supervisor-client.test.ts`

Deliverables:

- Remove evidence lookup through `capabilityAgent`; use the resolved adapter id end to end.
- Advance the smoke cache to v2. Read v1 generic evidence for ordinary readiness, but expose v1 read-only evidence as `stale` until the supported producer rewrites it.
- Add `probeVersion`, derive diagnostic `stale` for expired/future/incompatible evidence, and enforce the exact seven-day boundary before launch.
- Keep generic ACP startup smoke advisory for ordinary readiness; apply the stricter evidence gate only to read-only standalone workspaces.
- Add a cross-mirror drift guard without introducing a broad shared runtime abstraction.
- Update supervisor response Zod, diagnostics route payload, web-client Zod/types, and contract tests in one change.

Logging requirements:

- DEBUG resolution with `runnerId`, `adapterId`, `workspace`, and evidence metadata; INFO on accepted read-only launch; WARN on expected fail-closed refusal; ERROR only for malformed diagnostics/contracts.

Acceptance:

- Task 1.1 identity/freshness tests pass.
- Refusal occurs before checkout/worktree creation, run insertion, or token issuance.
- Diagnostics payload matches the Phase-0 OpenAPI contract exactly.

Dependencies: Task 1.1.

#### Task 2.2 - Parameterize ACP wire parity over the descriptor matrix

- [x] Status: complete

Files:

- `supervisor/src/__tests__/adapter-compatibility.integration.test.ts`
- `supervisor/test/fixtures/mock-acp-compatibility.mjs`
- `supervisor/scripts/smoke-acp-adapter.ts`
- `supervisor/src/acp-client.ts` only if the wire tests expose a real defect

Deliverables:

- Generate test cases from the declared descriptor matrix instead of a hard-coded OpenCode case.
- Drive `read`, `edit`, and unknown permission kinds through the wire for every capable adapter.
- Preserve deny-by-default arbitration and prove no permission-request leakage/pending deferred.
- Ensure live smoke writes versioned evidence only after all three probes pass.
- Invalidate the targeted read-only evidence atomically before probing; only a complete read/write/unknown observation set may replace it with `ok`. A crash or partial probe therefore stays fail-closed instead of reusing an older `ok`.

Logging requirements:

- Structured per-probe DEBUG fields: `adapterId`, `permissionKind`, `decision`, `sessionId`; WARN for incomplete probes; never write `ok` evidence after a partial run.

Acceptance:

- Supervisor unit and integration suites are green.
- An adapter without complete evidence remains refused.

Dependencies: Tasks 1.1 and 2.1.

#### Task 2.3 - Make L2 materialization adapter-descriptor-owned

- [x] Status: complete

Files:

- `web/lib/acp-runners/adapter-support.ts`
- `web/lib/agents/dirty-watchdog.ts`
- `web/lib/agents/launch.ts`
- `web/lib/capabilities/adapter-home.ts`
- `docs/system-analytics/acp-runners.md`

Deliverables:

- Replace unconditional `.claude/settings.local.json` writes with a single-purpose materializer selected by adapter descriptor.
- Preserve Claude settings behavior; explicitly classify other adapters as native materializer or none.
- Timebox OpenCode native persona investigation. Implement only if it is a file-only descriptor addition with proven runtime semantics; otherwise document the explicit no-native-persona result.
- Do not weaken L1 or L3 when L2 is absent.

Logging requirements:

- INFO when an L2 tract materializes; DEBUG when descriptor intentionally selects none; WARN when a user-owned file prevents best-effort materialization. Include `adapterId`, `runId`, `cwd`, and materializer kind.

Acceptance:

- Non-Claude sessions no longer receive Claude settings.
- User-owned adapter files remain untouched.
- Full Phase 2 web/supervisor unit and integration suites are green.

Dependencies: Tasks 1.1 and 2.1. May run in parallel with Task 2.2 after Task 2.1.

#### Task 2.4 - Mature Settings evidence and launch-refusal UX

- [x] Status: complete

Files:

- `web/components/settings/adapter-support-panel.tsx`
- `web/components/settings/__tests__/adapter-support-panel.test.ts`
- Project-agent launch error surface only if the current typed error is not already rendered intact
- `web/messages/en.json`
- `web/messages/ru.json`
- `docs/screens/settings-acp-runners.md`
- `docs/screens/projects/project-settings-agents.md`

Deliverables:

- Render Ready separately from read-only eligibility.
- Distinguish `not_required`, missing/pending, stale-by-age, stale-by-probe-version, explicit error, and ok evidence.
- Show `checkedAt` when present and one actionable remediation: run the supported `--read-only-session` smoke for evidence-required adapters.
- Keep details compact and accessible; do not expose cache paths, credentials, or verbose protocol dumps.
- Preserve the server's typed `EXECUTOR_UNAVAILABLE` context in agent launch UI without creating a partial run row.

Logging requirements:

- No client console logging. Existing server refusal logs remain structured with `runnerId`, `adapterId`, `workspace`, and evidence reason code.

Acceptance:

- Component tests cover every distinct evidence state and accessible text.
- EN/RU key parity passes.
- Screen artifacts match the delivered UI concepts.

Dependencies: Tasks 1.1 and 2.1.

### Phase 3: Providing-Package Skills and Cleanup

#### Task 3.1 - Make pinned-manifest wholesale inventory the only skill source

- [ ] Status: pending

Files:

- `web/lib/agents/effective.ts`
- `web/lib/agents/launch.ts`
- `web/lib/packages/attach.ts`
- Optional single-purpose helper: `web/lib/agents/package-capabilities.ts`

Deliverables:

- Preserve the current pinned attachment/install contour and enumerate every manifest capability member root.
- Remove or reject any selection/non-disabled capability-record filter that could omit passive package skills.
- Validate capability records only for provenance/completeness when needed; never use them as the selection source.
- Fail fast with `MaisterError("CONFIG")` on a missing recorded root/file and include package/agent provenance.
- Keep `exec_trust` gating only for executable stdio MCPs.

Logging requirements:

- DEBUG inventory fields: `runId`, `agentId`, `projectId`, `packageInstallId`, `installedPath`, `skillRoots`, `skillCount`, `subagentCount`, `adapterId`, `workspace`; do not log file contents.

Acceptance:

- Pinned/newest divergence, disabled-record, multiple-root, missing-file, and trust-boundary tests pass.
- Flow-driven and flow-node-bound behavior is unchanged.

Dependencies: Task 1.2.

#### Task 3.2 - Introduce run-scoped ownership and concurrency-safe leases

- [ ] Status: pending

Files:

- `web/lib/agents/materialization-manifest.ts`
- `web/lib/capabilities/adapter-home.ts`
- `web/lib/agents/dirty-watchdog.ts`
- `web/lib/atomic.ts` for atomic writes; add a single-purpose agent-materialization lock helper only because no reusable cross-process filesystem lock exists

Deliverables:

- Replace the singleton manifest with a cwd-level ownership index and per-run records under `.maister/agent-materialization/`.
- Record both Claude skills and Claude subagents; record only paths actually created/replaced by MAIster.
- Track shared-path leases so one run cannot delete a path another live run still uses.
- Use an atomic `mkdir`-claim lock with an owner token, bounded wait, short stale threshold, compare-before-release, and structured stale-takeover evidence. Do not reuse the process-only registration lock or DB-specific local-package lock.
- Model each run record as `preparing -> active -> releasing`; write intent before copy/delete and make recovery idempotently finish or roll back each reachable partial state.
- Update the index and run record with `atomicWriteJson`; enumerate and test every crash window between intent, copy/delete, and final index state.
- Treat manifests as untrusted input: allow only normalized relative paths under descriptor-approved roots, reject empty/absolute/`.`/`..`/duplicate paths, prevent symlink escape, and never recursively delete through an unverified link.
- Corrupted ownership state fails loudly and preserves files for manual/retry recovery; it never guesses ownership.
- Never claim or delete skipped user-owned collisions.

Logging requirements:

- DEBUG lock/lease/state transitions with `runId`, `cwd`, `ownershipState`, `pathCount`, and `leaseCount`; INFO final cleanup summary; WARN on stale-lock takeover or preserved user collision; ERROR on corrupt ownership or failed atomic update.

Acceptance:

- Concurrent same-cwd tests pass under both finalization orders.
- The historical contradiction is removed: Claude subagents are copied and ownership-recorded.
- Crash recovery and path/symlink confinement tests pass without deleting user content.

Dependencies: Tasks 1.2 and 3.1.

#### Task 3.3 - Close terminal cleanup and trigger/workspace parity

- [ ] Status: pending

Files:

- `web/lib/agents/launch.ts`
- `web/lib/agents/dirty-watchdog.ts`
- `web/lib/gc/ephemeral-agent-gc.ts`
- Manual/webhook routes and `web/lib/agents/triggers.ts` tests

Deliverables:

- Run cleanup from one terminal/failure finalizer for `worktree`, `repo_read`, and `none` sessions.
- Restore/filter MAIster-owned repo-read paths before L3 porcelain attribution.
- Delete generated homes/run dirs only after the last lease and make success, failure, `Crashed`, resume retry, and GC recovery idempotent.
- Prove manual, cron, domain-event, and webhook entry paths normalize into the same `launchAgentRun` contract; run materialization once through the central launcher rather than duplicating it four times.
- Cover every workspace mode at the central launch/finalize seam and every adapter at the descriptor/materializer seam; do not build a redundant full Cartesian suite.
- Keep flow binding and shared-orchestrator workspace behavior unchanged and protected by existing regression tests.
- Define cleanup failure behavior: structured ERROR, preserved ownership evidence, and retry/GC eligibility; repo-read dirt still quarantines atomically. Never report silent success.

Logging requirements:

- INFO terminal cleanup with `runId`, `agentId`, `workspace`, `restoredPathCount`, `remainingLeaseCount`, `dirtyAfterRestore`; ERROR includes failed path and recovery action.

Acceptance:

- Layered adapter, workspace, and trigger coverage proves the full contract with minimum overlap.
- Clean MAIster-only repo-read changes do not quarantine; real agent dirt still does.
- Full Phase 3 web unit and real-PG integration suites are green.

Dependencies: Tasks 1.2 and 3.2.

### Phase 4: Strict Capability Profile End to End

#### Task 4.1 - Reuse one canonical MCP-ref schema and typed launch input

- [ ] Status: pending

Files:

- `web/lib/config.schema.ts`
- `web/lib/agents/definition.ts`
- `web/lib/agents/launch.ts`
- `web/lib/capabilities/agent-map.ts` if its input remains untyped

Deliverables:

- Reuse/export the canonical `capabilityRefIdSchema`; remove the duplicate local regex schema.
- Make `resolveAgentProfileMcpServers` accept `AgentCapabilityProfile | undefined`, not `Record<string, unknown>`.
- Remove launch-time filter-dropping; invalid values are impossible past registration and must fail fast if an internal caller violates the type boundary.
- Preserve stable dedup/order, maximum 32 refs, and stdio MCP exec-trust gating.

Logging requirements:

- DEBUG resolved MCP ids/count plus agent/package ids; WARN for trust-gated MCP omissions; ERROR for an impossible internal typed-contract violation. Never log MCP secrets or env values.

Acceptance:

- No `Record<string, unknown>` capability-profile leak remains.
- Definition and MCP-gate tests pass.

Dependencies: Task 1.3.

#### Task 4.2 - Make invalid legacy resync report-only

- [ ] Status: pending

Files:

- `web/lib/agents/registry.ts`
- Admin resync route/action if needed for existing diagnostics
- `web/lib/agents/__tests__/registry.integration.test.ts`

Deliverables:

- Include `sourcePath`, qualified id, and strict issue details in invalid diagnostics.
- Distinguish invalid-new, invalid-existing, and truly missing ids before applying the missing-row cleanup.
- Mark invalid-existing ids as protected-from-missing cleanup for that resync.
- Do not insert, update, disable, or delete the last valid row for a now-invalid profile; assert unchanged timestamps and payload, not only row presence.
- Keep truly missing package agents on the existing disable path.

Logging requirements:

- WARN invalid resync item with `agentId`, `packageInstallId`, `sourcePath`, and issue paths; INFO summary counts for registered/invalid/missing; no frontmatter body logging.

Acceptance:

- Real-PG tests distinguish invalid-existing, invalid-new, and truly-missing cases and assert exact DB non-mutation.

Dependencies: Tasks 1.3 and 4.1.

#### Task 4.3 - Make Studio validation strict at the field and artifact gates

- [ ] Status: pending

Files:

- `web/components/flows/artifact-editors/frontmatter-artifact-editor.tsx`
- `web/components/flows/__tests__/frontmatter-artifact-editor.test.ts`
- `web/lib/flows/artifact-validate.ts`
- `web/lib/flows/__tests__/artifact-validate.test.ts`
- Commit/cut/publish gate tests that already own artifact blocking

Deliverables:

- Validate profile JSON against the shared strict schema before committing editor state.
- Show source-specific field errors for unknown keys, invalid ids, count overflow, and wrong types.
- Prove artifact validation produces a blocking issue and commit/cut/publish cannot proceed.
- Preserve parse/render round trips for valid profiles and EN/RU parity for any new copy.
- Keep the existing compact structural editor; do not add a new per-agent package-skill selector or redesign the Studio information architecture.

Logging requirements:

- Client validation adds no console logging. Server-side blocking logs use `packageId`, `artifactPath`, and issue codes without artifact contents.

Acceptance:

- The current invalid `{mcp: [...]}` positive test is replaced by a rejection assertion.
- Phase 4 unit, real-PG integration, and relevant Studio tests are green.

Dependencies: Tasks 1.3 and 4.1. May run in parallel with Task 4.2 after Task 4.1.

### Phase 5: GREEN Refactor and Consistency

#### Task 5.1 - Refactor evidence and adapter boundaries without behavior change

- [ ] Status: pending

Files:

- Files changed in Phase 2
- Tests from Tasks 1.1 and 2.1-2.4

Deliverables:

- Keep evidence evaluation as one pure, strictly typed function used by diagnostics, launch gating, and UI derivation; remove duplicated age/version/status branching.
- Keep adapter lookup and L2 materializer selection single-purpose and keyed by adapter id.
- Preserve separate web/supervisor registry ownership; do not introduce forbidden cross-process imports to make DRY superficial.
- Remove dead compatibility shims only when cache v1 behavior remains covered.

Logging requirements:

- Do not add duplicate logs during refactor; keep one structured event per resolution/refusal boundary and preserve redaction.

Acceptance:

- No behavior/contract snapshot changes from the GREEN state.
- Focused tests plus full web/supervisor unit and integration suites remain green after refactor.
- SOLID, KISS, DRY, strict typing, pure-helper, and project dependency rules pass review.

Dependencies: Tasks 2.1-2.4.

#### Task 5.2 - Refactor materialization and profile boundaries without behavior change

- [ ] Status: pending

Files:

- Files changed in Phases 3 and 4
- Tests from Tasks 1.2-1.3 and 3.1-4.3

Deliverables:

- Separate inventory resolution, path validation, ownership state transitions, copy/delete effects, and recovery classification into single-purpose functions.
- Reuse the canonical profile/ref schemas from definition through Studio and launch; remove duplicated parsing/filtering.
- Keep ownership state immutable at helper boundaries; functions return next state instead of mutating shared input objects.
- Remove redundant test setup while preserving distinct behavioral axes and exact failure assertions.

Logging requirements:

- Preserve one structured event per ownership transition/resync result; do not log manifests, profile bodies, prompts, or secrets.

Acceptance:

- No behavior/contract changes from the GREEN state.
- Full relevant web unit, real-PG integration, and component suites remain green after refactor.
- No new `any`, flag-driven multi-mode function, adjacent refactor, or duplicated schema remains.

Dependencies: Tasks 3.1-4.3. May run in parallel with Task 5.1.

### Phase 6: As-Built Docs and Verification

#### Task 6.1 - Synchronize docs and audit unchanged contracts

- [ ] Status: pending

Files:

- `docs/system-analytics/acp-runners.md`
- `docs/system-analytics/agents.md`
- `docs/system-analytics/capabilities.md`
- `docs/system-analytics/workspaces.md`
- `docs/flow-dsl.md`
- `docs/screens/settings-acp-runners.md`
- `docs/screens/projects/project-settings-agents.md`
- `docs/screens/studio/editor.md`
- `docs/supervisor.md`
- `.ai-factory/specs/feature-agent-runner-parity-package-skills-hardening.md`
- `docs/api/web.openapi.yaml`
- `docs/api/supervisor.openapi.yaml`
- `docs/api/async/supervisor-sse.asyncapi.yaml`
- `docs/api/async/web-runs.asyncapi.yaml`
- `docs/database-schema.md`, `docs/db/agents-domain.md`, and `docs/db/runs-domain.md` audit-only

Deliverables:

- Convert Designed wording from Phase 0 to Implemented only after matching tests pass.
- Remove stale Claude-only, singleton-manifest, and arbitrary-profile claims.
- Update Supervisor OpenAPI/prose examples for cache v2, `probeVersion`, and `stale`; audit Web OpenAPI/AsyncAPI/DB/deployment surfaces and leave them unchanged unless implementation introduced a real contract change.
- Close every SDD traceability row with the exact test command/result and as-built artifact.
- If a new env/config/sidecar/port unexpectedly appears, stop and add the required Docker/compose/`.env.example` deployment task before continuing.

Logging requirements:

- No runtime logs; docs must name the structured operator evidence emitted by Tasks 2-4.

Acceptance:

- `CI=true pnpm validate:docs` and `CI=true pnpm validate:contracts` pass.
- ADR anchor validation passes.
- No migration/deployment drift is unaccounted for.
- SDD, analytics, API, screens, code, and tests contain no unresolved contradiction or Designed-as-Implemented drift.

Dependencies: Tasks 5.1 and 5.2.

#### Task 6.2 - Run focused, full, live-smoke, and adversarial gates

- [ ] Status: pending

Commands:

```bash
pnpm --filter maister-web exec vitest list --project unit
pnpm --filter maister-web exec vitest list --project integration
pnpm --filter @maister/supervisor exec vitest list --project unit
pnpm --filter @maister/supervisor exec vitest list --project integration
pnpm --filter maister-web exec vitest run --project unit lib/acp-runners/__tests__/adapter-support.test.ts lib/acp-runners/__tests__/resolve-agent.test.ts lib/acp-runners/__tests__/readiness.test.ts lib/__tests__/supervisor-client.test.ts lib/agents/__tests__/definition.test.ts lib/agents/__tests__/dirty-watchdog.test.ts lib/flows/__tests__/artifact-validate.test.ts components/settings/__tests__/adapter-support-panel.test.ts components/flows/__tests__/frontmatter-artifact-editor.test.ts
pnpm --filter maister-web exec vitest run --project integration lib/agents/__tests__/agent-execution-policy.integration.test.ts lib/agents/__tests__/dirty-watchdog.integration.test.ts lib/agents/__tests__/registry.integration.test.ts lib/agents/__tests__/triggers.integration.test.ts
pnpm --filter @maister/supervisor exec vitest run --project unit src/__tests__/adapter-registry.test.ts src/__tests__/adapter-smoke-cache.test.ts src/__tests__/smoke-acp-adapter-script.test.ts
pnpm --filter @maister/supervisor exec vitest run --project integration src/__tests__/adapter-compatibility.integration.test.ts
pnpm --filter maister-web typecheck
pnpm --filter maister-web test:unit
pnpm --filter maister-web test:integration
pnpm --filter @maister/supervisor typecheck
pnpm --filter @maister/supervisor test:unit
pnpm --filter @maister/supervisor test:integration
pnpm --filter @maister/mcp typecheck
pnpm --filter @maister/mcp test
CI=true pnpm validate:docs
CI=true pnpm validate:contracts
pnpm validate:docs:adr
pnpm --filter maister-web exec eslint .
pnpm --filter @maister/supervisor exec eslint .
pnpm --filter @maister/mcp exec eslint .
```

Live smoke where binaries and credentials exist:

```bash
pnpm --filter @maister/supervisor smoke:acp -- --read-only-session claude
pnpm --filter @maister/supervisor smoke:acp -- --read-only-session codex
pnpm --filter @maister/supervisor smoke:acp -- --read-only-session gemini
pnpm --filter @maister/supervisor smoke:acp -- --read-only-session opencode
pnpm --filter @maister/supervisor smoke:acp -- --read-only-session mimo
```

Deliverables:

- Record each focused and full gate separately; environment-blocked is not pass.
- Keep required-evidence adapters fail-closed when live smoke is unavailable.
- Run an adversarial pass against cache downgrade/replay/staleness, clock skew, adapter alias drift, partial smoke, concurrent cleanup, lock crash/takeover, symlink/path escape, corrupt ownership state, terminal retry, and invalid-resync data loss.
- Perform a final requirement-by-requirement fullness, consistency, logical-hole, acceptance, and non-goal audit against the SDD traceability table.
- Rebase onto current `main`, re-check ADR/migration numbering, rerun affected gates, and review the final diff before owner fast-forward.

Logging requirements:

- Verification adds no ad-hoc logs. Assert production logs are structured, bounded, redact secrets, and use DEBUG/INFO/WARN/ERROR consistently.

Acceptance:

- Every focused and full required suite is green; otherwise the plan remains incomplete with the exact blocker recorded.
- Live-smoke unavailable is recorded per adapter and cannot be used to produce fresh `ok` evidence.
- Check-only ESLint is used; no repo-wide `--fix` command runs.
- No trivial test, redundant Cartesian test family, unchecked acceptance criterion, or undocumented contract change remains.

Dependencies: Task 6.1.

## Final Go/No-Go

Go only when:

- The SDD traceability matrix has no unowned or unverified requirement and the pre-code logical-hole gate was completed before RED tests.
- Both adapter mirrors agree by stable adapter id and the drift guard is green.
- Every declared capable adapter passes the parameterized read/write/unknown wire matrix.
- Cache v1 compatibility and cache v2 `probeVersion`/`stale` semantics match Supervisor OpenAPI and required evidence is fail-closed before side effects.
- Non-Claude sessions do not receive Claude L2 settings.
- Pinned providing-package skills are wholesale, Claude subagents are ownership-recorded, and exec trust is unchanged.
- Run-scoped ownership survives concurrent sessions and enumerated crash windows; path confinement and all workspace terminal paths clean safely.
- All four standalone triggers have integration proof.
- `capability_profile` is typed from parser through launch, resync is report-only for invalid legacy rows, and Studio blocks invalid drafts.
- Settings and Studio show the as-built evidence/validation concepts with EN/RU and screen-artifact parity.
- GREEN refactor preserved behavior and full relevant suites stayed green afterward.
- Required test, typecheck, lint, docs, contract, and ADR-anchor gates are actually green.

No-go when any historical completeness checkbox is used as evidence in place of current test output.
