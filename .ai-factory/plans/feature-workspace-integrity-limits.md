# Implementation plan — Workspace integrity checks

Branch `feature/workspace-integrity-limits` · Local base `cab367397c603ab7430d709d783f7d62742a7e18` · 2026-11-21

## Settings

Specification-driven implementation. Task 1 establishes the reviewed HTTP, persistence and lifecycle contracts before implementation begins. Use real filesystem traversal, isolated PostgreSQL, structured diagnostics and browser acceptance. Each behavioral change follows RED → GREEN → refactor. Documentation and executable acceptance are release gates.

## Roadmap Linkage

None, by request. This work addresses the MAI-11 preparation failure.

## Incident and timing evidence

Triager run `66257012-3b24-446e-889b-cfcd209b31de` failed before agent start. The supplied web log records stage `baseline`, reason `operational_integrity_limit`, axis `bytes`, observed 268,737,798 B, maximum 268,435,456 B, 9,266 completed entries and 10,354 ms elapsed. File size is charged before file contents are read. The byte count at refusal therefore includes the file that would cross the limit. The complete tree is larger.

Planning measurement used a clean detached local Git clone at `cd9e37f071f7d29e6fbc03d36e1e83c8a0ffdb5f`, Darwin arm64, Node 24.22.3. The harness and dependencies lived outside the measured tree. Git status including ignored files was empty before and after. The probe was the repository's `operational-integrity.ts` with `ephemeral_checkout` semantics, including file hashing, symlink handling and Git metadata queries. The module at this revision matches the planning base.

| Operation on the same checkout | Result | Elapsed |
| --- | --- | ---: |
| Stock baseline, 256 MiB / 30 s / 100,000 entries | Refused on bytes at 268,737,798 B after 9,266 completed entries | 956 ms to refusal |
| Baseline, 1,024 MiB / 120 s / 100,000 entries | 482,517,365 B (460.16 MiB), 11,749 entries | 1,339 ms |
| Capture generation with an empty owned-path list | Generation 1, unchanged tree | 1,291 ms |
| Final verification against generation 1 | `clean`, empty reasons and changed paths | 1,271 ms |

The proposed-limit run used a temporary benchmark build that changed just the two constants in memory. The complete byte total sums regular-file sizes and symlink target lengths for the captured entries. Entry count includes directories and excludes the root and top-level Git administrative entry. Timings are one local sample per operation following checkout, with ordinary OS caching. This supports 120 seconds for the measured checkout and supplies no production latency bound. Keep the proposed defaults. Task 9 repeats both outcomes using the shipped resolver and the isolated database.

## Settings contract

Each value governs **one invocation of the shared traversal**. The following inclusive administrative ranges are design choices. They permit the old and new defaults and bound the cost of a misconfigured check. The duration ceiling also keeps one nominal scan below the rowless GC claim's 300-second lease. Multiple scans still require renewal.

| JSON field and storage unit | Nullable column on `platform_runtime_settings` | Web service environment key | Built-in | Allowed integers |
| --- | --- | --- | ---: | ---: |
| `maxSizeMiB` (MiB) | `workspace_integrity_max_size_mib` | `MAISTER_WORKSPACE_INTEGRITY_MAX_SIZE_MIB` | 1,024 | 1–8,192 |
| `maxDurationSeconds` (seconds) | `workspace_integrity_max_duration_seconds` | `MAISTER_WORKSPACE_INTEGRITY_MAX_DURATION_SECONDS` | 120 | 1–240 |
| `maxEntries` (filesystem entries) | `workspace_integrity_max_entries` | `MAISTER_WORKSPACE_INTEGRITY_MAX_ENTRIES` | 100,000 | 1–500,000 |

- For each field select the first applicable source in order `platform` (non-NULL singleton column), `environment` (present service variable), `default`. A saved value equal to the default still has source `platform`. A reset writes SQL NULL. Never materialize inherited values in the database. Convert MiB × 1,048,576 and seconds × 1,000 exactly once at the traversal boundary using safe-integer arithmetic.
- Parse applicable env values as whole decimal integers within the same ranges. An unset variable inherits the built-in. Reject empty, fractional, signed, malformed or out-of-range env input with a typed `CONFIG` failure naming the field and variable. Do not silently substitute a default or clamp an invalid value. A valid stored override shadows the corresponding env value. If resetting would reveal invalid configuration, reject the entire PATCH and retain the stored overrides. A DB failure cannot authorize a default-only scan.
- Add **GET /api/admin/platform/workspace-integrity** for effective settings and **PATCH** on that resource for an atomic partial update. Both return 200 with the same complete view, for example `{"maxSizeMiB":{"value":1024,"source":"default"},"maxDurationSeconds":{"value":90,"source":"environment"},"maxEntries":{"value":75000,"source":"platform"}}`. Field names define units. Use a strict nonempty PATCH object, for example `{"maxSizeMiB":512,"maxEntries":null}`. A JSON integer sets an override, null resets that field, and omitted fields retain their stored state. Reject unknown keys, strings, booleans, nonintegers, out-of-range values and invalid JSON. Server owns actor, row ID, scope, source and units.
- Require `requireGlobalRole("admin")` on both methods before reading settings, parsing the body or performing writes. Follow the admin JSON error envelope with typed code/reason and a bounded field identifier for localized validation. Specify 401 for unauthenticated, 403 for insufficient authority or account restrictions, 422 for invalid input/configuration including an uninitialized singleton, 503 for recognized temporary DB unavailability and 500 for unexpected failures. Serve uncached authenticated views. Use the existing singleton bootstrap in `web/lib/acp-runners/native-defaults.ts`. The admin API refuses an uninitialized singleton. A runtime query that succeeds with zero rows inherits the environment or built-in limits, preserving explicit-runner operation before singleton bootstrap. A failed query still refuses the check. Preserve its required runner FK and other settings.
- Update only present columns plus the existing update timestamp, using one row UPDATE with RETURNING inside a short transaction. Resolve and validate the complete response against those returned values before commit. Roll back on failure and acknowledge success only after commit. Concurrent disjoint edits survive. If two administrators change the same field, the last committed update wins. Never hold a settings transaction or row lock for a filesystem scan.

