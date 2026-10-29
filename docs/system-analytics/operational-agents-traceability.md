# Operational agent traceability

**Implemented.** Primary tests carry the IDs below and are discovered by the
normal runners. Local qualification evidence is recorded in the implementation plan;
full regression/release aggregation is separate from feature implementation.
The [implementation plan](../../.ai-factory/plans/feature-operational-agent-kind.md)
owns task execution; the three operational analytics own requirements.

| ID | Contract | Tasks | Primary test | Status |
| --- | --- | --- | --- | --- |
| OPA-01 | Definition axes and registry symmetry | T4,T6,T15 | IT-OPA-01 | Implemented |
| OPA-02 | Legacy/default code-delivery behavior | T4,T8,T9 | IT-OPA-02 | Implemented |
| OPA-03 | Independent permissions/isolation/admission | T5,T6,T10 | IT-OPA-03 | Implemented |
| OPA-04 | Frozen launch contract through update/continuation | T4,T6,T8 | IT-OPA-04 | Implemented |
| OPA-05 | Both intake variants share the result contract | T16,T18 | IT-OPA-05 | Implemented |
| OPA-06 | Authoring/API/MCP/UI/package parity | T4,T5,T13,T14,T15,T17,T18 | IT-OPA-06 | Implemented |
| OPA-07 | Preserving migration and new-state constraints | T4 | IT-OPA-07 | Implemented |
| OPR-01 | Done without delivery, including zero work | T8,T13,T16 | IT-OPR-01 | Implemented |
| OPR-02 | Fixed structured value and semantic validation | T4,T7,T8,T16 | IT-OPR-02 | Implemented |
| OPR-03 | Terminal mapping, atomicity and wake/slot signals | T8 | IT-OPR-03 | Implemented |
| OPR-04 | Durable effective outcome and failure diagnostics | T8,T13 | IT-OPR-04 | Implemented |
| OPL-01 | Terminal active-copy departure | T11,T12,T13 | IT-OPL-01 | Implemented |
| OPL-02 | Actionable history and per-reader attention | T13,T14,T15 | IT-OPL-02 | Implemented |
| OPL-03 | Concurrent requests and explicit question HITL | T6,T10 | IT-OPL-03 | Implemented |
| OPL-04 | Source-integrity enforcement and delivery refusal | T7,T8,T9 | IT-OPL-04 | Implemented |
| OPL-05 | Preserve-first owned cleanup in all cleaner families | T11 | IT-OPL-05 | Implemented |
| OPL-06 | Cancellation/crash/checkpoint/new-attempt semantics | T10,T11,T12 | IT-OPL-06 | Implemented |
| OPL-07 | Evidence lifetime independent of disposal | T12 | IT-OPL-07 | Implemented |
| OPL-08 | Bounded fair fenced cleanup with invalidation | T11,T14 | IT-OPL-08 | Implemented |
| EDGE-OPA-01 | Update/detach while Pending/parked | T6 | IT-EDGE-OPA-01 | Implemented |
| EDGE-OPA-02 | Unsupported binding/profile/contract | T5 | IT-EDGE-OPA-02 | Implemented |
| EDGE-OPA-03 | Seeded historical upgrade | T4 | IT-EDGE-OPA-03 | Implemented |
| EDGE-OPA-04 | Zero-flow compatibility and registry clear | T5 | IT-EDGE-OPA-04 | Implemented |
| EDGE-OPR-01 | Created task before receipt failure | T8 | IT-EDGE-OPR-01 | Implemented |
| EDGE-OPR-02 | Missing/malformed/oversize/unsafe result | T8 | IT-EDGE-OPR-02 | Implemented |
| EDGE-OPR-03 | Count/coverage/outcome contradiction | T8 | IT-EDGE-OPR-03 | Implemented |
| EDGE-OPL-01 | Parallel requests/checkpoint | T10 | IT-EDGE-OPL-01 | Implemented |
| EDGE-OPL-02 | Lost input acknowledgement and ownership | T10 | IT-EDGE-OPL-02 | Implemented |
| EDGE-OPL-03 | Terminal cancellation/crash race | T8 | IT-EDGE-OPL-03 | Implemented |
| EDGE-OPL-04 | Source/materialization/symlink/probe refusal | T7 | IT-EDGE-OPL-04 | Implemented |
| EDGE-OPL-05 | Preserve/delete/record/release crash windows | T11 | IT-EDGE-OPL-05 | Implemented |
| EDGE-OPL-06 | Expired lease/poison/exhaustion | T11 | IT-EDGE-OPL-06 | Implemented |
| EDGE-OPL-07 | Immediate cleanup/evidence/global archive push | T12 | IT-EDGE-OPL-07 | Implemented |
| EDGE-OPL-08 | Per-reader revision ack and same-count invalidation | T14 | IT-EDGE-OPL-08 | Implemented |
