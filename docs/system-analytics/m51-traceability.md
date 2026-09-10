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
| STG-03 | ADR-169 D2 mapping table | T1.1 | UT-STG-03 | Implemented |
| STG-04 | ADR-169 D2 mapping table | T1.1 | UT-STG-04 | Implemented |
| STG-05 | deriveWorkStage return shape | T1.1 | UT-STG-05 | Implemented |
| STG-06 | WorkStage member list | T1.1 | UT-STG-06 | Implemented |
| STG-07 | DB schema, no work_stage column | T1.1, T3.1 | IT-STG-07 | Implemented |
| STG-08 | getWorkTable batched read model | T2.2, T3.1 | IT-STG-08 | Implemented |
| STG-09 | getVisibleProjectIds | T2.1, T3.2, T3.4 | IT-STG-09 plus E2E-STG-09 | Implemented |
| STG-10 | workStage i18n namespace, EN and RU | T1.2, T3.2 | UT-STG-10 | Implemented |
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
| ATN-09 | activity-feed DTO projection | T2.4, T5.2 | IT-ATN-09 | Planned |
| ATN-10 | user_activity_cursors GREATEST upsert | T5.1, T5.3, T5.8 | IT-ATN-10 plus E2E-ATN-10 | Planned |
| ATN-11 | attention-stream AsyncAPI | T5.5, T5.6 | IT-ATN-11 | Planned |
| ATN-12 | digest read model determinism | T5.4 | UT-ATN-12 | Planned |
| EDGE-ATN-01 | absent cursor row | T5.8 | IT-EDGE-ATN-01 | Planned |
| EDGE-ATN-02 | current-visibility filter, no rewind | T4.2 | IT-EDGE-ATN-02 | Implemented |
| EDGE-ATN-03 | cursor POST clamp and PRECONDITION | T5.3 | IT-EDGE-ATN-03 | Planned |
| EDGE-ATN-04 | lastEventId replay contract | T5.5 | IT-EDGE-ATN-04 | Planned |
| NAV-01 | ADR-171 D1, screens desk.md | T6.3 | E2E-NAV-01 | Planned |
| NAV-02 | ADR-171 D5 landing clause | T6.6 | E2E-NAV-02 | Planned |
| NAV-03 | ADR-171 D2 relocation | T6.1 | E2E-NAV-03 | Planned |
| NAV-04 | railSectionForPathname totality | T3.3, T6.5 | UT-NAV-04 | Planned |
| NAV-05 | ADR-171 D3 inbound-link table | T6.2 | UT-NAV-05 | Planned |
| NAV-06 | server-side route authorization | T6.6 | IT-NAV-06 | Planned |
| EDGE-NAV-01 | Desk empty state | T6.4 | E2E-EDGE-NAV-01 | Planned |
| EDGE-NAV-02 | narrow stacking order | T6.4 | E2E-EDGE-NAV-02 | Planned |
| NTF-01 | ADR-077 outbox reuse, no second outbox | T7.2, T7.5 | IT-NTF-01 | Planned |
| NTF-02 | nullable webhook_events columns, migration 0164 | T7.4 | IT-NTF-02 | Planned |
| NTF-03 | two-axis subscriptionMatches | T7.4 | IT-NTF-03 | Planned |
| NTF-04 | delivery two-phase commit | T7.6 | IT-NTF-04 | Planned |
| NTF-05 | push failure classification table | T7.3, T7.6, T7.10 | IT-NTF-05 | Planned |
| NTF-06 | signing_secret_ref env reference, migration 0163 | T7.1 | IT-NTF-06 | Planned |
| NTF-07 | owner from auth-context, ext subscription CRUD | T7.1, T7.8, T7.10 | IT-NTF-07 | Planned |
| NTF-08 | attention consumer trigger bound | T7.5, T7.7 | IT-NTF-08 | Planned |
| NTF-09 | token scope sets | T4.5, T7.8 | UT-NTF-09 | Planned |
| NTF-10 | VAPID env table and boot degradation | T7.9 | IT-NTF-10 | Planned |
| EDGE-NTF-01 | idempotent consumer handle | T7.5 | IT-EDGE-NTF-01 | Planned |
| EDGE-NTF-02 | 410 Gone terminal path | T7.6 | IT-EDGE-NTF-02 | Planned |
| EDGE-NTF-03 | existing project webhooks unaffected | T7.2 | IT-EDGE-NTF-03 | Planned |

## Acceptance tests beside a primary

Only two requirements carry an end-to-end test **in addition** to their primary. An
acceptance test proves the wiring; the primary proves the logic. Three levels for one
requirement is over-testing.

| Requirement | Primary, the logic | Acceptance, the wiring |
| --- | --- | --- |
| STG-09 | `IT-STG-09` in the read model | `E2E-STG-09` through `/work` |
| ATN-10 | `IT-ATN-10` cursor monotonicity | `E2E-ATN-10` the unread divider |

## Linked artifacts

- [ADR-168](../decisions.md#adr-168) · [ADR-169](../decisions.md#adr-169) · [ADR-170](../decisions.md#adr-170) · [ADR-171](../decisions.md#adr-171) · [ADR-172](../decisions.md#adr-172)
- [`work-stages.md`](work-stages.md) · [`attention.md`](attention.md) · [`home-navigation.md`](home-navigation.md) · [`notifications.md`](notifications.md)
