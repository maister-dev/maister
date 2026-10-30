# Project configuration persistence traceability

Status: Implemented. Each requirement and edge resolves to an executed primary owner; the implementation plan records qualification receipts and their source boundaries.

| Requirement | Contract | Tasks | Primary test | Status |
| --- | --- | --- | --- | --- |
| CPC-01 | [Expectation](project-config-persistence.md#expectations) | T2.1, T7.1 | IT-CPC-01 parameter table | Implemented |
| CPC-02 | [Expectation](project-config-persistence.md#expectations) | T4.1, T6.1, T9.1 | IT-CPC-02; E2E-CPC-02 for durable entry wiring | Implemented |
| CPC-03 | [Expectation](project-config-persistence.md#expectations) | T3.1, T9.1 | IT-CPC-03; E2E-CPC-03 for last-observed presentation | Implemented |
| CPC-04 | [Expectation](project-config-persistence.md#expectations) | T3.1, T4.1, T6.1, T9.1 | IT-CPC-04; E2E-CPC-02 for review-before-submit | Implemented |
| CPC-05 | [Expectation](project-config-persistence.md#expectations) | T2.1, T6.1, T9.1 | IT-CPC-05 with local bare remote | Implemented |
| CPC-06 | [Expectation](project-config-persistence.md#expectations) | T3.1, T7.1, T8.1 | IT-CPC-01 and IT-CPC-02, shared rather than duplicated | Implemented |
| CPC-07 | [Expectation](project-config-persistence.md#expectations) | T3.1 | IT-CPC-07 preservation/refusal table | Implemented |
| CPC-08 | [Expectation](project-config-persistence.md#expectations) | T4.1, T14.1 | IT-CPC-08 guarded-seam table | Implemented |
| CPC-09 | [Expectation](project-config-persistence.md#expectations) | T2.1, T4.1, T6.1, T14.1 | IT-CPC-09 stale/idempotency/authorization table | Implemented |
| CPC-10 | [Expectation](project-config-persistence.md#expectations) | T2.1, T4.1, T5.1, T6.1, T14.1 | IT-CPC-10 process/DB-loss table; IT-CPC-05 for push windows | Implemented |
| CPC-11 | [Expectation](project-config-persistence.md#expectations) | T7.1, T8.1 | IT-CPC-11 registration/execution table; retained owning pin/launch regressions | Implemented |
| CPC-12 | [Expectation](project-config-persistence.md#expectations) | T1.1, T13.1, T10.1, T2.1, T14.1, T3.1, T4.1, T5.1, T6.1, T7.1, T8.1, T9.1, T11.1, T12.1 | CT-CPC-12 contract/schema gate plus the owning IT/E2E reports | Implemented |
| EDGE-CPC-01 | [Edge case](project-config-persistence.md#edge-cases) | T3.1 | IT-CPC-03/07 | Implemented |
| EDGE-CPC-02 | [Edge case](project-config-persistence.md#edge-cases) | T2.1, T7.1 | IT-CPC-01 | Implemented |
| EDGE-CPC-03 | [Edge case](project-config-persistence.md#edge-cases) | T3.1 | IT-CPC-07 | Implemented |
| EDGE-CPC-04 | [Edge case](project-config-persistence.md#edge-cases) | T4.1, T14.1 | IT-CPC-08 | Implemented |
| EDGE-CPC-05 | [Edge case](project-config-persistence.md#edge-cases) | T3.1, T4.1 | IT-CPC-08/09 | Implemented |
| EDGE-CPC-06 | [Edge case](project-config-persistence.md#edge-cases) | T2.1, T3.1, T9.1 | IT-CPC-09/03 | Implemented |
| EDGE-CPC-07 | [Edge case](project-config-persistence.md#edge-cases) | T2.1, T4.1, T6.1 | IT-CPC-09/02 | Implemented |
| EDGE-CPC-08 | [Edge case](project-config-persistence.md#edge-cases) | T6.1 | IT-CPC-09 and actual-response schema samples | Implemented |
| EDGE-CPC-09 | [Edge case](project-config-persistence.md#edge-cases) | T2.1 | CT-CPC-12 migration portion | Implemented |
| EDGE-CPC-10 | [Edge case](project-config-persistence.md#edge-cases) | T14.1, T4.1 | IT-CPC-10 concurrency portion | Implemented |
| EDGE-CPC-11 | [Edge case](project-config-persistence.md#edge-cases) | T4.1 | IT-CPC-10 preparation portion | Implemented |
| EDGE-CPC-12 | [Edge case](project-config-persistence.md#edge-cases) | T4.1 | IT-CPC-10 publication portion | Implemented |
| EDGE-CPC-13 | [Edge case](project-config-persistence.md#edge-cases) | T6.1 | IT-CPC-05 | Implemented |
| EDGE-CPC-14 | [Edge case](project-config-persistence.md#edge-cases) | T4.1, T6.1 | IT-CPC-10/09 | Implemented |
| EDGE-CPC-15 | [Edge case](project-config-persistence.md#edge-cases) | T2.1, T4.1, T5.1 | IT-CPC-10 | Implemented |
| EDGE-CPC-16 | [Edge case](project-config-persistence.md#edge-cases) | T8.1 | IT-CPC-11 | Implemented |
| EDGE-CPC-17 | [Edge case](project-config-persistence.md#edge-cases) | T7.1, T8.1 | IT-CPC-11 plus existing launch/pin owners | Implemented |
| EDGE-CPC-18 | [Edge case](project-config-persistence.md#edge-cases) | T3.1 | IT-CPC-07 local-coordinate portion | Implemented |
| EDGE-CPC-19 | [Edge case](project-config-persistence.md#edge-cases) | T3.1, T6.1 | IT-CPC-04/07 plus actual-response schema samples | Implemented |
| EDGE-CPC-20 | [Edge case](project-config-persistence.md#edge-cases) | T9.1 | E2E-CPC-02; E2E-CPC-03; E2E-CPC-04 | Implemented |

## Primary boundary owners

| Boundary | Runnable owner | Evidence asserted |
| --- | --- | --- |
| Runtime package mutations | [Package API integration](../../web/app/api/__tests__/projects-packages-routes.integration.test.ts) | Attach, upgrade, downgrade and detach change runtime rows while manifest, HEAD, index entries and complete status remain identical; DB-only CLI preflight has no partial effects. |
| Both runner setters | [Runner export integration](../../web/app/api/projects/[slug]/settings/__tests__/config-export.integration.test.ts) | SET/CLEAR/SET, monotonic export revision, same-value and DB-only exceptions, unchanged Git state and typed active-publication conflicts. |
| Missing-manifest registration | [Real source registration](../../web/app/api/__tests__/projects-register-clone.integration.test.ts) | Clone, local and new-empty modes create no manifest and retain clean Git state; present-invalid refusal and source identity stay enforced. |
| Registration compatibility | [Registration saga](../../web/app/api/__tests__/projects-register.integration.test.ts), [package bootstrap](../../web/app/api/__tests__/projects-register-packages.integration.test.ts) | Name/key/default precedence, owner membership, compensation and existing manifest package materialization. |
| Status and source projection | [Publication observations](../../web/lib/project-config-persistence/__tests__/publication.integration.test.ts), [portfolio read model](../../web/lib/queries/__tests__/portfolio.integration.test.ts) | Committed semantic comparison independent of path, unverified portfolio status, source refusals and complete private diff boundaries. |
| YAML transformation | [Manifest transformation cases](../../web/lib/packages/__tests__/yaml-writeback.test.ts) | Comments, source-only sections, SET/CLEAR, defaults, ordering, CRLF/UTF-8, limits and unsafe-structure refusal. |
| Dedicated commit and forward recovery | [Git publication integration](../../web/lib/project-config-persistence/__tests__/git-publication.integration.test.ts) | First/repeated/no-op saves, exact commit bytes/path/parent/message, hooks, stale state, unrelated work and prepared/final receipt outages. |
| Ownership and real process death | [Repository ownership](../../web/lib/project-config-persistence/__tests__/repository-lock.integration.test.ts), [owner recovery](../../web/lib/project-config-persistence/__tests__/owner-recovery.integration.test.ts) | Canonical common-directory fencing, live children, deadlines, exact index-lock ownership, ordinary-action retry without a recorded ID, interrupted adoption and competing recoverers, and fresh-process recovery. |
| Separate push | [Push integration](../../web/lib/project-config-persistence/__tests__/push.integration.test.ts) | Reviewed destination/base/range/SHA, original hook policy, known rejection, unknown acknowledgment, restart inspection and local-commit preservation. |
| HTTP and JSON contracts | [Persistence routes](../../web/app/api/__tests__/projects-persist-config.integration.test.ts) | Actual response schema conformance, permissions, actor scope, strict bodies, status/recovery semantics and safe errors. |
| Migration and cleanup | [Persistence DB integration](../../web/lib/db/__tests__/project-config-persistence.integration.test.ts), [workspace GC](../../web/lib/gc/__tests__/workspace-reconciler.integration.test.ts) | Existing-row upgrade, immutable intent and transition constraints, revision guards, causal install/binding races in both orders and acceptance while a writer waits, private cleanup ownership and normal-GC exclusion. |
| Execution and pin compatibility | [Package attachment](../../web/lib/packages/__tests__/attach.integration.test.ts), [launch pinning](../../web/lib/services/__tests__/runs-launch-pin.integration.test.ts) | Existing member revision pins, active-run detach refusal, runtime selection and unchanged historical snapshots, including DB-only project fixtures. |
| User review and recovery | [Authenticated onboarding journeys](../../web/e2e/project-onboarding.spec.ts) | EN/RU, permanent entry, exact review, inert cancel, busy keyboard/duplicate-submit protection, stale reconfirmation, lost-response reload, no-op, rejected/uncertain push, subsequent local saves, banner dismissal and focus/status failures during banner receipt/push review. |

The requirement gate resolves primary IDs from real test titles. The implementation
plan records executed suite receipts and source fingerprints; a matching ID or
coverage row alone does not establish acceptance.
