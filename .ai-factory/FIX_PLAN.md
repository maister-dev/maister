# Final integration corrections

## Post-rebase review corrections

Master remains `ee8a6255331a5a7250f29fe9676f9f09a3450c9f`, verified again
through GitHub on 2026-11-06. The branch is rebased. At frozen `aab070c39`,
complete Web unit passes 887 files / 9244 tests; types, all changed Web lint,
complete docs/ERD and contracts pass. The latest combined browser lane completed
all 29 cases: 26 passed, three failed, no unrun cases or leaks. Full Web
integration remains pending until these failures are resolved.

- [x] R1: preserve native stdout synchronously before asynchronous spool open;
  retain the real-child exit/spool barrier regression and bounded buffering.
- [x] R2: revalidate the automatic arm for queued bearer-origin standalone
  agents; keep the separately authorized server-source exception.
- [x] R3: expose current failed Triager source details and the authorized Run
  link on all task controls; infer pre-model failure only from explicit false.
  Extend the existing manual-launch journey with real keyboard/focus actions.
- [x] R4: align the plan, admission analytics and AsyncAPI comments with the
  explicit JSON `202 launch_pending` union; distinguish storage uncertainty.
- [x] R5: retain primary probe/preparation errors through secondary close,
  publication, capture and release failures. Keep pending/fenced control flow,
  safe correlated secondary diagnostics and real cleanup-only refusals.
- [x] R6: extend the actual-Supervisor Triager case through machine assessment
  publication and the real automatic job to the selected delivery-Flow intent.
- [x] R7: serialize HITL restart and create-ACK projection with consistent
  Run-before-attempt ownership; reproduce the actual PostgreSQL lock inversion.
  Determine P4's precise failing assertion separately; retain valid stale 409s.
- [x] R8: preserve explicit noncancelled ACP responses during concurrent
  checkpointing. Correct only the seven obsolete interruption fixtures to
  strict typed CHECKPOINT diagnostics; retain real completion/error controls.
- [x] R9: compare every historical command field across migration 0227 and
  explicitly require its new nullable private context to remain NULL.
- [x] R10: use neutral EN/RU Run preparation copy when historical model
  execution is possible; retain the explicitly proven Task pre-model notice.
- [ ] R11: materialize the delegated browser Flow bundle from its stored
  definition and observe its exact immutable child-intent Run bindings.
- [x] R12: wait for actual bound recursive Flow children before inspecting
  descendants; retain exact counts, parent proof, result and wake assertions.
- [x] R13: assert the browser fault's proven baseline Git stage and safe cause,
  retaining zero model commands/assessments and actionable neutral Run copy.

P4's complete six-case owner passes with exact cleanup. The latest browser
failures are: one delayed second delegated-Flow binding; an M38 accepted intent
that bound after the test deadline, before routing was exercised; and recursive
research children that failed although all four agent grandchildren completed.
Safe snapshots and traces remain under `/private/tmp/maister-e2e-aab070c39-*`.
Their causes are not established by ordering alone. Manual PR delivery, RU
keyboard/queued launch, optional assessment and Triager automatic delivery,
Stop/cleanup and real baseline Git-failure diagnostics passed in this lane.

All fixes require focused RED/GREEN evidence where behavior changes, complete
required gates, independent review and local phase commits. No production or
historical repair is part of these corrections.

## Completed pre-rebase corrections

The original review's origin-authority, native adapter identity, HTTP receipt,
canonical browser observer, queued-child obligation, finite rotated-token grant,
writer-capability, genuine lifecycle and scoped-probe corrections are implemented
and independently reviewed. Their focused regressions pass; the failed earlier
broad checkpoints are superseded only by the final complete frozen gates below.
No required assertion is skipped, quarantined or weakened.

- [x] R14: classify unavailable immutable asset bytes through existing typed
  launch refusals, preserving internal causes and safe public responses. The
  complete Flow owner passes 7/7; the finite capability/agent sibling audit passes 42/42 with exact cleanup and independent review.
