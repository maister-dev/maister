# Project Rules for /aif-verify

> Curated from review pass-through findings.
> Sections under "Auto-generated rules" are managed by `/aif-evolve`; do not hand-edit them.
> Last updated: 2026-06-17
> Based on: 2 adversarial-review pass-throughs (M6 / 2026-05-28, M7 / 2026-05-28)
> + /aif-evolve M11b/M11c adversarial-review batch (2026-06-01)
> + /aif-evolve 107-patch batch (2026-06-17, cursor 2026-05-30 → 2026-06-16)

## Rules

### Re-derive the contract-surface list from the diff, not from the plan
**Source**: M6 adversarial review pass-through (2026-05-28)
**Rule**: Before declaring verify pass, enumerate every external-facing contract changed in the diff and confirm each has a corresponding spec/doc edit. Do NOT trust the plan's docs-list alone — the plan often misses spec files that nobody traced from the changed code.

Concrete enumeration checklist (apply to every changed file):

| Surface | Where the spec lives |
| ------- | -------------------- |
| HTTP route status codes, request shape, response shape | `docs/api/*.openapi.yaml` AND any prose contract doc (`docs/supervisor.md` for the supervisor; component-level docs under `docs/system-analytics/` for cross-tier flows). |
| SSE event types, payload shape, terminal signals | `docs/api/async/*.asyncapi.yaml` AND the relevant `docs/system-analytics/*.md`. |
| Wire fields that changed semantics (e.g. `router: ccr` from "reserved" to "load-bearing") | The same spec file as above — both the prose and the example payloads need to move. |
| New env var or config-file path consumed at runtime | `.env.example` AND the env-vars table in `docs/configuration.md` (do not rely on a narrative mention; the table is the canonical source). |
| New CLI flag, `package.json` script, or `pnpm exec` target | `docs/getting-started.md` "Scripts" section AND the relevant `web/` or `supervisor/` `CLAUDE.md` slice. |
| New DB column, new table, new index | Drizzle migration committed AND `docs/database-schema.md` AND the relevant `docs/db/*.md` ERD file. |

Mandatory gate: produce the list explicitly in the verification report (even if some entries are "no change required"), so reviewers can see the enumeration was performed. A passing verify report MUST cite the surfaces it checked. If a surface is on the list and the spec was NOT updated, escalate to a blocking finding — not a warning.

**High-drift sub-surfaces the diff scan must also reconcile (each is "code lands, docs lie"):**
- **Documented edge-case bullets** are the MOST dangerous drift — they read as a reviewed invariant and steer future implementers back to the old shape. A behavior that converged/removed a special case MUST delete or rewrite its old edge-case bullet, not just update the diagrams/enums.
- **Dormant-capability flip:** when a change turns a previously-dormant capability ON (e.g. the polymorphic `agent` actor going live), grep the older-stage analytics for `never` / `not yet` / `MUST NOT` claims and `(Designed)` / future status tags that the flip invalidates.
- **DB cascade/default claims** must be derived from the migration SQL `ON DELETE` clause, not the plan prose (docs claimed "no cascade"; migration `0040` shipped `ON DELETE CASCADE`).
- **Cross-file duplicated tables** (the same outcome strings in `readiness.md` AND `configuration.md`) re-drift — flag them to be collapsed per "cross-reference, do not duplicate," and verify the new value landed in EVERY copy (`system-analytics/` + `configuration.md` + `error-taxonomy.md` + every `.openapi.yaml`).
- **Self-contradiction on a touched value:** grep for a headline default the change touched appearing with two values (`MAISTER_MAX_CONCURRENT_RUNS` was `6` at one line and "global cap = 3" at another). New schema (`runs.agent_workspace`, migration `0052`) must be added to the runs/agents domain docs + `database-schema.md` citing its migration.

### Runtime parity gate — verify deployment can actually exercise the new path
**Source**: M6 adversarial review pass-through (2026-05-28)
**Rule**: For features that introduce env vars, config files, sidecar processes, new ports, or new host-mounted paths, verify the SHIPPED runtime (Docker compose files) can run the new path. Passing tests against mocks or testcontainer fixtures do NOT prove deployment readiness — they bypass the container boundary entirely.

Concrete checks per change class:

- **New env var consumed by a service** → grep `compose.yml`, `compose.production.yml`, `compose.override.yml` for the var name. Absent in all three → blocker (or explicit "deferred" docs entry per rule A2 in aif-implement).
- **New config file read from a host path** → grep the same files for a bind mount or named volume that exposes the path inside the container. Absent → blocker.
- **New sidecar binary** → confirm the dep is declared in the consuming package's `package.json` (lockfile committed), and that the bin is reachable from the container's PATH (workspace bin path is enough in dev compose; production prod overlay may need PATH adjustments).
- **New bound port** → if reachable from outside, confirm port mapping in compose; if internal-only, confirm no port conflict with other services on the same network.

The verify report MUST contain an explicit "Runtime parity" section listing each new dependency and its compose status (✅ wired / ❌ missing / ⏭️ explicitly deferred with docs link). Skipping this section = automatic warning; finding a missing wire that the plan did NOT mark deferred = blocker.