### HTTP and failure schemas to specify in Phase 0

In OpenAPI 3.0.3 define distinct request and response schemas. Both operations use `sessionCookie` security, unique operation IDs, `application/json` responses and `Cache-Control: private, no-store`. PATCH requires an `application/json` body. Its object has `minProperties: 1`, `additionalProperties: false` and three optional `type: integer`, `nullable: true` properties with the table bounds. The response requires all three named fields. Each field is a closed object with a bounded non-null integer `value` and a required `source` enum. A PATCH containing both a valid edit and an invalid edit fails as a unit.

| Outcome | Status and response contract |
| --- | --- |
| Successful read, save or reset | 200, full effective view. Resetting an already inherited field succeeds and preserves its source. |
| Missing session / inactive account / password change required / insufficient global role | 401 `UNAUTHENTICATED` for a missing session. For 403 preserve the guard's `ACCOUNT_INACTIVE`, `PASSWORD_CHANGE_REQUIRED` or `UNAUTHORIZED` code. Reject even an invalid PATCH at the role gate first. Use the existing active-role predicate for the section's server-side read/render gate as well. |
| Rejected payload or configuration | 422 `{code:"CONFIG", message, details:{reason, field?}}`. Define stable reasons `invalid_body` for unsupported media type, malformed JSON, empty/non-object payloads or unknown keys, `invalid_value` for a known invalid field, `invalid_environment` for an invalid inherited field and `settings_missing` for an uninitialized singleton. `field` is one of the three JSON names for field-specific failures. The UI maps reason/field to EN/RU copy. |
| Storage or internal failure | 503 `EXECUTOR_UNAVAILABLE` for a recognized transient DB error, 500 `CRASH` otherwise. Return a safe message. Reject failed reads before walking and failed writes before acknowledging success. |

Specify the optional nested `integrityLimit` in both copies of `OperationalPreparationFailure`. When present it is closed and requires `reason: operational_integrity_limit`, a valid axis/unit pair, and all five integer measurements (`observed`, `maximum`, `observedEntries`, `observedBytes`, `elapsedMs`). Counters are nonnegative and the threshold is positive. Use a real MAI-11-shaped example and a legacy cause-chain-only example. Validate both against both schemas and reject a mismatched pair such as `bytes/ms`. Require the same diagnostic shape wherever the existing projection is returned. Existing run reader authorization continues to govern the receipt.

## Enforcement and diagnostic paths

The Next.js web tier owns the database read and the filesystem traversal, including its preparation, Flow, finalization and GC workers. Use one server-only resolver with an explicit read dependency for the owning instance/database. Read the three columns together from committed state at the beginning of **each** `captureTree`. Pass one immutable numeric snapshot through every filesystem and Git step. A check starts with that read. The first read after a successful save sees the change across web workers sharing the database. Avoid process caches, long-lived transaction snapshots, per-file reads, and embedding limits in a run, baseline, project config, package or supervisor command. Keep service env consistent across web replicas. UI saves are hot. Changing a service's environment follows its normal reload/restart procedure.

