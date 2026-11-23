# Studio catalog and session delivery acceptance

Each domain owns its expectation. The primary test identifies the observable behavior used to close the requirement.

| ID | Contract | Tasks | Primary test | Status |
| --- | --- | --- | --- | --- |
| CAT-01 | Eligible editors must be able to resolve approved sources to a pinned reviewable result. | T04 | IT-CAT-01 | Implemented |
| CAT-02 | Only the result for the current query may be displayed after a later query or clear. | T05, T06 | E2E-CAT-02 | Implemented |
| CAT-03 | One apply operation must publish a complete reviewed tree and its manifest from the expected draft base. | T05 | IT-CAT-03 | Implemented |
| CAP-01 | New Flow authoring must reject retired node skill settings and retain the pinned legacy read path. | T03 | IT-CAP-01 | Implemented |
| CAP-02 | A surviving MCP override must belong to exactly one project attachment and logical ref across adoption. | T07, T24 | IT-CAP-02 | Implemented |
| CAP-03 | Each session must receive its frozen effective inventory from the Run capture according to the project Run inventory table. | T08, T09 | IT-CAP-03 | Implemented |
| CAP-04 | Each bound node must own an isolated ACP session and adapter discovery view across interruption. | T10 | IT-CAP-04 | Implemented |
| CAP-05 | Updating one active project link must affect only that instance on subsequent launches and preserve the adopted source. | T11, T12, T13 | IT-CAP-05, E2E-CAP-05 | Implemented |
| HST-01 | Each tool probe and dispatch must execute on the current assigned host under the correct epoch. | T14, T16, T17 | E2E-HST-01 | Planned |
| HST-02 | A workload may start only a reviewed selected distribution whose digest, target runtime and trust are verified before use. | T15 | IT-HST-02 | Implemented |
| ASK-01 | The current execution credential must determine the owner and allowed question origin on every ask. | T18 | IT-ASK-01 | Implemented |
| ASK-02 | Only the active conversation owner may answer its private question and resume the exact suspended turn once. | T19, T20 | IT-ASK-02, E2E-ASK-02 | Implemented |
| ASK-03 | Only a checkpointed ordinary Flow question may expose a human assignment, with one claim across Inbox and Run views. | T21, T22 | IT-ASK-03 | Implemented |
| ASK-04 | An accepted answer may resume only its original recoverable attempt after checking current authority and assignment. | T23 | IT-ASK-04 | Implemented |
| CAP-06 | Project routing must allow a design and a development Run in the same project without either session receiving private resources of the other package. | T25, T26 | E2E-CAP-06 | Planned |

HST-01 has production-image receipts for private HTTP, installed stdio and the platform facade on two independent assigned supervisors. A separate control-host probe reached the public Microsoft Learn MCP. The public tool call from the assigned hosts remains open. CAP-06 passed the three-Run scenario with a local reference MCP, including the Inbox continuation and clickable prototype. Its release status follows the outstanding host gate. The [branch plan](../../.ai-factory/plans/feature-studio-catalog-imports.md) records the run IDs, image digest and receipts.
