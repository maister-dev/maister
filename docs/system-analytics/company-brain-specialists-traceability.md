# Company Brain and specialist traceability

**Implemented CB0 qualification; CB1 qualification remains open.** Owning requirement text and acceptance compositions are in [qualification](company-brain-specialists-qualification.md); this matrix allocates implementation and primary execution ownership. Planned means no claim of passing behavior. A primary title begins with its cited test ID; several edge cases share one parameterized owner without repeating the oracle in another suite. Execution evidence uses the qualification contract’s task/slice QA path. Mark Implemented only after the primary and affected regressions execute green and retained evidence identifies the exact build.

| ID | Contract | Tasks | Primary test | Status |
| --- | --- | --- | --- | --- |
| CBK-01 | [company-brain](./company-brain.md) | T05,T06,T10 | `IT-CBK-01` — `web/lib/brain/__tests__/company-records.integration.test.ts` (web integration) | Implemented |
| CBK-02 | [company-brain](./company-brain.md) | T06,T08,T08.1 | `IT-CBK-02` — `web/lib/brain/__tests__/proposals.integration.test.ts` (web integration) | Implemented |
| CBK-03 | [company-brain](./company-brain.md) | T08,T11,T08.1 | `IT-CBK-03` — `web/lib/brain/__tests__/proposals.integration.test.ts` (web integration) | Implemented |
| CBK-04 | [company-brain](./company-brain.md) | T06,T07,T10 | `IT-CBK-04` — `web/lib/brain/__tests__/recall.integration.test.ts` (web integration) | Implemented |
| CBK-05 | [company-brain](./company-brain.md) | T06,T07,T08,T10,T09 | `IT-CBK-05` — `web/lib/brain/__tests__/company-records.integration.test.ts` (web integration) | Implemented |
| CBK-06 | [company-brain](./company-brain.md) | T10,T11 | `IT-CBK-06` — `web/app/api/knowledge/__tests__/knowledge.integration.test.ts` (web integration) | Implemented |
| CBU-01 | [company-brain](./company-brain.md) | T12,T13,T15 | `E2E-CBU-01` — `web/e2e/company-brain.spec.ts` (Playwright) | Implemented |
| CBU-03 | [company-brain](./company-brain.md) | T38 | `IT-CBU-03` — `web/lib/specialist-assignments/__tests__/write-back.integration.test.ts` (web integration) | Planned |
| EDGE-CBK-01 | [company-brain](./company-brain.md) | T06,T08 | `IT-CBK-02` — `web/lib/brain/__tests__/proposals.integration.test.ts` (web integration) | Implemented |
| EDGE-CBK-02 | [company-brain](./company-brain.md) | T10,T11 | `IT-CBK-06` — `web/app/api/knowledge/__tests__/knowledge.integration.test.ts` (web integration) | Implemented |
| EDGE-CBK-03 | [company-brain](./company-brain.md) | T08,T11 | `IT-CBK-03` — `web/lib/brain/__tests__/proposals.integration.test.ts` (web integration) | Implemented |
| EDGE-CBK-04 | [company-brain](./company-brain.md) | T06,T07,T08,T10,T09 | `IT-CBK-05` — `web/lib/brain/__tests__/company-records.integration.test.ts` (web integration) | Implemented |
| CBE-01 | [company-brain-evidence](./company-brain-evidence.md) | T07,T10 | `IT-CBE-01` — `web/lib/brain/__tests__/edges.integration.test.ts` (web integration) | Implemented |
| CBE-02 | [company-brain-evidence](./company-brain-evidence.md) | T07,T08 | `IT-CBE-02` — `web/lib/brain/__tests__/retain.integration.test.ts` (web integration) | Implemented |
| CBE-03 | [company-brain-evidence](./company-brain-evidence.md) | T07,T10 | `IT-CBE-03` — `web/lib/brain/__tests__/retain.integration.test.ts` and `web/app/api/knowledge/__tests__/knowledge.integration.test.ts` (web integration) | Implemented |
| EDGE-CBE-01 | [company-brain-evidence](./company-brain-evidence.md) | T07,T10 | `IT-CBE-01` — `web/lib/brain/__tests__/edges.integration.test.ts` (web integration) | Implemented |
| EDGE-CBE-02 | [company-brain-evidence](./company-brain-evidence.md) | T07,T08 | `IT-CBE-02` — `web/lib/brain/__tests__/retain.integration.test.ts` (web integration) | Implemented |
| EDGE-CBE-03 | [company-brain-evidence](./company-brain-evidence.md) | T07,T10 | `IT-CBE-03` — `web/lib/brain/__tests__/retain.integration.test.ts` and `web/app/api/knowledge/__tests__/knowledge.integration.test.ts` (web integration) | Implemented |
| CBE-04 | [evidence-findings](./evidence-findings.md) | T14 | `IT-CBE-04` — `web/lib/run-results/__tests__/findings.integration.test.ts` (web integration) | Implemented |
| CBE-05 | [evidence-findings](./evidence-findings.md) | T14,T15,T16 | `IT-CBE-05` — `web/lib/run-results/__tests__/findings-reduction.integration.test.ts` (web integration) | Implemented |
| CBE-06 | [evidence-findings](./evidence-findings.md) | T10,T14,T15,T23 | `IT-CBE-06` — `web/lib/run-results/__tests__/findings-access.integration.test.ts` (web integration) | Implemented |
| CBE-07 | [evidence-findings](./evidence-findings.md) | T06,T10,T15 | `IT-CBE-07` — `web/lib/brain/__tests__/private-memory-isolation.integration.test.ts` (web integration) | Implemented |
| EDGE-CBE-04 | [evidence-findings](./evidence-findings.md) | T14 | `IT-CBE-04` — `web/lib/run-results/__tests__/findings.integration.test.ts` (web integration) | Implemented |
| EDGE-CBE-05 | [evidence-findings](./evidence-findings.md) | T14,T15,T16 | `IT-CBE-05` — `web/lib/run-results/__tests__/findings-reduction.integration.test.ts` (web integration) | Implemented |
| EDGE-CBE-06 | [evidence-findings](./evidence-findings.md) | T10,T14,T15,T23 | `IT-CBE-06` — `web/lib/run-results/__tests__/findings-access.integration.test.ts` (web integration) | Implemented |
| EDGE-CBE-07 | [evidence-findings](./evidence-findings.md) | T06,T10,T15 | `IT-CBE-07` — `web/lib/brain/__tests__/private-memory-isolation.integration.test.ts` (web integration) | Implemented |
| CBS-01 | [specialist-runtime](./specialist-runtime.md) | T19,T19.1 | `IT-CBS-01` — `web/lib/agents/__tests__/effective.integration.test.ts` (web integration) | Planned |
| CBS-02 | [specialist-runtime](./specialist-runtime.md) | T19,T20,T21 | `IT-CBS-02` — `web/lib/agents/__tests__/company-runtime.integration.test.ts` (web integration) | Planned |
| CBS-03 | [specialist-runtime](./specialist-runtime.md) | T19.1,T20.1 | `IT-CBS-03` — `web/lib/flows/graph/__tests__/company-runtime.integration.test.ts` (web integration) | Planned |
| CBS-04 | [specialist-runtime](./specialist-runtime.md) | T19.1,T22.1 | `IT-CBS-04` — `web/lib/agents/__tests__/company-agent-context.integration.test.ts` (web integration) | Implemented |
| CBS-05 | [specialist-runtime](./specialist-runtime.md) | T20,T20.1,T27 | `IT-CBS-05` — `web/lib/services/__tests__/company-scope-admission.integration.test.ts` (web integration) | Planned |
| EDGE-CBS-01 | [specialist-runtime](./specialist-runtime.md) | T19,T20,T21 | `IT-CBS-02` — `web/lib/agents/__tests__/company-runtime.integration.test.ts` (web integration) | Planned |
| EDGE-CBS-02 | [specialist-runtime](./specialist-runtime.md) | T19.1,T20.1 | `IT-CBS-03` — `web/lib/flows/graph/__tests__/company-runtime.integration.test.ts` (web integration) | Planned |
| EDGE-CBS-03 | [specialist-runtime](./specialist-runtime.md) | T19.1,T22.1 | `IT-CBS-04` — `web/lib/agents/__tests__/company-agent-context.integration.test.ts` (web integration) | Implemented |
| EDGE-CBS-04 | [specialist-runtime](./specialist-runtime.md) | T20,T20.1,T27 | `IT-CBS-05` — `web/lib/services/__tests__/company-scope-admission.integration.test.ts` (web integration) | Planned |
| CBA-01 | [specialist-assignments](./specialist-assignments.md) | T18,T22 | `IT-CBA-01` — `web/lib/specialist-assignments/__tests__/store.integration.test.ts` (web integration) | Planned |
| CBA-02 | [specialist-assignments](./specialist-assignments.md) | T22,T22.1,T24,T26,T27 | `IT-CBA-02` — `web/lib/specialist-assignments/__tests__/store.integration.test.ts` and `web/lib/agents/__tests__/company-agent-context.integration.test.ts` (web integration; native agent-origin delegation remains T27) | Planned |
| CBA-03 | [specialist-assignments](./specialist-assignments.md) | T18,T19,T20,T22.1 | `IT-CBA-03` — `web/lib/specialist-assignments/__tests__/store.integration.test.ts` (web integration) | Planned |
| CBA-04 | [specialist-assignments](./specialist-assignments.md) | T23,T27,T28 | `IT-CBA-04` — `web/lib/specialist-assignments/__tests__/store.integration.test.ts` and execution/context/work integration (web integration) | Planned |
| CBA-05 | [specialist-assignments](./specialist-assignments.md) | T24,T36,T40 | `IT-CBA-05` — `web/lib/agents/__tests__/company-agent-context.integration.test.ts` and `web/lib/agents/__tests__/company-flow-context.integration.test.ts` (native platform qualified; installed-package scenario remains T36/T40) | Planned |
| CBA-06 | [specialist-assignments](./specialist-assignments.md) | T25,T26,T28,T40 | `IT-CBA-06` — `web/lib/specialist-assignments/__tests__/delivery.integration.test.ts` (web integration) | Planned |
| CBA-07 | [specialist-assignments](./specialist-assignments.md) | T18,T28,T38 | `IT-CBA-07` — `web/lib/specialist-assignments/__tests__/acceptance.integration.test.ts` (web integration) | Planned |
| CBU-02 | [specialist-assignments](./specialist-assignments.md) | T24,T25,T37,T39 | `E2E-CBU-02` — `web/e2e/specialist-assignments.spec.ts` (Playwright) | Planned |
| EDGE-CBA-01 | [specialist-assignments](./specialist-assignments.md) | T22,T22.1,T26 | `IT-CBA-02` — `web/lib/specialist-assignments/__tests__/store.integration.test.ts` and `web/lib/agents/__tests__/company-agent-context.integration.test.ts` (web integration; native agent-origin delegation remains T27) | Implemented |
| EDGE-CBA-02 | [specialist-assignments](./specialist-assignments.md) | T24 | `IT-CBA-05` — `web/lib/agents/__tests__/company-agent-context.integration.test.ts` (web integration; `T24/public-question-adapters/evidence.json`) | Implemented |
| EDGE-CBA-03 | [specialist-assignments](./specialist-assignments.md) | T23 | `IT-CBA-04` — `web/lib/specialist-assignments/__tests__/store.integration.test.ts` (web integration; `T23/runtime-projection/evidence.json`) | Implemented |
| EDGE-CBA-04 | [specialist-assignments](./specialist-assignments.md) | T18,T28,T38 | `IT-CBA-07` — `web/lib/specialist-assignments/__tests__/acceptance.integration.test.ts` (web integration) | Planned |
| EDGE-CBA-05 | [specialist-assignments](./specialist-assignments.md) | T25 | `IT-CBA-06` — `web/lib/specialist-assignments/__tests__/delivery.integration.test.ts` (web integration) | Implemented |
| CBC-01 | [specialist-cooperation](./specialist-cooperation.md) | T27,T28 | `IT-CBC-01` — `web/lib/specialist-assignments/__tests__/cooperation.integration.test.ts` (web integration) | Planned |
| CBC-02 | [specialist-cooperation](./specialist-cooperation.md) | T27,T29 | `IT-CBC-02` — `web/lib/specialist-assignments/__tests__/cooperation.integration.test.ts` (web integration) | Planned |
| CBC-03 | [specialist-cooperation](./specialist-cooperation.md) | T18,T29 | `IT-CBC-03` — `web/lib/specialist-assignments/__tests__/recovery.integration.test.ts` (web integration) | Planned |
| CBC-04 | [specialist-cooperation](./specialist-cooperation.md) | T28 | `IT-CBC-04` — `web/lib/specialist-assignments/__tests__/cooperation.integration.test.ts` (web integration) | Planned |
| CBC-05 | [specialist-cooperation](./specialist-cooperation.md) | T29,T30 | `IT-CBC-05` — `web/lib/specialist-assignments/__tests__/recovery.integration.test.ts` (web integration) | Planned |
| EDGE-CBC-01 | [specialist-cooperation](./specialist-cooperation.md) | T27,T29 | `IT-CBC-02` — `web/lib/specialist-assignments/__tests__/cooperation.integration.test.ts` (web integration) | Planned |
| EDGE-CBC-02 | [specialist-cooperation](./specialist-cooperation.md) | T18,T29 | `IT-CBC-03` — `web/lib/specialist-assignments/__tests__/recovery.integration.test.ts` (web integration) | Planned |
| EDGE-CBC-03 | [specialist-cooperation](./specialist-cooperation.md) | T28 | `IT-CBC-04` — `web/lib/specialist-assignments/__tests__/cooperation.integration.test.ts` (web integration) | Planned |
| EDGE-CBC-04 | [specialist-cooperation](./specialist-cooperation.md) | T29,T30 | `IT-CBC-05` — `web/lib/specialist-assignments/__tests__/recovery.integration.test.ts` (web integration) | Planned |
| EDGE-CBC-05 | [specialist-cooperation](./specialist-cooperation.md) | T29,T30 | `IT-CBC-05` — `web/lib/specialist-assignments/__tests__/recovery.integration.test.ts` (web integration) | Planned |
| CBO-01 | [stand-maintenance](./stand-maintenance.md) | T31,T32,T34 | `IT-CBO-01` — `web/lib/stand-operations/__tests__/intent.integration.test.ts` (web integration) | Planned |
| CBO-02 | [stand-maintenance](./stand-maintenance.md) | T31,T32,T33 | `IT-CBO-02` — `web/lib/stand-operations/__tests__/connector.integration.test.ts` (web integration) | Planned |
| CBO-03 | [stand-maintenance](./stand-maintenance.md) | T31,T32,T33 | `IT-CBO-03` — `web/lib/stand-operations/__tests__/connector.integration.test.ts` (web integration) | Planned |
| CBO-04 | [stand-maintenance](./stand-maintenance.md) | T32,T33 | `IT-CBO-04` — `web/lib/stand-operations/__tests__/reconcile.integration.test.ts` (web integration) | Planned |
| CBO-05 | [stand-maintenance](./stand-maintenance.md) | T33 | `IT-CBO-05` — `web/lib/stand-operations/__tests__/reconcile.integration.test.ts` (web integration) | Planned |
| CBO-06 | [stand-maintenance](./stand-maintenance.md) | T32,T33 | `IT-CBO-06` — `web/lib/stand-operations/__tests__/connector.integration.test.ts` (web integration) | Planned |
| CBO-07 | [stand-maintenance](./stand-maintenance.md) | T31,T33,T37 | `IT-CBO-07` — `web/lib/stand-operations/__tests__/reconcile.integration.test.ts` (web integration) | Planned |
| CBO-08 | [stand-maintenance](./stand-maintenance.md) | T28.1,T33,T36 | `IT-CBO-08` — `web/lib/agents/__tests__/agent-run-result.integration.test.ts` (web integration) | Planned |
| CBO-09 | [stand-maintenance](./stand-maintenance.md) | T25,T39 | `IT-CBO-09` — `web/lib/runs/__tests__/agent-incidents.integration.test.ts` (web integration) | Planned |
| EDGE-CBO-01 | [stand-maintenance](./stand-maintenance.md) | T31,T32,T33 | `IT-CBO-02` — `web/lib/stand-operations/__tests__/connector.integration.test.ts` (web integration) | Planned |
| EDGE-CBO-02 | [stand-maintenance](./stand-maintenance.md) | T31,T32,T33 | `IT-CBO-03` — `web/lib/stand-operations/__tests__/connector.integration.test.ts` (web integration) | Planned |
| EDGE-CBO-03 | [stand-maintenance](./stand-maintenance.md) | T32,T33 | `IT-CBO-04` — `web/lib/stand-operations/__tests__/reconcile.integration.test.ts` (web integration) | Planned |
| EDGE-CBO-04 | [stand-maintenance](./stand-maintenance.md) | T33 | `IT-CBO-05` — `web/lib/stand-operations/__tests__/reconcile.integration.test.ts` (web integration) | Planned |
| EDGE-CBO-05 | [stand-maintenance](./stand-maintenance.md) | T31,T32,T33 | `IT-CBO-02` — `web/lib/stand-operations/__tests__/connector.integration.test.ts` (web integration) | Planned |
| EDGE-CBO-06 | [stand-maintenance](./stand-maintenance.md) | T31,T33,T37 | `IT-CBO-07` — `web/lib/stand-operations/__tests__/reconcile.integration.test.ts` (web integration) | Planned |
| EDGE-CBO-07 | [stand-maintenance](./stand-maintenance.md) | T32,T33 | `IT-CBO-06` — `web/lib/stand-operations/__tests__/connector.integration.test.ts` (web integration) | Planned |
| CBX-01 | [company-brain-specialists-qualification](./company-brain-specialists-qualification.md) | T04,T05,T06,T09,T18,T19.1,T31,T08.1 | `IT-CBX-01` — `web/lib/db/__tests__/migration-company-brain-specialists.integration.test.ts` (web integration) | Planned |
| CBX-02 | [company-brain-specialists-qualification](./company-brain-specialists-qualification.md) | T10,T11,T14,T19,T20,T22.1,T24,T27 | `IT-CBX-02` — `mcp/src/__tests__/company-specialists.integration.test.ts` (MCP integration) | Planned |
| CBX-03 | [company-brain-specialists-qualification](./company-brain-specialists-qualification.md) | T16,T17 | `QL-CBX-03` — `web/e2e/live-company-brain-specialists.spec.ts` (live-supervisor) | Implemented |
| CBX-04 | [company-brain-specialists-qualification](./company-brain-specialists-qualification.md) | T35,T36,T40,T41 | `QL-CBX-04` — `web/e2e/live-company-brain-specialists.spec.ts` (live-supervisor) | Planned |
| CBX-05 | [company-brain-specialists-qualification](./company-brain-specialists-qualification.md) | T04.1,T17,T42,T43 | `CT-CBX-05` — `scripts/validate-requirement-coverage.test.mjs` (Node) | Planned |
| EDGE-CBX-01 | [company-brain-specialists-qualification](./company-brain-specialists-qualification.md) | T04,T05,T06,T09,T18,T19.1,T31 | `IT-CBX-01` — `web/lib/db/__tests__/migration-company-brain-specialists.integration.test.ts` (web integration) | Planned |
| EDGE-CBX-02 | [company-brain-specialists-qualification](./company-brain-specialists-qualification.md) | T10,T11,T14,T19,T20,T22.1,T24,T27 | `IT-CBX-02` — `mcp/src/__tests__/company-specialists.integration.test.ts` (MCP integration) | Planned |
| EDGE-CBX-03 | [company-brain-specialists-qualification](./company-brain-specialists-qualification.md) | T16,T17 | `QL-CBX-03` — `web/e2e/live-company-brain-specialists.spec.ts` (live-supervisor) | Implemented |
| EDGE-CBX-04 | [company-brain-specialists-qualification](./company-brain-specialists-qualification.md) | T35,T36,T40,T41 | `QL-CBX-04` — `web/e2e/live-company-brain-specialists.spec.ts` (live-supervisor) | Planned |
| EDGE-CBX-05 | [company-brain-specialists-qualification](./company-brain-specialists-qualification.md) | T04.1,T17,T42,T43 | `CT-CBX-05` — `scripts/validate-requirement-coverage.test.mjs` (Node) | Planned |