| Caller / entry point | Path to verify in implementation |
| --- | --- |
| Initial capture and post-materialization capture | `web/lib/agents/launch.ts` calls `captureOperationalBaseline` and `captureOperationalGeneration` for operational launches and task preparation. Preserve context, resource kind, frozen commit and legacy ephemeral flags. |
| Context repositories | `web/lib/agents/operational-context.ts` calls baseline + generation per sibling in `captureOperationalContextMounts`. `inspectOperationalContextMount` verifies each sibling against its frozen witness. Each pass reads settings, even within the same run. |
| Root verification, resume, dispatch and terminal settlement | `inspectOperationalWorkspace`, `inspectOperationalContexts`, `inspectOperationalRun`, `assertOperationalDispatchIntegrity` in the same module feed `agents/launch.ts`, `flows/runner-agent.ts`, `agents/finalization.ts` and `run-results/company-flow-terminal.ts` under `web/lib/`. `web/lib/tasks/launch-agent-execution.ts` also verifies a reused task workspace directly. |
| Company Flow workspaces | `web/lib/agents/company-flow-workspace.ts` captures plain-directory baseline/generation and later materialization generations, and verifies an existing workspace. Follow through `web/lib/flows/graph/runner-graph.ts`. |
| Cleanup and evidence | `web/lib/gc/operational-disposition.ts` inspects each context and root. `web/lib/gc/operational-evidence.ts` calls baseline again to build an archive. Pass the same settings read dependency into this nested capture. Keep evidence archive and per-file publication budgets independent. |

Inside `web/lib/agents/operational-integrity.ts`, all three public routines reach the private walker. Today baseline accepts optional numeric limits, generation and verification pass `{}`, and three `Math.min` calls cap every caller at the old defaults. Remove those numeric bypasses and clamps. Preserve checks on accounting boundaries, monotonic deadline, chunk reads, Git subprocess remaining timeout, race checks, ref scope and baseline versions. Keep the **fixed 1,048,576 B** `config.worktree` cap and its distinct `worktree_config_bytes` axis.

Preserve the primary reason `operational_integrity_limit`. Capture refuses partial results. Verification returns `indeterminate` with that reason and no invented changed paths. A failed scan cannot publish a generation, admit dispatch, certify clean completion or authorize unpreserved removal. Preserve existing precedence when combining a proved change on one resource with an indeterminate sibling. Preserve normal secondary cleanup and primary failure ordering.

Use an optional, allow-listed `integrityLimit` object on the existing `OperationalFailureDiagnostic`. Capture reason, `limitAxis`, `observed`, `maximum`, `unit`, `observedEntries`, `observedBytes` and `elapsedMs` from the failed check. Axis/unit pairs are `bytes/B`, `time/ms`, `entries/entries`, `worktree_config_bytes/B`. Keep the observed integer and effective threshold in matching units. Preserve outer stage, cause chain, preparation and assignment IDs. Do not serialize arbitrary error details. The retained receipt is authoritative when settings later change.

### What the run reader sees when a limit stops a check

Show a visible, localized summary on the run page, beside the stage or outcome it explains. A reader must be able to identify the affected workspace, the check that stopped, the measured value, the limit, the consequence and the next action without opening logs or expanding JSON. Use preparation details for exact counters, elapsed time and the diagnostic code. A reported agent result and a later failed verification can coexist. Show both. Cleanup failures belong with the cleanup outcome and must not rewrite the earlier execution result.

| First threshold reached | Explain why and where | Action to show |
| --- | --- | --- |
| Total size (`bytes`) | Name the stage and workspace. Display bytes accounted for at the stopping point and the effective limit in MiB, with exact byte counts available. The observed size is a lower bound on the complete scan. | A global administrator can open **Settings → Workspace integrity checks → Total size (MiB)**. Measure the complete intended checkout, choose a limit that covers it, then start the appropriate new check. |
| Duration (`time`) | Show elapsed time and allowed duration in seconds, with exact milliseconds in details. Identify a filesystem or Git operation only if the receipt recorded it. | Review the execution host's storage or Git operation if the elapsed time is unexpected. For an expected workload, a global administrator can adjust **Duration (seconds)**. |
| Entry count (`entries`) | Show the first entry number that exceeded the limit and the permitted count. Keep that number distinct from completed entries. Files, directories and symlinks all count. | Review the contents of the intended checkout, including generated or ignored entries. A global administrator can adjust **Filesystem entries** for the expected tree. |
| Git worktree configuration (`worktree_config_bytes`) | Identify the logical Git file `config.worktree`, its observed bytes and its fixed 1 MiB limit. | Ask the repository or execution-host operator to inspect the affected worktree’s Git configuration and correct the oversized configuration at its source before retrying. There is no platform setting for this limit. |

For the three configurable axes, link active global admins directly to the labeled field on the existing page using `/settings#workspace-integrity-size`, `/settings#workspace-integrity-duration` or `/settings#workspace-integrity-entries`. The link must land on the corresponding control. For another authorized run reader, name the field and ask them to share the run ID and observed values with a global administrator. Use the check's captured threshold in the explanation even if the current setting differs. A change applies to the next check. Offer a new attempt or cleanup retry only through actions already permitted for that run, state and reader.

Record the stage (initial baseline, post-materialization, dispatch/continuation, final verification or cleanup/evidence capture) separately from the resource (primary workspace or context repository). Carry these categories when an error is wrapped or multiple results are combined. Display a context name only when its disclosure is already authorized. Otherwise say “context repository”. A cumulative size or entry limit does not identify a culprit file. Never infer a file path or disclose an absolute host path. Describe the supported consequence: an initial capture can block agent start, a final check leaves integrity indeterminate, and an unsuccessful preservation attempt leaves cleanup pending or retained according to its receipt. Only say that execution never started when dispatch evidence establishes it.

