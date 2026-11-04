# Final integration corrections

## Post-rebase review corrections

Master remains `ee8a6255331a5a7250f29fe9676f9f09a3450c9f`, verified again
through GitHub on 2026-11-04. The requested branch is rebased at `abb4578d0`.
Its frozen integration gate completed with 651 passing, three failing and two
optional-load files skipped; 5841 tests passed and twelve failed. Exact cleanup
completed without errors. The reviewed corrections were prepared separately
and transferred back with matching hashes for all 45 changed files. Final P4,
browser and complete Web qualification remain pending.

- [x] R1: preserve native stdout synchronously before asynchronous spool open;
  retain the real-child exit/spool barrier regression and bounded buffering.
- [x] R2: revalidate the automatic arm for queued bearer-origin standalone
  agents; keep the separately authorized server-source exception.
- [ ] R3: expose current failed Triager source details and the authorized Run
  link on all task controls; infer pre-model failure only from explicit false.
  Extend the existing manual-launch journey with real keyboard/focus actions.
- [x] R4: align the plan, admission analytics and AsyncAPI comments with the
  explicit JSON `202 launch_pending` union; distinguish storage uncertainty.
- [x] R5: retain primary probe/preparation errors through secondary close,
  publication, capture and release failures. Keep pending/fenced control flow,
  safe correlated secondary diagnostics and real cleanup-only refusals.
- [x] R6: extend the actual-Supervisor Triager case through machine assessment
  publication and the real automatic job to the selected delivery-Flow intent.
- [ ] R7: serialize HITL restart and create-ACK projection with consistent
  Run-before-attempt ownership; reproduce the actual PostgreSQL lock inversion.
  Determine P4's precise failing assertion separately; retain valid stale 409s.
- [x] R8: preserve explicit noncancelled ACP responses during concurrent
  checkpointing. Correct only the seven obsolete interruption fixtures to
  strict typed CHECKPOINT diagnostics; retain real completion/error controls.
- [x] R9: compare every historical command field across migration 0227 and
  explicitly require its new nullable private context to remain NULL.

All fixes require focused RED/GREEN evidence where behavior changes, complete
required gates, independent review and local phase commits. No production or
historical repair is part of these corrections.

The frozen integration run at `801c8f1b1` completed with 615 passing, 39 failing
and two optional-load suites skipped. Its 169 error records are indexed in
`/private/tmp/maister-web-full-integration-final-failures.json`. No source changed
during that run. Cleanup found no process leaks and reaped one test database;
the failed teardown remains a defect to correct, not a green cleanup result.

## Required corrections

- [x] Remove eager consensus-registry construction across the demonstrated import
  cycle; preserve registry composition and the unchanged bounded-output and
  consensus behavior checks.
- [ ] Validate interactive launch origins against the configured public authority
  or actual HTTP Host, preserving strict Origin/Host parsing, cross-site refusal,
  abstract Request compatibility and all existing principal checks. The native
  custom server supplies an internal wildcard URL and a distinct public Host.
  Apply that boundary to retry/recovery and the complete fresh project-agent
  launch route, including operational/taskless requests; retain before-effect
  cross-origin refusal and authenticated positive coverage.
- [ ] Update native fault fixtures to prove and signal the actual adapter through
  its registered gate/group; retain process birth, invocation and scope checks.
  Cover detached groups after fixture-parent death and preserve zero-survivor
  assertions before containment cleanup.
- [ ] Update real HTTP launch and method-discriminated adapter-log fixtures to
  the current contracts; preserve stable keys, actual preview/receipt behavior,
  exact effect counts, restart windows and replay assertions.
- [ ] Migrate the eight stale browser launch observers to canonical intent
  receipts and exact eventual Run bindings. Preserve truthful queued/null-Run
  capacity behavior and actionable strict-enforcement refusal; do not replace
  the latter with a generic held-state assertion.
  Frozen browser run `94381c8fc` finished 19 passed, eight failed and two serial
  cases not run, with exact invocation cleanup reporting zero leaks. Correct
  the four explicit-Origin test callers, the shared delegation peer's stable
  operation key, the obsolete executor-versus-platform runner ID assertion and
  the M11c preview failure after establishing its real filesystem cause.
- [ ] Reproduce and correct parent waiting for accepted execution-child intents
  that have no Run yet. Include queued/preparing/held obligations through Flow
  and agent coordinator wake/recovery, deduplicate bound Runs, retain terminal
  failure/cancellation outcomes and leave live fanout capacity semantics intact.
  The actual `/delegate` 202/null-Run → real Flow driver regression ended in
  Review instead of WaitingOnChildren. Serialize final parent completion with
  child acceptance, retain bounded structured outcome observations across
  restart, and acknowledge only the exact immutable owned prompt context.
  Free-form prompt delimiters cannot establish an observation.
  Internal token rotation must retire its bearer while retaining only an exact
  already-accepted child grant. Add server-owned token binding/revocation
  provenance without historical backfill; explicit revocation still holds the
  accepted work. The migration and stored-dispatch validator must not create a
  reusable fresh-acceptance capability or weaken live token verification.
- [x] Persist real active assignments and project genuine canonical lifecycle
  events in scripted result fixtures; do not bypass finalization or integrity.
- [x] Repair the scoped session-probe fixture and its false-positive network
  assertion. Replace duplicated generic race claims with actual reconcile and
  scheduler/Recover entry checks against the existing shared serializer.
- [x] Declare current writers on current-schema test connections, retain
  historical-upgrade evidence, and provide explicit flag provenance. Repair
  remaining service/evaluation/GC fixtures or proven production defects without
  weakening admission, process-quiescence or immutable-input protections.
- [ ] Run all affected suites to completion, recheck the complete frozen Web
  integration/browser gates, static checks and contracts, and close the remaining
  seven implementation-plan tasks only after their acceptance checks pass.

The user requested fixing, then rebasing onto current master, then reviewing
all changes again. GitHub's current master was verified as `ee8a62553` through
its API after SSH fetch authentication failed; local master has that exact
object. Preserve its guardrail/checkpoint changes during the authorized local
rebase. Final validation and review must use the rebased branch. No push,
deployment, production reproduction or historical repair is authorized.