### Config→DB round-trip gate (SET and CLEAR symmetry)
**Source**: M6 adversarial review pass-through (2026-05-28)
**Rule**: When a feature introduces a YAML→DB column mapping that downstream readers use, the verify step MUST confirm the test suite covers BOTH halves of the round-trip:

1. **SET half**: writing the YAML field → the DB column equals the resolved value.
2. **CLEAR half**: removing the YAML field from a config that previously had it → the column equals the default (null / false / zero).

Asymmetric coverage is a blocker, not a documented limitation. If the SET-only test exists and the CLEAR-half test is missing, the verify report MUST list the missing test as a blocking finding under "Config→DB symmetry". An integration test that asserts the stale value persists after CLEAR is the WORST outcome — flag it as a bug that has been enshrined as behavior, and require both the test and the implementation to be fixed before verify passes.

This rule applies to any persistence layer (Postgres column, SQLite column, JSON file on disk that downstream code reads, env var written by a config materializer). The pattern "for entry in config: if !entry.field continue" is the giveaway.

### Regression-test enumeration for trust-boundary, retry-semantics, and deferred-release classes
**Source**: M7 adversarial review pass-through (2026-05-28)
**Rule**: When the plan or diff touches any HTTP route handler, SSE event handler, or queue consumer that the plan-side rules in `.ai-factory/skill-context/aif-plan/SKILL.md` flag as relevant ("cross-resource identifier", "two-phase commit", "no hidden deferreds"), the verify step MUST confirm a regression test exists for EACH of the following classes that applies to the diff:

| Class | Test must assert |
| ----- | ---------------- |
| Trust-boundary (body-controlled cross-resource id) | A request whose body field tries to name a different resource than the server-state-derived one is rejected — OR the body field is absent from the route entirely. Concrete shape: a test that constructs a request bound to session A but with a body claim of session B's runId, and asserts the handler does not write under session B's path. |
| Retry-semantics (two-phase commit) | (a) The happy path leaves the idempotency marker set ONLY after the downstream ack. (b) Simulated downstream 4xx (terminal class) transitions the parent resource to its terminal state AND marks the row terminal-failed in the same call. (c) Simulated downstream 5xx / network error returns the retryable status and leaves the row in a state a retry can recover (response set, marker null); a follow-up retry under the same row succeeds when the downstream comes back. |
| Deferred-release (no hidden deferreds) | A test that simulates a failure in the releasing-side code (DB error during the persist step, etc.) and asserts the deferred-creating-side release API was invoked exactly once with the right arguments. Use a spy on the cancel / reject API; without the spy, the regression cannot regress safely. |

The verify report MUST contain an explicit "Failure-class regression coverage" subsection listing each applicable class and the test file + test name(s) that cover it. A class that applies to the diff with no matching test is a blocking finding, NOT a warning. A class that does not apply (e.g. the diff added a pure read-only route with no downstream effects) is marked `n/a` with a one-line justification.

Reason: M7's first design described the three failure modes the Codex adversarial review found ONLY in the prose of the plan. None of the failure modes had a regression test, so an implementation following the prose could have shipped any of them. The fix added explicit test cases per failure class. The verify step's job is to make sure the test cases survived the implementation pass — they have a habit of being trimmed under deadline pressure. Re-derive the list from the plan + diff, not from the implementer's word.

## Auto-generated rules (managed by `/aif-evolve` — do not hand-edit below this line)