**MAI-11 acceptance example.** “The initial workspace check stopped before the agent started. It counted 268,737,798 bytes in the primary workspace and reached the 256 MiB limit (268,435,456 bytes). The scan ended before the full size was known.” An admin sees **Open total size setting**. A member sees **Ask a global administrator to review Total size (MiB)** with the run ID. Historical receipts lacking these fields show only known facts and a run ID for log correlation. Keep distinct reasons such as a changed source, missing baseline, unreadable file or lost ownership on their existing diagnostic paths. Raising a traversal limit is actionable only when a recorded limit stopped the check.

## Requirement and test ownership

Use these acceptance IDs in the task evidence and the Phase 0 trace from lifecycle expectations to enforcing code and primary test titles. Existing operational traceability IDs retain their original ownership. Reference existing tests for unchanged behavior. Reuse each fixture below for the assertions at its own boundary.

| ID | Requirement and decisive observation | Primary test owner |
| --- | --- | --- |
| WI-01 | An upgraded, populated singleton and a freshly seeded installation both inherit. Bounds survive direct SQL writes, independently of HTTP validation. | Task 2, web DB migration integration test |
| WI-02 | Three independent sources, exact conversions, strict PATCH, rollback on a bad sibling or inherited env, and concurrent partial updates. Returned values agree with committed state. | Task 3, one route/store integration suite on real PostgreSQL |
| WI-03 | A global admin can read/set/reset. Anonymous and authenticated project-only admins cannot read or mutate. A stale session for a demoted admin loses access. | Task 8, direct HTTP with real sessions in the browser lane |
| WI-04 | Every scan uses one committed snapshot. Small fixtures hit each numeric boundary, including a check during a concurrent save, Git deadline expiry and the fixed worktree-config limit. Capture, generation and verify preserve their distinct results. | Task 5, existing operational-integrity integration suite |
| WI-05 | Context, task and company callers honor the same limits. Cleanup preserves bytes after a failed archive or lost lease. | Task 5, existing caller suites below, with cleanup-specific predicates owned by operational-disposition integration |
| WI-06 | A run reader can tell what stopped, why, which workspace and stage were affected, and where to fix it. The original values survive settlement and later settings changes. EN/RU remediation matches the axis, current role and available retry action. Older receipts display known facts. | Task 6, preparation settlement/projection integration and legacy component fixture. Task 1 owns identical wire-schema examples. |
| WI-07 | EN/RU inputs, units, source, validation, keyboard reset and save confirmation work. Saving, reloading and resetting alter the next real preparation in one process lifetime. | Tasks 7–8, localized UI interactions and one execution-ab browser journey |
| WI-08 | The shipped code refuses the pinned clean tree at 256 MiB and verifies the same tree as clean with all built-ins. | Task 9, separately selected web Vitest qualification test |

## Phases, dependencies and acceptance

For every new behavior, write the owning test first. **RED:** list it with its runner, run it against the preceding behavior, and retain the failing assertion, command and revision. An unavailable DB, missing fixture or undiscovered test is a harness failure. **GREEN:** change the smallest production seam that meets the reviewed contract and rerun the same assertion through the normal entry point. **Refactor:** remove duplicated rules, then rerun the owning and affected caller suites. Record all three steps against the acceptance ID. Already-green invariants retain their existing tests. Task 4 records its env smoke check once. Task 8 uses those initial values as the browser fixture. Start the cross-layer acceptance tests before the last necessary implementation change, even when the final qualification runs later.

Keep HTTP parsing/authorization in the route, typed field rules and pure effective-value resolution in one module, transactions in the settings store, and traversal/receipt decisions with their existing owners. Pass a narrow database reader and monotonic clock only where required. Preserve strict types, structured domain errors and the project's functional conventions. Keep SQL constraints, OpenAPI and translations in parity with the runtime rules. Avoid adding a second settings store, dependency framework, generic configuration service, or per-caller test matrix.

At each implementation phase exit require the focused tests and the complete existing web unit and integration gates to pass. Record unrelated baseline failures explicitly as outstanding gates. Final acceptance also requires contracts, docs, typecheck, browser and qualification runs below. Keep the browser invocation and its singleton isolated from other suites. Store tests only need their own migrated database.

### Phase 0 — Specify the contracts

