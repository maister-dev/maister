# Project Rules for /aif-plan

> Curated from review pass-through findings.
> Sections under "Auto-generated rules" are managed by `/aif-evolve`; do not hand-edit them.
> Last updated: 2026-05-28
> Based on: 1 adversarial-review pass-through (M6 / 2026-05-28)

## Rules

### Plan MUST enumerate deployment touchpoints
**Source**: M6 adversarial review pass-through (2026-05-28)
**Rule**: For every task that introduces a new env var, config file path, sidecar binary, bound port, or host-mounted file, the plan MUST include a dedicated "Deployment wiring" task in the same phase (or a clearly named follow-up). That task touches the deployment artifacts: `Dockerfile`, `compose.yml`, `compose.override.yml`, `compose.production.yml`, `.env.example`. The task's acceptance criteria explicitly call out which file each new dep lands in.

If runtime wiring is deliberately deferred (e.g. "CCR is dev-only on POC"), the plan MUST include an explicit "Not yet supported in Docker — enable in Phase X by …" doc task that updates `docs/getting-started.md` AND the relevant `docs/configuration.md` section. Silent dev/prod skew is not an option — either wire it or document the gap.

Concrete checklist to apply at plan-write time:

| If the plan adds … | The plan MUST include a task that touches … |
| ------------------ | -------------------------------------------- |
| A new env var the web or supervisor reads | `.env.example` + the relevant service's `environment:` block in `compose.yml` (+ prod overlay if production-relevant) |
| A new config file read at runtime | A bind mount or named volume on the consuming service in compose + a `.env.example` toggle for the host path if it's tunable |
| A new sidecar process spawned by web or supervisor | Dep listed in the consuming `package.json` + lockfile commit + smoke check that the binary is on PATH inside the container |
| A new bound port | Port mapping on the service in compose (if externally reachable) + collision check against the existing service set |

Reason: M6 added `router=ccr` end-to-end in code, including new env vars and a new sidecar daemon, but the compose files were untouched. The shipped runtime cannot exercise the feature, and the gap surfaced only at adversarial review.

### Plan MUST trace every contract surface to its spec file
**Source**: M6 adversarial review pass-through (2026-05-28)
**Rule**: Separate from "what narrative docs to update", the plan's docs phase MUST list every external-facing CONTRACT surface that changes and the spec file that names it. The plan is the place to enumerate this so the implementation phase has an explicit checklist — `/aif-verify` then re-derives the same list from the diff as a cross-check.

Surfaces to enumerate (the right side names the spec file by default; add others as the project grows):

| Surface | Default spec location |
| ------- | --------------------- |
| HTTP route added/changed (path, method, status codes, body shape) | `docs/api/<service>.openapi.yaml` + the prose contract doc (e.g. `docs/supervisor.md` for the supervisor) |
| Wire field changing semantics (e.g. from "reserved" to "load-bearing") | The same `.openapi.yaml` AND the same prose contract doc — both prose and example payloads need to move |
| SSE / WebSocket event added/changed | `docs/api/async/<channel>.asyncapi.yaml` + the relevant `docs/system-analytics/*.md` |
| New domain error code | `docs/error-taxonomy.md` |
| New env var or config-file path | env-vars table in `docs/configuration.md` (the prose CCR-bundling section is not enough — the table is canonical) AND `.env.example` |
| New DB column / table / index | Drizzle migration + `docs/database-schema.md` + the relevant `docs/db/*.md` ERD |
| New `package.json` script or CLI entry point | `docs/getting-started.md` "Scripts" section + the relevant `CLAUDE.md` slice |
| New Flow DSL step type / mode / field | `docs/flow-dsl.md` + the schema in `web/lib/config.schema.ts` |

Reason: in M6 the `POST /sessions` body field `router: ccr` became load-bearing (could return 503 for missing config / token / health failures), but `docs/supervisor.md` (the supervisor's prose contract doc) was not on the plan's docs list and remained stale. Tracing each surface to a spec file at plan-write time prevents this.

### Plan MUST call out config-state symmetry for YAML→DB persistence tasks
**Source**: M6 adversarial review pass-through (2026-05-28)
**Rule**: For any task that persists a YAML/config field into a DB column (or any other persistent store) that downstream readers consume, the task's acceptance criteria MUST include the round-trip:

1. **SET**: field present in YAML → column equals resolved value.
2. **CLEAR**: field removed from YAML on the next run → column equals the column's default (typically null).
3. **Idempotent re-set**: field re-added → column equals resolved value again.

Both halves are mandatory tests. The plan MUST NOT mark the SET-only test as sufficient and MUST NOT include language that documents the CLEAR-half as "current behavior" or "deferred". An asymmetric write loop (`if (!entry.field) continue`) is a defect; the plan should call it out before implementation, not after.

Reason: M6's `upsertExecutorsFromConfig()` skipped flows without an `executor_override` entry, leaving a stale `flows.executor_override_id` after operator-removal. The integration test then enshrined this stale behavior as "documented" — a defect promoted to contract.

## Auto-generated rules (managed by `/aif-evolve` — do not hand-edit below this line)
