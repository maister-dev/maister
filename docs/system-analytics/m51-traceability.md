# M51 requirement traceability

Every `STG` / `ATN` / `NAV` / `NTF` requirement and every `EDGE-*` case declared by
the four owning documents, each with the contract that specifies it, the tasks that
enforce it, and the **primary test** that proves it.

The owning documents are
[`work-stages.md`](work-stages.md), [`attention.md`](attention.md),
[`home-navigation.md`](home-navigation.md) and
[`notifications.md`](notifications.md).
`scripts/validate-docs-indexes.mjs` fails when a declared id has no row here, or a
row here has a blank `Primary test` cell.

**The `Primary test` column names real tests, not scenario aliases.** Test ids follow
`UT-` unit, `IT-` integration, `CT-` contract, `E2E-` Playwright, suffixed with the
requirement id. `scripts/validate-m51-coverage.mjs` additionally proves the mapping is
bidirectional: every requirement names at least one task, and every implementation task
in the plan is named by at least one requirement. T8.4 greps each `Primary test` cell
against the suite and fails when a name does not resolve to an executed test — which is
what stops this matrix decaying into the historical aliases the Stage B matrix became.

`Status` stays `Planned` until the owning phase turns the requirement green.

## Requirement traceability

| Requirement | Contract/schema | Enforcement/task | Primary test | Status |
| --- | --- | --- | --- | --- |
| STG-01 | exhaustive satisfies map over RUN_STATUS_VALUES | T1.1 | UT-STG-01 | Implemented |
| STG-02 | pure-module rule, no server-only import | T1.1 | UT-STG-02 | Implemented |
| STG-03 | ADR-170 D2 mapping table | T1.1 | UT-STG-03 | Implemented |
| STG-04 | ADR-170 D2 mapping table | T1.1 | UT-STG-04 | Implemented |
| STG-05 | deriveWorkStage return shape | T1.1 | UT-STG-05 | Implemented |
| STG-06 | WorkStage member list | T1.1 | UT-STG-06 | Implemented |
| STG-07 | DB schema, no work_stage column | T1.1, T3.1 | IT-STG-07 | Implemented |
| STG-08 | getWorkTable batched read model | T2.2, T3.1 | IT-STG-08 | Implemented |
| STG-09 | getVisibleProjectIds | T2.1, T3.2, T3.4 | IT-STG-09 plus E2E-STG-09 | Implemented |
| STG-10 | workStage i18n namespace, EN and RU | T1.2, T3.2 | UT-STG-10 | Implemented |
| STG-11 | terminal task status wins with no run | T8.7 | UT-STG-12 | Implemented |
| EDGE-STG-01 | latest-run selection in the read model | T3.1, T3.4 | IT-EDGE-STG-01 | Implemented |
| EDGE-STG-02 | workspaceRemoved branch | T1.1 | UT-EDGE-STG-02 | Implemented |
| EDGE-STG-03 | no-run triage branch | T1.1 | UT-EDGE-STG-03 | Implemented |
| ATN-01 | getDecisionsQueue single-query contract | T2.3, T2.4, T4.1, T4.4 | IT-ATN-01 | Implemented |
| ATN-02 | inbox_items source_ref activityId join | T4.2 | IT-ATN-02 | Implemented |
| ATN-03 | bounded 24h fallback window | T4.2, T5.1 | IT-ATN-03 | Implemented |
| ATN-04 | blocking-relation exclusion | T4.1 | IT-ATN-04 | Implemented |
| ATN-05 | layout-level counter fan-out | T4.3, T4.4, T5.7 | IT-ATN-05 plus UT-ATN-05 | Implemented |
| ATN-06 | ext pulse telemetry shape | T4.3, T4.5 | CT-ATN-06 | Implemented |
| ATN-07 | decision-queue comparator | T4.1 | UT-ATN-07 | Implemented |
| ATN-08 | ext decisions OpenAPI, ADR-137 omission | T4.5 | IT-ATN-08 | Implemented |
| ATN-09 | activity-feed DTO projection | T2.4, T5.2 | IT-ATN-09 plus UT-ATN-09 | Implemented |
| ATN-10 | user_activity_cursors GREATEST upsert | T5.1, T5.3, T5.8 | IT-ATN-10 plus E2E-ATN-10 | Implemented |
| ATN-11 | attention-stream AsyncAPI | T5.5, T5.6 | IT-ATN-11 | Implemented |
| ATN-12 | digest read model determinism | T5.4 | UT-ATN-12 | Implemented |
| EDGE-ATN-05 | viewer gets no unactionable decisions | T8.7 | IT-ATN-14 | Implemented |
| EDGE-ATN-06 | revocation reaches an open stream | T8.7 | IT-ATN-15 | Implemented |
| EDGE-ATN-07 | work invalidation covers transitions and node progress | T8.8 | IT-ATN-16 | Implemented |
| EDGE-ATN-01 | absent cursor row | T5.3, T5.8 | UT-EDGE-ATN-01 plus IT-ATN-03 | Implemented |
| EDGE-ATN-02 | current-visibility filter, no rewind | T4.2 | IT-EDGE-ATN-02 | Implemented |
| EDGE-ATN-03 | cursor POST clamp and PRECONDITION | T5.3 | IT-EDGE-ATN-03 | Implemented |
| EDGE-ATN-04 | lastEventId replay contract | T5.5 | IT-EDGE-ATN-04 | Implemented |
| NAV-01 | ADR-172 D1, screens desk.md | T6.3 | E2E-NAV-01 | Implemented |
| NAV-02 | ADR-172 D5 landing clause | T6.6 | E2E-NAV-02 | Implemented |
| NAV-03 | ADR-172 D2 relocation | T6.1 | E2E-NAV-03 | Implemented |
| NAV-04 | railSectionForPathname totality | T3.3, T6.5 | UT-NAV-04 | Implemented |
| NAV-05 | ADR-172 D3 inbound-link table | T6.2 | UT-NAV-05 | Implemented |
| NAV-06 | server-side route authorization | T6.6 | IT-NAV-06 | Implemented |
| NAV-07 | header fits 390px, keeps names and toggle | T8.9 | E2E-NAV-07 | Implemented |
| NAV-08 | ADR-174 one object per work item | T6.3 | E2E-NAV-08 | Implemented |
| EDGE-NAV-01 | Desk empty state; composer absent unconditionally (ADR-174) | T6.4 | E2E-EDGE-NAV-01 | Implemented |
| EDGE-NAV-02 | narrow stacking order; columns drop, table does not scroll (ADR-174) | T6.4 | E2E-EDGE-NAV-02 | Implemented |
| NTF-01 | ADR-077 outbox reuse, no second outbox | T7.2, T7.5 | IT-NTF-02 | Implemented |
| NTF-02 | nullable webhook_events columns, migration 01660 | T7.4 | IT-NTF-02 | Implemented |
| NTF-03 | two-axis subscriptionMatches | T7.4 | IT-NTF-03 plus UT-NTF-03 | Implemented |
| NTF-04 | delivery two-phase commit | T7.6 | IT-NTF-04 | Implemented |
| NTF-05 | push failure classification table | T7.3, T7.6, T7.10 | IT-NTF-05 | Implemented |
| NTF-06 | signing_secret_ref env reference, migration 01650 | T7.1 | IT-NTF-07 | Implemented |
| NTF-07 | owner from auth-context, ext subscription CRUD | T7.1, T7.8, T7.10 | IT-NTF-07 | Implemented |
| NTF-08 | attention consumer trigger bound | T7.5, T7.7 | IT-NTF-08 plus UT-NTF-08 | Implemented |
| NTF-09 | token scope sets | T4.5, T7.8 | UT-NTF-09 | Implemented |
| NTF-10 | VAPID env table and boot degradation | T7.9 | UT-NTF-10 | Implemented |
| NTF-11 | push egress policy + pinned send | T8.7 | UT-NTF-11 | Implemented |
| NTF-12 | opt-in creates target and intent, both transports | T8.7 | IT-NTF-16 | Implemented |
| EDGE-NTF-01 | idempotent consumer handle | T7.5 | IT-EDGE-NTF-01 | Implemented |
| EDGE-NTF-02 | 410 Gone terminal path | T7.6 | IT-EDGE-NTF-02 | Implemented |
| EDGE-NTF-04 | 429 retried, not settled dead | T7.6 | IT-EDGE-NTF-04 | Implemented |
| EDGE-NTF-05 | consumer failure split by blast radius | T8.7 | UT-NTF-12 | Implemented |
| EDGE-NTF-03 | existing project webhooks unaffected | T7.2 | IT-EDGE-NTF-03 | Implemented |
| EDGE-NTF-06 | project-less HITL persists, emits nothing | T8.8 | IT-NTF-15 | Implemented |

