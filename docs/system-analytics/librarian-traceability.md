# Librarian requirement traceability

Every `LCV` / `LAU` / `LOP` / `TST` / `CLR` / `LMM` / `LUI` requirement and every
`EDGE-*` case declared by the seven owning documents of the personal librarian, each
with the contract that specifies it, the plan tasks that enforce it, and the
**primary test** that proves it; then the brief's `LIB-01..16` decisions and
`L-01..12` acceptance scenarios mapped onto those requirements, so the brief is
traceable end to end.

The owning documents are
[`librarian-conversation.md`](librarian-conversation.md),
[`librarian-authority.md`](librarian-authority.md),
[`librarian-operations.md`](librarian-operations.md),
[`task-statements.md`](task-statements.md),
[`task-clarifications.md`](task-clarifications.md),
[`librarian-memory.md`](librarian-memory.md) and
[`librarian-surface.md`](librarian-surface.md).
`scripts/validate-docs-indexes.mjs` fails when a declared id has no row here, or a
row here has a blank `Primary test` cell.

**The `Primary test` column names the test each requirement's owning task writes
first (its RED step), not a scenario alias.** Test ids follow `UT-` unit, `IT-`
integration, `CT-` contract, `E2E-` Playwright and `QL-` live-adapter
qualification, suffixed with the requirement id; an edge case's test carries the
tier, then `EDGE-`, then its id. The `Enforcement/task` cells name tasks of the
implementation phases only (`T1.x`–`T6.x` of the plan): the specification phase
writes these documents and the qualification phase proves them, so neither owns a
row. The mapping is bidirectional — every requirement names at least one task, and
every implementation task is named by at least one row.

`Status` stays `Planned` until the owning phase turns the requirement green; every
described piece is **Designed**.

## Requirement traceability