- [x] **1. Document the design before coding.** Add the settings/read/update/reset and failure flows to `docs/configuration.md`, `docs/system-analytics/operational-agent-lifecycle.md` and the preparation disclosure to `docs/system-analytics/agent-preparation.md`. Specify the two admin operations and additive `OperationalPreparationFailure` shape in `docs/api/web.openapi.yaml`. Mirror the shared failure shape in `docs/api/external/operations.openapi.yaml`. Describe the nullable singleton columns in `docs/database-schema.md` and the relevant platform settings ER diagram in `docs/db/projects-domain.md`.

  Replace the hard-coded contract paragraph in `docs/db/task-launch-domain.md` with a reference to the lifecycle integrity boundary. Retain the separate lease durations there. In the lifecycle document specify the order of load, capture, generation, verification, refusal, evidence preservation and disposition. Enumerate the failure outcome for each transition, including unavailable settings, the first limit reached, partial context failure and stale cleanup ownership. Identify the owner and observable postcondition for every transition. Link `docs/system-analytics/operational-agents-traceability.md` to the new acceptance mapping and preserve the original OPL-02/04/05 and EDGE-OPL-04/05/06 requirements and their primary tests. The existing operational coverage validator is tied to its historical plan. Check this feature's WI rows against actual test discovery and execution separately.

  Mark pending contracts Designed. Identify the existing Run/collect/automation readers, existing Run access gates and safe data class. Supervisor, ACP and SSE envelopes require no new settings message. Specify the WARN and INFO fields from tasks 3 and 6 here. Define one reusable bounded limit schema, including stage and resource category, for preparation, final verification and cleanup projections. Specify the optional location on each owning receipt and the corresponding OpenAPI views. For company Flow and task-launch refusal, document the existing event/detail or refusal reader that owns the explanation and update its contract if its public payload changes. Links, translations and reader-specific actions are derived at render time.

  **Acceptance.** Trace each field from wire unit to storage to runtime unit and back to operator display, and each refusal to its HTTP status or lifecycle outcome. Validate both OpenAPI files with `pnpm validate:contracts`, extend its existing example validation for the two diagnostic schemas, and run `pnpm validate:docs:all`. Check the table of limits, nullability, error examples and lifecycle postconditions agree across documents before Task 2.

### Phase 1 — Persist and resolve settings

- [x] **2. Migrate existing installations** (after 1). Extend `web/lib/db/schema.ts`. Generate an additive main-line migration under `web/lib/db/migrations/` with three nullable integer columns and independent range CHECKs. The next candidate on the inspected journal is `0360`. Reconcile against the latest base at implementation and before merge. Include SQL, journal entry, Drizzle snapshot and regenerated `docs/db/erd.dbml`. Leave populated singleton values intact. NULL inherits configuration on upgrade and fresh bootstrap.

  Use `web/test-support/pg-container.ts` in a migration integration test. Open the immediate predecessor with `startMainPostgresTestDbUpTo` (currently `0359_acp_context_projection_state`). Seed the required runner and singleton with recognizable sibling settings. Snapshot that row, then call `applyMainMigration(database.db, newTag)` for the single new additive migration. Compare all pre-existing values and the FK and assert the three new values are NULL. Exercise a valid lower/upper value, NULL and values immediately outside both bounds for each column in direct SQL. For the fresh-install case use the normal full migrator and native singleton bootstrap. Deploy the additive migration before updating web processes. On a binary rollback keep the nullable columns and stored values for the next rollout.

  **Acceptance.** Pre-existing runner, webhook, librarian and provider fields survive. Bounds and NULL work in direct SQL, invalid values fail. Journal integrity, ERD check and a second schema generation are clean.

  Use existing migration diagnostics.

- [x] **3. Implement resolution and admin API** (after 2).

  Add the typed settings store/view alongside the web platform settings modules and `web/app/api/admin/platform/workspace-integrity/route.ts`. Follow `web/lib/librarian/settings.ts` and its admin route for singleton access and role enforcement.

  Share field definitions between validation and the client-safe view, keeping DB/env reads server-only.

  Test mixed sources, equal-to-default overrides, the accepted endpoints and invalid PATCH variants in the HTTP schema, malformed active env values, reset rollback, missing singleton, min/max boundaries, mixed set/reset, concurrent disjoint patches from separate connections with a controlled commit order, and repeat save/reset. Use isolated PostgreSQL with the native settings seed. Inspect row values as well as HTTP responses. Log committed changes at INFO with actor ID, changed fields, numeric values and resulting sources. Log configuration and storage failures using established structured error handling.

  **Acceptance.** Verify the exact response status, envelope and committed row for a mixed save/reset, a reset exposing a bad env value, and a valid override that repairs an otherwise invalid inherited value. A failure after UPDATE rolls back both changed fields and the timestamp. Exercise missing singleton and transient storage errors at the store/route boundary. Prove same-field last-commit and disjoint-field preservation at the database. Reuse auth and browser evidence from Task 8.

### Phase 2 — Enforce and explain every check

- [x] **4. Wire runtime and deployment configuration** (after 3).

  Document the three optional variables as commented examples in `.env.example` and `deploy/maister.env.example`. `deploy/maister-web.service` loads `/etc/maister/maister.env`.

  Inspect the web start path and exercise the resolver with the host web env at runtime. The root Compose files serve Postgres, the public Compose file serves the public site, and the Dockerfile requires no build args, ports or mounts for these keys. The supervisor, stand connector and adapter processes have no enforcement responsibility.

  **Acceptance.** Start the isolated web process with one env value, confirm that field reports `environment`, and confirm unset fields report `default`. The templates and configuration table agree on names, units and defaults. Use the existing service startup/error logs.

