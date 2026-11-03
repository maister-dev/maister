# Final integration corrections

The frozen integration run at `801c8f1b1` completed with 615 passing, 39 failing
and two optional-load suites skipped. Its 169 error records are indexed in
`/private/tmp/maister-web-full-integration-final-failures.json`. No source changed
during that run. Cleanup found no process leaks and reaped one test database;
the failed teardown remains a defect to correct, not a green cleanup result.

## Required corrections

- [x] Remove eager consensus-registry construction across the demonstrated import
  cycle; preserve registry composition and the unchanged bounded-output and
  consensus behavior checks.
- [ ] Update native fault fixtures to prove and signal the actual adapter through
  its registered gate/group; retain process birth, invocation and scope checks.
  Cover detached groups after fixture-parent death and preserve zero-survivor
  assertions before containment cleanup.
- [ ] Update real HTTP launch and method-discriminated adapter-log fixtures to
  the current contracts; preserve stable keys, actual preview/receipt behavior,
  exact effect counts, restart windows and replay assertions.
- [x] Persist real active assignments and project genuine canonical lifecycle
  events in scripted result fixtures; do not bypass finalization or integrity.
- [x] Repair the scoped session-probe fixture and its false-positive network
  assertion. Replace duplicated generic race claims with actual reconcile and
  scheduler/Recover entry checks against the existing shared serializer.
- [ ] Declare current writers on current-schema test connections, retain
  historical-upgrade evidence, and provide explicit flag provenance. Repair
  remaining service/evaluation/GC fixtures or proven production defects without
  weakening admission, process-quiescence or immutable-input protections.
- [ ] Run all affected suites to completion, recheck the complete frozen Web
  integration/browser gates, static checks and contracts, and close the remaining
  seven implementation-plan tasks only after their acceptance checks pass.

The branch's merge base is `cb183968d`; local master independently advanced to
`ee8a62553` (guardrail/checkpoint semantics). No migration/ADR collision was
found. That commit is not integrated or qualified by these branch runs; the
user's no-merge/no-deploy boundary remains in force.