| Requirement | Contract/schema | Enforcement/task | Primary test | Status |
| --- | --- | --- | --- | --- |
| LCV-01 | UNIQUE librarian_conversations_user_uq; getOrCreateConversation | T2.1, T2.4 | IT-LCV-01 | Planned |
| LCV-02 | partial UNIQUE librarian_messages_client_id_uq; appendOwnerMessage dedup | T2.1, T2.4 | IT-LCV-02 | Planned |
| LCV-03 | partial UNIQUE librarian_turns_one_active_uq under the conversation row lock; withdrawMessage queued only | T2.1, T2.4, T2.5 | IT-LCV-03 | Planned |
| LCV-04 | CHECK runs_run_kind_check and runs_librarian_shape_check; execution_commands_prompt_owner_required with owner kind librarian_turn; workspaceSpecFor librarian directory arm, reserved projectSlug _librarian | T2.2, T2.3, T2.10, T2.14 | IT-LCV-04 | Planned |
| LCV-05 | tryStartRun librarian pool arm, MAISTER_MAX_CONCURRENT_LIBRARIAN_TURNS; persistent=true keep-alive Pass2 exemption; applyLibrarianPark and claimLibrarianResumeInTransaction | T2.5, T2.9 | IT-LCV-05 | Planned |
| LCV-06 | composer guard over run_sessions.librarian_context_epoch and librarian_turns.runner_snapshot | T2.2, T2.6 | IT-LCV-06 | Planned |
| LCV-07 | CHECK librarian_turns_running_has_snapshot_check; librarian_context_snapshots incl. instructions version | T2.1, T2.6, T2.7 | IT-LCV-07 | Planned |
| LCV-08 | POST /api/librarian/turns/current/stop; BoundClient prompt cancel plus token revoke | T2.11 | IT-LCV-08 | Planned |
| LCV-09 | reconcile librarian arm, turn failed host_lost, run parked | T2.3, T2.10, T2.11 | IT-LCV-09 | Planned |
| LCV-10 | MAISTER_LIBRARIAN_TURN_MAX_MINUTES, MAISTER_LIBRARIAN_CONTEXT_MAX_CHARS, MAISTER_LIBRARIAN_DAILY_TURNS_PER_USER; BUDGET_EXCEEDED; composer keeps the latest owner message | T2.5, T2.6, T2.11, T2.16 | IT-LCV-10 | Planned |
| LCV-11 | platform_runtime_settings.librarian_enabled and librarian_runner_id; PATCH /api/admin/platform/librarian; CONFIG and EXECUTOR_UNAVAILABLE admission refusals | T2.5, T2.13 | IT-LCV-11 | Planned |
| LCV-12 | GET /api/librarian/stream, librarian-stream AsyncAPI, lastEventId replay by seq; run stream authz created_by_user_id | T2.12 | IT-LCV-12 | Planned |
| EDGE-LCV-01 | librarian_messages_client_id_uq dedup across concurrent tabs | T2.4 | IT-EDGE-LCV-01 | Planned |
| EDGE-LCV-02 | queued delivery_state, FIFO by seq, admitted after the active turn | T2.5 | IT-EDGE-LCV-02 | Planned |
| EDGE-LCV-03 | admission runner-ready check, EXECUTOR_UNAVAILABLE, queue kept | T2.5 | IT-EDGE-LCV-03 | Planned |
| EDGE-LCV-04 | deadline watchdog, token revoke, operation settles by reconcile lookup | T2.11 | IT-EDGE-LCV-04 | Planned |
| EDGE-LCV-05 | keep-alive Pass2 persistent exemption for a parked librarian run | T2.3 | IT-EDGE-LCV-05 | Planned |
| LAU-01 | ADR-184 route identifier table; owner from auth-context only | T2.12 | IT-LAU-01 | Planned |
| LAU-02 | CHECK project_tokens_kind_check and project_tokens_librarian_check; issueLibrarianTurnToken and revokeLibrarianTurnToken | T1.1, T1.2, T2.10 | IT-LAU-02 | Planned |
| LAU-03 | handleExt librarian arm; requireProjectActionForUser per request; turn running check | T1.3, T2.10, T2.11 | IT-LAU-03 | Planned |
| LAU-04 | deny-by-default admitLibrarian opt-in; LIBRARIAN_TOKEN_SCOPES exclusions; agent-token refusal on /ext/librarian routes | T1.3, T3.9 | IT-LAU-04 | Planned |
| LAU-05 | LIBRARIAN_READ_SCOPES for explain turns | T1.3, T5.3 | IT-LAU-05 | Planned |
| LAU-06 | getVisibleProjects before aggregation in ext projects, directory, task search, work, activity feed and decisions; librarian MCP toolset | T1.5, T1.6 | IT-LAU-06 | Planned |
| LAU-07 | token_audit_log on_behalf_of_user_id, librarian_turn_id, operation_id via recordRequiredTokenAudit | T1.4 | IT-LAU-07 | Planned |
| LAU-08 | socialActorForToken returns the owner; via_operation_id; session card decide for human-only actions | T3.6, T3.9 | IT-LAU-08 | Planned |
| LAU-09 | owner-only server-state in every /api/librarian route; no admin inspection route | T2.12 | IT-LAU-09 | Planned |
| LAU-10 | verifyToken owner-active checks; per-request RBAC; admission-time owner check | T1.2, T1.3, T2.5 | IT-LAU-10 | Planned |
| LAU-11 | SessionEnforcementProfileSchema librarian profile; permissions auto_approve; adapter-home L2 deny settings; readOnlyCapable runner guard | T2.8, T2.10 | IT-LAU-11 | Planned |
| EDGE-LAU-01 | verifyToken refuses revoked or expired turn tokens with 401 | T1.2 | IT-EDGE-LAU-01 | Planned |
| EDGE-LAU-02 | owner-resolved conversation; 404 on a foreign id | T2.12 | IT-EDGE-LAU-02 | Planned |
| EDGE-LAU-03 | handleExt archived-project 404; operation not_applied reconcile | T1.3, T1.5, T3.2 | IT-EDGE-LAU-03 | Planned |
| EDGE-LAU-04 | summary profile with mcps.allowServers empty; any tool call fails the turn capability_trip | T6.3 | IT-EDGE-LAU-04 | Planned |
| LOP-01 | Idempotency-Key from operationKey; handleExt idempotency required; finalize inside recordRequiredTokenAudit | T1.6, T3.2 | IT-LOP-01 | Planned |
| LOP-02 | UNIQUE librarian_operations_key_uq; canonical digest; CONFLICT idempotency_payload_mismatch and duplicate_of_operation | T3.1, T3.2 | IT-LOP-02 | Planned |
| LOP-03 | UNIQUE tasks_created_via_operation_uq, task_comments_via_operation_uq, runs_librarian_operation_uq; MAISTER_LIBRARIAN_OPERATION_RECONCILE_SECONDS admission gate | T2.16, T3.1, T3.2, T3.7 | IT-LOP-03 | Planned |
| LOP-04 | one librarian_operations row per batch item; per-item receipt | T3.7 | IT-LOP-04 | Planned |
| LOP-05 | tasks.launch_intent none on librarian create; applyTriageVerdict and C2 eligibility | T3.4, T3.5 | IT-LOP-05 | Planned |
| LOP-06 | ext send-to-triage with launchIntent in the sendTaskToTriage transaction | T3.5 | IT-LOP-06 | Planned |
| LOP-07 | launchRun preconditions unchanged; runs.librarian_operation_id in the insert transaction | T3.7 | IT-LOP-07 | Planned |
| LOP-08 | librarian_cards target_revision and payload_digest; decide refuses CONFLICT target_changed; MAISTER_LIBRARIAN_CONFIRMATION_TTL_MINUTES | T3.9, T6.9 | IT-LOP-08 | Planned |
| LOP-09 | session card decide as HitlActor kind user through respondToHitl, promoteRun and discard | T3.9 | IT-LOP-09 | Planned |
| LOP-10 | POST /api/v1/ext/runs/{runId}/operator-message outcome enum; agent_turns.requested_by_user_id | T3.8 | IT-LOP-10 | Planned |
| LOP-11 | UNIQUE librarian_updates_event_uq; librarian_followup consumer access check | T5.1, T5.2 | IT-LOP-11 | Planned |
| LOP-12 | librarian_updates.attempts at most 5; CHECK librarian_updates_failed_has_error_check | T5.2 | IT-LOP-12 | Planned |
| EDGE-LOP-01 | same-key stored result; tasks_created_via_operation_uq on a racing retry | T3.2, T3.4 | IT-EDGE-LOP-01 | Planned |
| EDGE-LOP-02 | per-item operations; retry re-issues non-terminal items only | T3.7 | IT-EDGE-LOP-02 | Planned |
| EDGE-LOP-03 | launchRun Pending with queue position; dependency PRECONDITION recorded refused | T3.7 | IT-EDGE-LOP-03 | Planned |
| EDGE-LOP-04 | applyTriageVerdict under launch_intent none; C2 skip | T3.5 | IT-EDGE-LOP-04 | Planned |
| TST-01 | zod statement schema; trigger task_statement_revisions_immutable | T3.1, T3.4 | IT-TST-01 | Planned |
| TST-02 | tasks.revision; updateTask FOR UPDATE with expectedRevision; CONFLICT stale_revision | T3.3 | IT-TST-02 | Planned |
| TST-03 | renderStatementPrompt pure deterministic render | T3.4 | UT-TST-03 | Planned |
| TST-04 | librarian_task_links meaning, message range and statement_revision | T3.1, T3.4 | IT-TST-04 | Planned |
| TST-05 | task_publish_excerpt as a task comment plus mentioned link | T3.6 | IT-TST-05 | Planned |
| TST-06 | ON DELETE SET NULL message refs; clear history keeps tasks, statements and excerpts | T3.1, T6.8 | IT-TST-06 | Planned |
| TST-07 | BACKLOG_GATED_FIELDS gate in acceptStatement; PRECONDITION receipt naming the seams | T3.4 | IT-TST-07 | Planned |
| TST-08 | getLinkedWork batched visibility-filtered read | T3.10 | IT-TST-08 | Planned |
| EDGE-TST-01 | BACKLOG_GATED_FIELDS refusal on an InFlight task | T3.4 | IT-EDGE-TST-01 | Planned |
| EDGE-TST-02 | nulled link message refs render the unavailable state | T3.10, T6.8 | IT-EDGE-TST-02 | Planned |
| CLR-01 | CHECK task_clarifications_origin_shape_check | T4.1 | IT-CLR-01 | Planned |
| CLR-02 | answerHitl minimum role member at creation and at answer | T4.2 | IT-CLR-02 | Planned |
| CLR-03 | inbox_items clarification_requested; fifth computeDecisionsQueue source (ADR-169 amendment) | T4.2, T4.4, T4.7 | IT-CLR-03 | Planned |
| CLR-04 | CHECK task_clarifications_status_shape_check; status CAS; superseding row | T4.1, T4.2 | IT-CLR-04 | Planned |
| CLR-05 | TaskLaunchability clarification_pending; deriveWorkStage clarificationPending; decideFire explicit arm | T4.3 | IT-CLR-05 | Planned |
| CLR-06 | librarian_followup access check; task detail clarifications section | T4.5, T4.7, T5.2 | IT-CLR-06 | Planned |
| CLR-07 | answerClarification leaves statement, revision and launch state | T4.2 | IT-CLR-07 | Planned |
| CLR-08 | cancelClarification cascades; task.clarification_cancelled | T4.5 | IT-CLR-08 | Planned |
| CLR-09 | session answer route; ext twin requiring exact hitl:respond:human | T4.2 | IT-CLR-09 | Planned |
| CLR-10 | composeEffectivePrompt folds user-origin answers | T4.6 | IT-CLR-10 | Planned |
| EDGE-CLR-01 | live member check at answer; deactivation cascade | T4.2, T4.5 | IT-EDGE-CLR-01 | Planned |
| EDGE-CLR-02 | row lock plus status CAS on answer | T4.2 | IT-EDGE-CLR-02 | Planned |
| LMM-01 | POST /api/v1/ext/librarian/memory in owner-message turns only; memory_suggestion card | T6.2 | IT-LMM-01 | Planned |
| LMM-02 | librarian_memory_item_revisions; trigger librarian_memory_items_content_immutable | T6.1, T6.2 | IT-LMM-02 | Planned |
| LMM-03 | composer source_project_ids re-check; summary invalidated and rebuild queued | T6.4 | IT-LMM-03 | Planned |
| LMM-04 | active-segment composer selection; librarian_history_search labelled results | T6.4, T6.7 | IT-LMM-04 | Planned |
| LMM-05 | reset_state barrier; context_epoch bump; cards cleared_by_reset; system_sweep backstop | T6.5 | IT-LMM-05 | Planned |
| LMM-06 | forgotten_at; librarian_memory_tombstones; epoch bump | T6.6 | IT-LMM-06 | Planned |
| LMM-07 | CAS on segment ordinal, forget_generation and history_generation | T6.3, T6.6 | IT-LMM-07 | Planned |
| LMM-08 | clear-preview digest; clear transaction; workspace.release and transcript purge | T6.8 | IT-LMM-08 | Planned |
| LMM-09 | message render mask by source_project_ids | T6.4 | IT-LMM-09 | Planned |
| LMM-10 | system_sweep retention pass; MAISTER_LIBRARIAN_HISTORY_RETENTION_DAYS and MAISTER_LIBRARIAN_SNAPSHOT_RETENTION_DAYS | T6.9 | IT-LMM-10 | Planned |
| LMM-11 | ESLint no-restricted-imports fence on web/lib/librarian | T6.2 | IT-LMM-11 | Planned |
| LMM-12 | snapshot memory_item_revisions rendered as used-in-this-reply chips | T6.2 | IT-LMM-12 | Planned |
| EDGE-LMM-01 | fenced summary CAS after a reset acknowledgement | T6.3 | IT-EDGE-LMM-01 | Planned |
| EDGE-LMM-02 | tombstone plus epoch bump during a running owner turn | T6.6 | IT-EDGE-LMM-02 | Planned |
| LUI-01 | librarian-trigger.tsx in top-nav.tsx; indicator from read_through_seq and pending owner cards | T2.15, T5.3 | UT-LUI-01 plus E2E-LUI-01 | Planned |
| LUI-02 | librarian-panel.tsx mounted in the authenticated app layout | T2.15 | E2E-LUI-02 | Planned |
| LUI-03 | panel breakpoints xl and md; 390 px viewport | T2.15 | E2E-LUI-03 | Planned |
| LUI-04 | librarian_messages.subject written at send | T2.4 | IT-LUI-04 | Planned |
| LUI-05 | useModalFocusTrap; focus restore to the invoker | T2.15 | E2E-LUI-05 | Planned |
| LUI-06 | message list scroll anchoring and jump-to-latest | T2.15 | UT-LUI-06 | Planned |
| LUI-07 | distinct Stop response and Stop run controls; disabled reasons | T2.15 | UT-LUI-07 | Planned |
| LUI-08 | librarian i18n namespace in web/messages en.json and ru.json | T2.15, T3.10, T4.7 | UT-LUI-08 | Planned |
| LUI-09 | no Cmd/Ctrl+K binding; scratch shortcut intact | T2.15 | E2E-LUI-09 | Planned |
| LUI-10 | getLinkedWork live region | T3.10 | IT-LUI-10 | Planned |