## Second-level tests beside a primary

A handful of requirements carry a second test **in addition** to their primary,
always because the second one asserts something the first structurally cannot
see. Three levels for one requirement is over-testing; two on different axes is
not.

| Requirement | Primary | Second level, and what it adds |
| --- | --- | --- |
| STG-09 | `IT-STG-09` in the read model | `E2E-STG-09` through `/work` — the wiring |
| ATN-10 | `IT-ATN-10` cursor monotonicity | `E2E-ATN-10` the unread divider — the wiring |
| NTF-08 | `IT-NTF-14` the sweep backstop emits a delta with no domain event at all | `IT-NTF-15` the two decision-OPENING events, plus `UT-NTF-13` that `createHitlRequest` is the only writer of `hitl_requests`. The backstop proves completeness, the events prove latency; neither test can see the other's property |
| NAV-01 | `E2E-NAV-01` the Desk renders | `UT-NAV-01` it COMPOSES — every region goes through the owning surface's component, and the narrow stacking order is fixed in the source. Invisible to a browser assertion |
| NAV-02 | `E2E-NAV-02` two sign-ins land apart | `UT-NAV-02` the fork is `role !== "admin"`, so a **viewer** is covered by the same branch as a member |
| NAV-03 | `E2E-NAV-03` the seeded portfolio at `/projects` | `UT-NAV-03` the empty-state and onboarding branches moved too — unreachable in a browser, because the shared e2e database always has projects |

## Linked artifacts

- [ADR-169](../decisions.md#adr-169) · [ADR-170](../decisions.md#adr-170) · [ADR-171](../decisions.md#adr-171) · [ADR-172](../decisions.md#adr-172) · [ADR-173](../decisions.md#adr-173)
- [`work-stages.md`](work-stages.md) · [`attention.md`](attention.md) · [`home-navigation.md`](home-navigation.md) · [`notifications.md`](notifications.md)