- [x] R15: preserve the optional assessment draft and exact uncertain submission
  across closing/reopening; reset only after known success or an explicit safe
  decision. Keep existing validation and focus behavior.
- [x] R16: preserve the explicitly selected batch retry subset when refreshing
  its runner-dependent preview; a fresh eligibility result cannot reselect work. Preserve loaded later pages and send the selected runner on every pagination request.
- [x] R17: align the external failed-qualifier schema with the real nullable
  source projection and its Web counterpart; preserve neutral/proven distinctions
  and accurate continuation-preparation diagnostic descriptions.
- [ ] R18: reproduce and resolve pending-launch wake/deadline ownership using
  existing durable claims and capacity protection. Establish exact queue owners;
  do not mask the observed binding delay with larger test timeouts.
- [ ] R19: establish the recursive intermediate-child failure cause and fix its
  real producer/consumer boundary; retain exact child results and completion
  semantics, without accepting failed children as successful test outcomes.
- [ ] R20: reproduce and fence late human/form-only Flow traversal after legal
  abandonment. This source gap also exists on master; the new worker exposed the
  teardown overlap. Distinguish persisted late effects from the misleading
  Crashed log, preserve no-ACP execution and legacy compatibility, and do not hide
  a real race by delaying fixture cleanup.
- [ ] R21: distinguish canonical UUID.json controlled-supervisor session records
  from typed diagnostic sidecars in every browser reader. Refuse malformed
  canonical records and identity mismatches; preserve original runner and
  qualification assertions. Preserve a safe manifest before removing only the
  five verified sidecars left by the earlier diagnostic invocation. The focused
  filesystem contract must show RED/GREEN, followed by the coordinated browser
  qualification without weakening session data checks.
- [ ] R22: keep the manual Launch opener unavailable in server-rendered markup
  and throughout hydration until its client interaction handlers are ready.
  Reuse the existing client-readiness hook; this changes no launch authority,
  assessment policy, settings or normal confirmation behavior. In the existing
  bound-agent browser journey, inspect the actual SSR opener in a scoped
  authenticated JavaScript-disabled browser context, require it to be disabled,
  and close that context in `finally`. In the normal interactive context,
  require one enabled click to open the dialog and load its real options.
  Keyboard journeys must await the opener's enabled state before focusing it,
  retaining actual focus, Enter and focus-restoration checks. No launch POST
  may occur before the intentional
  confirm action; preserve all existing immutable settings and Run-binding
  assertions. Reproduce the enabled inert SSR button before the source fix;
  no retry-click, arbitrary wait or timeout increase substitutes for readiness.
- [ ] R23: give the E2E wrapper sole destructive teardown ownership. Playwright
  global teardown must not remove Git repositories while its Web plugin still
  runs. After physical invocation-process quiescence, clean linked worktrees
  through their still-existing parent repositories before removing registered
  fixture roots; recheck quiescence before root removal. Reuse the existing
  invocation release/reclaimer seam, retain original and cleanup failures, and
  always reach database teardown. The R22 focused browser already reproduced
  `ENOTEMPTY` in `e2e-agents/.git/info`, followed by missing Git metadata; a
  passed test body with failed cleanup is not a qualified lane. Cover the
  ordered real-Git cleanup and a callback introducing a live owned process,
  then verify the focused browser exits with zero cleanup errors before the
  complete coordinated browser lane. No delays, swallowed filesystem failures,
  capacity changes or weakened assertions substitute for lifecycle ownership.
- [ ] Complete the frozen combined 29-case browser lane, complete configured Web
  integration, static checks and final review; close the remaining seven plan
  tasks only after their acceptance checks pass, then remove this fix plan.

The branch remains based on verified current master `ee8a62553`. No remote
mutation, production reproduction, historical repair, merge or deployment is
part of this work.