## Brief traceability

Each brief decision and acceptance scenario of
[`../pv/personal-librarian.md`](../pv/personal-librarian.md) mapped onto the
requirement ids above. Scenario tests run on the mock librarian adapter (`E2E-L-NN`);
the scenarios the live-adapter qualification repeats against real runners also carry
`QL-L-NN`.

| Brief | Subject | Requirement ids | Acceptance tests |
| --- | --- | --- | --- |
| LIB-01 | One conversation per user | LCV-01, LCV-02, LCV-03, LUI-02 | E2E-L-01 |
| LIB-02 | Acts with the user's current authority | LAU-02, LAU-03, LAU-04, LAU-06, LAU-09, LAU-10 | E2E-L-01, E2E-L-05 |
| LIB-03 | Tasks own work | TST-01, TST-03, TST-04, TST-05, CLR-01, LOP-07 | E2E-L-02, E2E-L-12 |
| LIB-04 | Complete first release loop | LOP-05, LOP-06, LOP-07, LOP-10, TST-02, CLR-01, LOP-11 | E2E-L-02, E2E-L-03 |
| LIB-05 | Internal MCP only | LAU-11, LCV-04, LAU-04 | E2E-L-11 |
| LIB-06 | Durable platform-owned context | LCV-02, LCV-06, LCV-07, LMM-02, LMM-04 | E2E-L-09 |
| LIB-07 | Identity and current permission | LAU-01, LAU-02, LAU-03, LAU-07, LAU-08, LAU-09, LAU-10 | E2E-L-05, E2E-L-06, E2E-L-11 |
| LIB-08 | Intent and confirmation | LAU-05, LOP-05, LOP-08, LOP-09, LAU-04 | E2E-L-03, E2E-L-08, E2E-L-11 |
| LIB-09 | Observable, idempotent effects | LOP-01, LOP-02, LOP-03, LOP-04, LOP-05, LOP-06 | E2E-L-03, E2E-L-07, E2E-L-12 |
| LIB-10 | Statement and provenance | TST-01, TST-02, TST-03, TST-04, TST-05, TST-06, TST-07, TST-08 | E2E-L-02, E2E-L-08, E2E-L-10 |
| LIB-11 | Pre-execution clarification | CLR-01, CLR-02, CLR-03, CLR-04, CLR-05, CLR-06, CLR-07, CLR-08, CLR-09, CLR-10 | E2E-L-04, E2E-L-08 |
| LIB-12 | Separate durable records | LCV-07, LMM-02, LMM-07, LMM-10, LMM-11 | E2E-L-09 |
| LIB-13 | Retrieval under current access | LMM-01, LMM-03, LMM-04, LMM-09, LMM-12, LCV-06 | E2E-L-05, E2E-L-06, E2E-L-10 |
| LIB-14 | Reset, forget and clear history | LMM-05, LMM-06, LMM-08, TST-06 | E2E-L-09, E2E-L-10 |
| LIB-15 | Durable execution | LCV-03, LCV-04, LCV-05, LCV-08, LCV-09, LCV-10, LCV-11, LCV-12 | E2E-L-04, E2E-L-06, E2E-L-07, E2E-L-09 |
| LIB-16 | Follow-up updates | LOP-11, LOP-12, LAU-05, LUI-01 | E2E-L-04, E2E-L-12 |
| L-01 | Ask across projects from Desk, navigate, return; 390 px | LUI-01, LUI-02, LUI-03, LUI-05, LAU-06, LCV-12 | E2E-L-01, QL-L-01 |
| L-02 | Ambiguous need becomes two accepted tasks; duplicate offered | TST-01, TST-03, TST-04, TST-08, LOP-01, LAU-06 | E2E-L-02, QL-L-02 |
| L-03 | Create only, create and launch, triage-only | LOP-04, LOP-05, LOP-06, LOP-07 | E2E-L-03, QL-L-03 |
| L-04 | Ask a teammate; answer returns after restart | CLR-01, CLR-03, CLR-05, CLR-06, CLR-07, LOP-11, LCV-09 | E2E-L-04, QL-L-04 |
| L-05 | Viewer, unrelated member and admin boundaries | LAU-03, LAU-04, LAU-06, LAU-09, LMM-03 | E2E-L-05 |
| L-06 | Revocation between proposal and execution | LAU-03, LAU-10, LCV-06, LMM-03, LMM-09 | E2E-L-06 |
| L-07 | Lost response, restart, two-tab resubmission | LOP-01, LOP-02, LOP-03, LOP-04, LCV-02, LCV-09 | E2E-L-07 |
| L-08 | Stale statement or approval; injected teammate text | TST-02, LOP-08, LOP-09, LAU-05 | E2E-L-08, QL-L-08 |
| L-09 | Reset keeps tasks and memory, drops old context | LMM-04, LMM-05, LMM-07, LOP-03, TST-06 | E2E-L-09 |
| L-10 | Forget and clear history | LMM-06, LMM-07, LMM-08, TST-06 | E2E-L-10 |
| L-11 | Existing work only through domain guards | LOP-09, LOP-10, LAU-04, LAU-08, LAU-11 | E2E-L-11 |
| L-12 | Result while closed; one update, honest stage | LOP-11, LOP-12, TST-08, LUI-01, LUI-10 | E2E-L-12, QL-L-12 |

## Linked artifacts

- [ADR-183](../decisions.md#adr-183-librarian-runtime-a-project-less-run-kind-with-per-turn-acp-sessions) · [ADR-184](../decisions.md#adr-184-librarian-delegated-authority-per-turn-owner-bound-tokens-with-live-rbac) · [ADR-185](../decisions.md#adr-185-librarian-operation-ledger-confirmation-cards-and-launch-intent) · [ADR-186](../decisions.md#adr-186-task-statements-task-revision-and-conversation-provenance) · [ADR-187](../decisions.md#adr-187-addressed-task-clarification-before-execution) · [ADR-188](../decisions.md#adr-188-librarian-memory-summaries-reset-barrier-and-history-deletion) · [ADR-189](../decisions.md#adr-189-librarian-surface-top-navigation-entry-and-right-side-panel)
- [`librarian-conversation.md`](librarian-conversation.md) · [`librarian-authority.md`](librarian-authority.md) · [`librarian-operations.md`](librarian-operations.md) · [`task-statements.md`](task-statements.md) · [`task-clarifications.md`](task-clarifications.md) · [`librarian-memory.md`](librarian-memory.md) · [`librarian-surface.md`](librarian-surface.md)
- [Product brief — personal librarian](../pv/personal-librarian.md)
