# Project Rules for /aif-verify

> Curated from review pass-through findings.
> Sections under "Auto-generated rules" are managed by `/aif-evolve`; do not hand-edit them.
> Last updated: 2026-05-28
> Based on: 2 adversarial-review pass-throughs (M6 / 2026-05-28, M7 / 2026-05-28)

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