### "Logic exists + unit test passes" is NOT proof the behavior runs in production
**Source**: 2026-06-01-12.16, 2026-06-01-13.16 (#3), 2026-06-01-01.29, 2026-05-31-14.34
**Rule**: Before declaring verify pass, for every validation/branch the plan promises, PROVE it executes on the production path and that its test exercises the production path — a green test is not evidence by itself. Four concrete false-green gates:

1. **Optional-parameter validation (tested-but-unwired).** If a check is gated behind an OPTIONAL parameter (`loadFlowManifest(..., opts.executorIds)`), grep ALL production call sites and confirm at least one supplies it. A unit test that passes the parameter itself proves nothing about production wiring — the rejection branch can be dead in prod while the test is green. Trace from the diff's call graph, not from the test. Relatedly: validation whose inputs are project-scoped must run at a project-scoped seam (launch / `POST /api/runs`), not a package-scoped seam (install); and a reference id must be validated against the correct id-space (`executors.executor_ref_id`, not the `executors.id` PK).

2. **Parse-layer fidelity.** A schema-driven behavior test that builds its input from a hand-written object LITERAL bypasses the production Zod parse and any parse-time defaults — a false green for the deployed path. For schema-driven logic the test MUST feed real input through the production schema (`flowYamlV1Schema` → evaluator). Verify each such test actually parses; a literal-fed test is non-evidence.

3. **Sweep / coverage counts.** A source-sweep or "all classes cleared" assertion that checks only a loose MINIMUM count lets a missing scope look covered. Require an EXACT configured-scope count AND at least one fixture per supported source/scope, so a future source addition cannot silently drop from CLEAR handling.

4. **Never trust a piped exit code.** A verify command piped through `| tail` / `| grep` / `| head` reports the LAST stage's exit status (0), masking a failing vitest / lint / typecheck. Run the command BARE and check `$?`, or use `set -o pipefail`, before asserting pass/fail. A green-looking `| tail` is the worst false-green — it nearly shipped a 20-test-red integration suite as "exit 0". Also: a committed integration seed that inserts a FK/`NOT NULL` column as `null` (loose `drizzle(pool)` does not enforce it) makes a Docker-gated suite silently red — confirm the suite actually ran green, not merely "was present".

5. **Mock-hid-the-bug.** A recovery/branch/dispatch action (redispatch, resume, retry, promote) MUST have a test that drives the REAL executor and asserts an OBSERVABLE effect (a new attempt ran, a row advanced), NEVER "the dispatcher was called" against a mock — `runGraph`'s no-op guard returned `{state:"redispatched"}` while doing nothing, invisible because the test mocked `runFlow`. Relatedly, do not let a seeded e2e fixture stand in for the REAL producer of a NEW contract (the `aif` evidence manifest "passed" e2e while being unproducible through the real runner because the e2e seeded the artifacts) — exercise the real producer at least once.

6. **Codify the contract, not the current emission.** A test that asserts "the shape the code currently returns" cements drift. When the contract lives in docs or another module (`classifyRecover`, `assertEvidenceReady`, OpenAPI), assert against THAT, with the EXACT DTO shape (object vs string array; no extra keys) — a route test asserting a field is ABSENT (`expect(body.files).toBeUndefined()`) is a tripwire: when it flips to presence, the matching OpenAPI schema is a required edit in the same commit.

7. **Vacuous-pass guard.** A test asserting "did NOT happen" (not crashed, not quarantined, no supersede) MUST also assert the path was actually exercised (e.g. `candidates >= 1`) so it cannot pass on an empty/short-circuited run. A bounded-query/N+1 test must seed ENOUGH rows to trip a per-run loop (8 runs, not 1).

8. **Concurrency tests must hit the lock branch.** A Postgres-only branch (`isPostgres()` + `FOR UPDATE`/CAS) silently skips unless `process.env.DB_URL` points at the testcontainer in `beforeAll`; the contention contract (409-vs-500) needs TWO racers, not a single-threaded test. Env-var fixtures must capture-and-restore (`originalDbUrl = process.env.DB_URL`; in `afterAll`, `delete` only when originally `undefined`, else restore) — an unconditional `delete` corrupts a pre-existing value.

9. **Probe the host before deferring; mind the vitest realm + glob.** Before deferring a Testcontainers lane as "unrunnable here," probe the HOST with the sandbox disabled (`docker info` against `~/.docker/run/docker.sock`) — "no container runtime" is usually a sandbox limit, not a host one. `vi.resetModules()` + a dynamically-imported SUT breaks `instanceof MaisterError` (fresh module realm) → status maps to 500 instead of 409. `.integration.test.ts` is for real external deps only; a pure-function test belongs in the unit project — after renaming across the unit/integration glob boundary, re-run BOTH projects and confirm per-project counts shifted (a file matching neither glob runs nowhere).

The verify report MUST state, for each applicable gate, the production call site / parse path / exact count / bare-exit-code check / real-executor effect it confirmed. A gate skipped is an automatic warning; a confirmed false-green (dead validation, literal-fed schema test, piped exit code hiding red, mock-asserted dispatch, vacuous "did-not-happen" test) is a blocking finding.

### ADR / migration numbers and journal integrity — re-grep main's HEAD at merge, never trust a checkbox
**Source**: 2026-06-07-20.16, 2026-06-09-18.47, 2026-06-11-09.20, 2026-06-11-12.51, 2026-06-10-23.57, 2026-06-09-20.30
**Rule**: ADR numbers and Drizzle migration `idx`/`tag` are a globally-sequential shared namespace, so a collision is invisible on a single branch (every gate green). Before declaring verify pass on a branch that adds an ADR or migration:
- Re-grep `git show main:docs/decisions.md | grep "^### ADR-"` AND `git show main:web/lib/db/migrations/meta/_journal.json` for the claimed numbers — immediately before merge AND again every time main moves. A `[x]` checkbox or commit subject is NOT evidence the ADR/migration landed (a Task marked `[x]` "write ADR-063" shipped with the ADR silently omitted).
- Verify each migration number against the JOURNAL, not the prose (`0029` documented in 5 places shipped as `0030`).
- `pnpm validate:docs` only parses Mermaid; `validate-docs-adr-anchors.mjs` only checks an anchor RESOLVES, not that the visible `[ADR-NNN]` link text matches the `#adr-NNN-…` slug it targets — an over-reached `[ADR-072](#adr-071-…)` passes green. Verify link-text↔slug agreement manually.
- Keep/confirm a `migration-journal-integrity` test asserting every tag↔file, unique `idx`, unique `tag` (Drizzle's `readMigrationFiles` ignores `idx`, iterates by array order, resolves `${tag}.sql`, dedups by `when` — so a reserved idx-gap is safe but an orphan/dup tag is not).