- [ ] **5. Replace the hard-coded ceilings at the shared walker** (after 3). Wire each path in the caller table, including diagnostics context/legacy flags, direct task reuse and GC evidence recapture. Thread the test/worker's actual settings database through callers lacking it. Update `web/test-support/preparation-owner-process.ts` and existing callers/fixtures of the three signatures.

  Cover both cleanup owners. Rowless GC uses the 300-second run claim in `web/lib/gc/operational-disposition.ts`. Row-backed GC uses `promotionClaimTimeoutSeconds()` through `web/lib/workbench-lifecycle/service.ts` and can have a lease shorter than one permitted scan. Keep the actual owner renewed during long work and across siblings, using serialized, owner-fenced renewals and stopping renewal on exit. Check ownership before publishing evidence, restoring, removing or releasing resources. On loss, defer to the current owner and retain unpreserved bytes. Exercise a blocked scan that spans the shorter lease and a stale owner after takeover. The evidence archive's separate 384 MiB total and 256 MiB per-file limits retain their current refusal semantics.

  Extend `web/lib/agents/__tests__/operational-integrity.integration.test.ts`: replace per-call 1-byte, 1-entry and 0-ms overrides with actual saved settings from the isolated DB. Test an exact byte cap and one byte over using 1 MiB, exact entry cap and one extra, and a positive one-second limit using a controlled monotonic clock reaching 1,000 ms. Freeze/advance just the walker's clock after traversal starts. Use real files and DB, without sleeping or globally changing database/lease timers. Keep the oversized `config.worktree` test passing with high global settings.

  Hold a scan at a deterministic filesystem barrier after its settings read, save a lower cap on another connection, release the scan and prove it finishes under its original snapshot. A fresh scan must refuse under the new value. In the inverse direction, a save cannot rescue an already bounded scan.

  Check the monotonic deadline after loading the settings snapshot, from the start of filesystem work through the final awaited operation and before returning a clean tree, including an empty plain directory. Exact byte and entry limits are inclusive. Elapsed time at or beyond the deadline refuses. Guard the Git metadata path in `web/lib/project-config-persistence/git-process.ts`: a timeout attributable to the scan's remaining budget retains `operational_integrity_limit/time/ms` through owned and ordinary Git execution. Preserve unrelated Git errors, output-buffer overflow and ownership failures as their original causes. Carry a typed timeout indication at the process boundary where necessary. A generic kill signal, message match or elapsed time observed after an unrelated error cannot establish the cause. Test the controlled timeout and an ordinary Git failure through this mapping.

  Exercise raised settings in the walker. Use the controlled clock above 30 seconds and configure more than 100,000 entries on the small fixture. On a different axis's intentional refusal assert the actual walker's diagnostic reports the raised entry ceiling. Task 9 owns the real >256 MiB case. Retain structured probe WARN logs.

  **Acceptance.** Each fixture fails on its intended axis only, respects exact boundary semantics, and pre-existing integrity/cleanup tests still pass. Verify all three exported paths and each production caller family, including nested contexts, preservation failure with resource retained, and lost-lease refusal.

- [ ] **6. Retain the primary limit diagnostic and render preparation details** (after 5). Extend `web/lib/agents/operational-diagnostics.ts`, `preparation-workspace.ts`, `create-failure.ts`, `launch.ts`, `finalization.ts` and `web/lib/run-results/operational-{types,projection}.ts` where the failure is normalized, retained and projected.

  Carry bounded evidence through verification results, `combineIntegrityResults` and preparation refusal wrappers without replacing their outer reasons. Exercise the undispatched settlement branch.

  Implement the run-reader contract above in EN/RU. Persist the bounded witness on the receipt that owns the failed check: preparation journal/terminal infrastructure failure, terminal integrity result for final verification, or current cleanup attempt for disposition and evidence capture. In `web/lib/gc/operational-disposition.ts` associate the diagnostic with the same attempt/revision as its cleanup outcome. Clear stale current-attempt advice after a successful retry. In `web/lib/run-results/company-flow-terminal.ts` and `web/lib/tasks/launch-agent-execution.ts`, carry the original witness through company Flow settlement and bound task reuse refusals to their authorized existing reader. Preserve the outer lifecycle reason. For a successful agent result followed by an indeterminate check, keep the agent result visible.

  Use the shared read-only explanation in `web/components/runs/operational-run-result.tsx` and the applicable Run detail/terminal cause surface in `web/app/(app)/runs/[runId]/layout.tsx`. Put the cause and next action outside the collapsed technical details and outside the branch that only renders when a reported result is missing. Keep legacy receipts readable. Derive edit-link visibility from the viewer's current global role and keep diagnostic read access scoped to the run.

  Use one real preparation failure for receipt assertions. Reuse the existing component fixture in `web/components/runs/__tests__/operational-run-result.test.ts` for legacy/missing details. If multiple probes refuse, retain the first limit diagnostic in deterministic root-then-context traversal order alongside the existing aggregate verdict and reasons. Preserve run and assignment identity. Task 8 reads the newly failed run again after reset to exercise the historical projection. Keep existing qualification readers' bounded disclosure intact.

  **Acceptance.** Drive the localized component with a compact table covering each axis, a context repository, final verification alongside a valid reported result, cleanup and a historical receipt. Check actionable cause, consequence and role-appropriate destination. The fixed Git cap never offers an editable threshold. Extend existing settlement/disposition fixtures for the distinct receipt writers and confirm no stale advice on successful cleanup. Use the real MAI-11-shaped byte failure for the browser proof. After changing the setting, read the same failed preparation by run ID. Its projected and rendered stage, counters and threshold match the original structured WARN fields. No raw paths or stderr are exposed. Task 8 supplies the final browser reload evidence.

Existing direct-caller integration fixtures to migrate in task 5 (paths under `web/lib/`). Each must select the test database that owns its fixture and preserve its existing outcome assertions.

| Existing fixture | Evidence to retain |
| --- | --- |
| `agents/__tests__/application-quiescence.integration.test.ts`, `agents/__tests__/agent-run-result.integration.test.ts` | Ephemeral preparation options, quiescence and real terminal baseline |
| `agents/__tests__/company-flow-context.integration.test.ts`, `agents/__tests__/company-agent-context.integration.test.ts` | Company plain-directory and operational root witnesses |
| `tasks/__tests__/launch-agent-admission.integration.test.ts`, `tasks/__tests__/qualification-publication.integration.test.ts` | Reused task workspace and qualification baseline |
| `gc/__tests__/operational-disposition.integration.test.ts`, `packages/__tests__/operational-core.integration.test.ts` | Root and context evidence on cleanup, and package launch generation |

### Phase 3 — Admin UI and end-to-end qualification

- [ ] **7. Add the global settings section** (after 3). Compose an admin-gated `WorkspaceIntegritySettingsCard` on `web/app/(app)/settings/page.tsx`, following the adjacent librarian card and shared mutation feedback.

  Use the existing singleton read in `loadPlatformRuntimeView` for the initial authorized page view and the same effective-value resolver as GET/PATCH. On an invalid active env value, display a field-specific configuration error and allow the admin to supply a valid override. A failed read must never display a fabricated effective value. Give the three labeled controls the stable anchor IDs from the remediation table. Submit only edited fields and explicit resets so an unrelated concurrent edit survives.

  Use labeled integer inputs, effective value and source per field, accessible per-field reset, and one Save for pending edits. Reset stages only that override for removal. On success replace the view with the server response. Retain edits and report field-specific errors on rejection. Prevent duplicate submissions.

  In `web/messages/en.json` and `web/messages/ru.json` include “Workspace integrity checks” / “Проверки целостности рабочей области”, “Total size (MiB)” / “Общий размер (МиБ)”, “Duration (seconds)” / “Длительность (секунды)”, “Filesystem entries” / “Объекты файловой системы”. Translate source labels, reset actions, integer/range errors and save confirmation.

  **Acceptance.** Exercise the form in both locales in the browser journey from Task 8, using DOM assertions in the same fixture. Assert labeled units and sources, keyboard-accessible independent reset, omission of untouched values from the PATCH, field errors with preserved edits, and save confirmation using the returned values. Task 8 owns persistence across a full page reload and confirms a member receives neither section nor settings payload.

- [ ] **8. Prove the browser-to-traversal path and direct authorization** (after 4–7). Add `web/e2e/execution-ab-workspace-integrity.spec.ts` to the existing serial `execution-ab` project in `web/playwright.execution-ab.config.ts`. Its global setup boots the real supervisor with a controlled ACP adapter. Use the existing isolated invocation `pnpm --filter maister-web test:e2e:execution-ab execution-ab-workspace-integrity.spec.ts` with env scoped to this invocation. Confirm discovery in this lane and exclusion from the default lane. Use `admin-execution-host.spec.ts` for real member authentication.

  Launch a dedicated test web process with an env size limit of 3 MiB and an isolated DB, seed an operational agent and a small committed repo whose measured tree is between 1 and 3 MiB. Record the initial 3 MiB/environment and both built-ins. Through the UI save 1 MiB and an independent entry override high enough for this tree, verify confirmation/source, reload, then trigger a fresh real operational preparation through its normal launch entry. Assert the new run's own baseline refuses on bytes at 1,048,576 B before session creation, and open its run page to verify observed/maximum/unit.

  Reset size alone in the UI, reload to see 3 MiB/environment, and launch another run whose actual baseline/generation now publish. While the entry override remains saved, set then reset duration and verify 120 seconds/default. Reopen the first failed run and verify its original 1 MiB threshold after the size reset. Follow the admin link from that failed run and assert it lands on the size input. Open the same run as an authorized reader without global admin rights and assert it displays the size, threshold, admin handoff and run ID. Verify the technical details can stay collapsed for both readers. Reuse the failed run for EN/RU feedback and labels. Keep the same server/worker lifetime, environment, repository revision and database throughout. No mocked settings, injected numeric cap, seeded terminal failure or test-only production endpoint. A controlled ACP peer may be used after preparation.

  Use the authenticated admin session for a positive direct GET and the successful browser PATCH. In a separate authenticated project-owner session with global member role, send GET, PATCH set and PATCH null directly, and verify 403 plus unchanged persisted columns. Inspect the member’s settings page and server-rendered payload for absence of the admin section and its effective values. Also exercise a demoted admin's existing session and anonymous 401 responses. For an unauthorized malformed PATCH, authorization wins before body validation. Run these requests within the same invocation. Reuse existing authz tests for account-specific guard branches.

  **Acceptance.** Retain the failed and successful run IDs, their preparation receipts and generation state, the browser values, persisted overrides, and the web process identity before save and after reset. For the failed run verify that the session-create command and bound session are both absent. Attach bounded diagnostics on failure.

- [ ] **9. Repeat the clean-checkout qualification and finish documentation** (after 5–8). Use the web Vitest qualification project and a dedicated `web/lib/agents/__tests__/workspace-integrity.qualification.test.ts` with sufficient per-test timeout for three complete passes. Run `pnpm --filter maister-web test:qualification lib/agents/__tests__/workspace-integrity.qualification.test.ts`. Require the pinned local commit object to exist and identify a missing object as a fixture setup failure. Use a clean disposable local clone pinned to the full measured SHA and a separate migrated test DB. Keep harness, dependencies, outputs and plan outside that clone. Verify cleanliness including ignored files, and obtain a complete inventory under the walker's accounting rules.

  Start the qualification with all three env variables absent for both settings writer and probe reader. Save only the old 256 MiB cap via the administrator settings path, retaining 120 seconds and 100,000 entries. Invoke the shipped production probe from the implementation revision against the separate pinned fixture tree. Require the bytes refusal and 268,435,456 B threshold. After the old-threshold refusal, reset the stored override through the same API, confirm all three sources are built-in, then capture baseline, capture real generation 1 with zero owned changes and perform final verification on **that same tree**. Require identical revision/inventory, `clean`, no changed paths and completion of each check within 120 s.

  Record actual SHA, host/Node version, resource kind, exact bytes and entries, old observed/maximum and elapsed time for each pass. Never substitute the planning timings.

  Confirm configuration docs, operational lifecycle/traceability, API examples and schema describe the qualified behavior. Reconcile migration numbering on current base. Require successful `pnpm validate:contracts`, `pnpm validate:docs:all`, `pnpm --filter maister-web typecheck`, `pnpm --filter maister-web test:unit`, `pnpm --filter maister-web test:integration`, the Task 8 execution-ab browser invocation and the Task 9 qualification invocation. Record revision, actual tests executed and exit status per gate. Resolve red tests and rerun on the final tree. Skipped cases, zero-test discovery and a partial suite leave the corresponding gate open.

  **Acceptance.** Retain the RED and GREEN receipts, all three fresh-default sources and complete measurements together with the test results. Mark documentation Implemented only after these gates pass.

## Implementation evidence

- WI-01 went RED against the predecessor because the migration was absent. The real PostgreSQL upgrade then passed, preserving the existing row and enforcing all three CHECKs. The normal full migrator also booted the settings and browser fixtures. A second Drizzle generation reported no schema changes and the canonical DBML check passed.
- WI-02 uses the isolated PostgreSQL route suite for atomic save/reset, source precedence, invalid-env rollback and database writer order. Admin authorization is also exercised with real sessions in WI-03.
- The pinned production probe read the cap through the settings HTTP handlers in a migrated isolated database. On Darwin arm64 with Node 24.22.3, the old 256 MiB cap stopped at 268,737,798 B. The full witness for `cd9e37f071f7d29e6fbc03d36e1e83c8a0ffdb5f` measured 482,517,365 B and 11,749 entries. The observed wall times under concurrent local test load were 12,818 ms to refusal, 13,234 ms for capture, 15,873 ms for generation and 12,187 ms for verification. Final verdict was clean with an unchanged detached checkout.
- The initial browser journey passed the admin override/reload/real preparation refusal/reset/fresh generation and EN/RU admin/member diagnostics in one web lifetime. Broader integration and the final browser rerun are separate gates.

## Commit plan for implementation

1. After tasks 1–3, commit the design contracts, additive migration and admin settings API.
2. After tasks 4–6, commit deployment wiring, traversal enforcement and durable preparation diagnostics.
3. After tasks 7–9, commit the EN/RU settings UI, end-to-end acceptance and verified operator documentation.
