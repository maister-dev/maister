# Implementation Plan: Agent memory vault, installation agents, unified review and librarian access

Branch: `feature/agent-memory-vault`
Created: 2026-11-17
Base inspected: `b06e641d28fd8ef50ce1cacff4030f935c113301` (also local `master`)
Status: In progress.

## Settings

- Mode: full; reuse the existing worktree. The local branch starts at the inspected local master; no pull, push or deployment is part of planning.
- Testing: yes. Follow the RED → GREEN → REFACTOR gate below for every behavior slice. Use pure tests for deterministic transforms, real Postgres for durable behavior, real adapters for wire contracts and Playwright for user journeys.
- Logging: verbose DEBUG, explicitly confirmed by the owner; structured IDs, operation, policy reason, sizes, timings and outcome only. Never log note bodies, snippets, prompts, patches, credentials or source content. INFO for committed effects; WARN for denied/conflicting/retried work; ERROR for terminal failures. Use the existing `LOG_LEVEL` control.
- Specification-driven development (SDD) and mandatory documentation checkpoints through `$aif-docs`. P0 specifies each changed contract under `docs/CLAUDE.md` R4–R7. Each feature slice implements and verifies the corresponding specification before updating its status.
- EN + RU UI, HeroUI v3, strict types, `MaisterError`, shared domain services, no new polling or execution runtime.
- Task checkboxes are the durable task ledger; dependencies are explicit below. TaskCreate/TaskUpdate tools are not available in this session.

## Roadmap Linkage

Milestone: "none"
Rationale: Explicitly skipped by the owner. This does not waive any acceptance or documentation gate.

## Research context and evidence

No `.ai-factory/RESEARCH.md` exists. The owner's locked A–D requirements, phases and acceptance are the requirements source. The following findings were checked against the inspected checkout:

| Evidence | Planning consequence |
| --- | --- |
| `web/lib/agents/memory-store.ts:191`, main migration `0122_agent_memory_files.sql` | Existing attachment-wide filesystem CAS becomes per-note Postgres CAS; preserve conflict-current-content behavior. |
| `web/lib/agents/launch.ts:3007,3072` | Remove standalone-only gating and `memory-snapshot.md`; support empty enabled vaults, exact DB injection manifests, override and resume paths. |
| `web/lib/flows/runner-agent.ts:1353`, `web/lib/agents/flow-binding.ts:188`, `web/lib/agents/tokens.ts:443` | Node persona overrides run persona; resolve memory using attested session/node identity, including project-kind node tokens. |
| `web/lib/agents/effective.ts:65`, `project-links.ts:377,584` | Node bindings need not have agent attachments today; memory requires an explicit enabled attachment. Remove the flow-driver memory prohibition consistently in server and picker UI. |
| `web/lib/agents/native-memory-write.ts:31`, `web/lib/brain/knowledge-disclosure.ts:77,180` | Preserve fine-grained source restrictions and transactionally captured disclosures; source project IDs alone are insufficient. |
| `web/lib/company/types.ts:58`, `web/lib/brain/knowledge-disclosure.ts:180`, `web/lib/run-results/__tests__/findings-access.integration.test.ts:596` | v1 capture has 256-entry and serialized-byte bounds. Version the exact vault-revision restriction and preserve protected findings, including when private content leaves through a conflict response. |
| `docs/decisions/adr-202.md`, `adr-203.md`, `web/lib/agents/company-binding-types.ts:42` | Extend reviewed company bindings; the company already represents the installation. |
| `company-agent-execution-types.ts:14`, `company-run-credential-owner.ts:45`, `web/lib/brain/knowledge-access.ts:253` | Existing company execution requires an initiating human; unattended installation execution needs a versioned principal contract across all consumers. |
| `runtime/company-flow-tools.ts`, `companyFlowEnforcementProfile` and company tool contract | Reuse MCP-only enforcement but do not inherit company delegation, stand-operation or assignment-write tools. |
| `web/lib/brain/ui-queries.ts:287`, `knowledge-proposal-query.ts:50` | Legacy Brain and knowledge proposals share `brain_proposals`; native readable proposals include submitter-only rows, so reviewability needs its own predicate. |
| `web/lib/queries/decisions.ts:74`, `web/components/chrome/left-rail-nav.tsx:39` | Preserve six amber decision kinds; rail currently models one badge per section and needs two distinct Inbox badges. |
| `web/lib/tokens/owned-ext-handler.ts:47`, `web/lib/brain/knowledge-access.ts:168` | Knowledge denies librarian credentials at two independent admission seams; tool visibility alone is not sufficient. |
| `web/lib/librarian/card-decisions.ts:324` | Reuse DB-atomic personal-memory confirmation pattern for effect + receipt + card/operation settlement. Personal memory semantics stay unchanged. |
| `web/lib/brain/schema.ts:23`, `web/lib/db/migrate-brain.ts:12`, `recall-ranker.ts:27` | Main migration lineage owns vault data; optional Brain vector projection is separate. Existing ranker is Brain-specific, not a generic vault store. |
| `web/lib/db/check.ts:17`, `web/test-support/pg-container.ts:595,672,737` | Main-only vault capability tests use the existing main-only fixture and assert `pg_extension` has no `vector` row. The production migration check still expects both journals. |

External references, checked 2026-11-17: Anthropic's [memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) supplies the command vocabulary and app-owned `/memories` mapping; [Managed Agents memory](https://platform.claude.com/docs/en/managed-agents/memory) supplies immutable-version/read-only reference concepts. MAIster's CAS, authorization and proposal behavior are explicit extensions. Its vault does not adopt their sandbox mount model or introduce an Anthropic runtime dependency.

## Decisions

### D1. Ownership, migration lineage and rollout

1. Extend `company_specialist_bindings` through the existing binding service with a versioned reach discriminant: legacy/company-only versus explicit `all_non_archived_projects`. A current global admin must grant this reach. Existing rows and historical snapshots decode as company-only; no default migration may widen them.
2. `workspace: none` is mandatory for installation agents. Optional `repo_read`, context repository mounts, shell/file tools and cross-project launch/delegation are excluded. Reads happen through the bounded MCP/API allow-list below.
3. Owner XOR is **per attachment**: `(agent, project)` or `(agent, installation/company)`. Preserve the existing ability to attach one catalog definition to multiple projects, with distinct vaults. Do not add catalog-global single-project uniqueness, auto-detach existing bindings, or make company-only bindings acquire memory.
4. Main lineage owns vault owners, heads, immutable revisions, operations/diffs, policy, proposals, source receipts and injection manifests. Core storage and lexical search must work with Brain disabled and without the vector extension. Only the optional rebuildable vector cache belongs in the Brain lineage; never insert private notes into `brain_items` or shared `brain_chunks`.
5. P1/P2 are implementation checkpoints; first general rollout is P1–P3 together. Until pending-review handling exists, external-input mutations must refuse explicitly rather than auto-apply. P4 follows P3. P5 read-only project-vault/knowledge access can ship after P1; installation reads require P4; confirmation writes require P3 and P4 for installation targets.

### D2. Storage and concurrency

Proposed main-schema families (final SQL names are frozen in P0):

- `agent_memory_vaults`: stable owner identity, active-content byte/character and note counts, generation and import/cutover state. Attachment settings own enabled/write policy. Ownership and history survive detach/reattach. Retain an archived owner identity when the attachment or project is removed.
- `agent_memory_notes`: stable note ID, canonical path, current revision ID, deletion state; unique active path per vault. Paths represent folders; no filesystem directories are created.
- `agent_memory_revisions`: append-only revision ID, note/vault, prior revision, operation, UTF-8 content hash, content payload, author type/id, run/session/node-attempt or human/librarian provenance, immutable source IDs/restrictions and operation ID. Delete/clear/rename/revert append revisions; revert is a new CAS write, never a pointer rewind that erases history.
- `agent_memory_operations`: content-guarded request key, canonical command digest, exact result references, base/target revisions and diff references. Every applied and proposed mutation is attributable; human/import operations explicitly have no authoring run.
- `agent_memory_injections`: versioned protocol ID/hash, owner/session/node identity, ordered visible paths and exact injected revision references, rendered tree selection, content hashes, prompt size and application receipt. It is the DB witness instead of `memory-snapshot.md`.
- Tag/link indexes and proposal envelopes are added in P2/P3. Source-project restrictions use durable IDs/tombstones, not deletion-cascading links that can make a note more public.

New mutation requests require the current content hash and revision ID for every existing head they affect. Compare both to protect stale edits after delete/recreate, rename or A→B→A. For create-if-absent both preconditions are explicitly null. Legacy save/delete keep their hash-only contracts for the compatibility window. `CONFLICT` returns current content/hash/revision for a single note only after current read authorization and source capture. A hidden target uses the same response as missing. Multi-note conflicts return the conflicting visible revision metadata and a bounded reload instruction. `str_replace` requires exactly one literal match. `insert` uses documented line boundaries. The server reports a lost CAS for the submitted preconditions.

Locks match invariants. Acquire current credential / consumer Run locks in the order already used by knowledge disclosure. Cross-domain promotion and card effects use the existing knowledge write lock when required. P0 resolves the joint lock order across card, proposal, source, vault and note transactions. Vault quota row precedes affected notes in stable ID order. Independent note edits both succeed when within quota. Same-note writers from a single base produce one winner. Rename preserves note identity and requires an unused destination. A directory is a virtual prefix. Directory delete/rename and clear compare vault generation plus a bounded exact member revision manifest, and apply all affected heads in one transaction. If any member is hidden, deny the operation without identifying that member.

Revision insertion, head/quota changes, indexes, proposal settlement, audit and durable invalidation commit together. Request retries compare canonical payload bytes/digest: same key+same payload returns the same receipt, same key+different payload conflicts. No timestamps/randomness enter a digest that cannot be reproduced from the stored operation. A failed transaction changes none of these stores.

### D3. Commands, paths, caps and injection

- MCP `memory` is a discriminated command union: `view`, `create`, `str_replace`, `insert`, `delete`, `rename`. Keep familiar Anthropic field names (`path`, `file_text`, `old_str`, `new_str`, `insert_line`, `insert_text`, `old_path`, `new_path`, `view_range`), with explicit CAS/idempotency extensions. `create` may replace an existing note only with its current preconditions. `view` pages both directory entries and note lines/characters and returns hashes/revision-bound cursors.
- Only `/memories` and descendants are valid. Root is view-only. Restrict text notes to `.md`; reject absolute alternate roots, empty/dot/dot-dot segments, repeated separators, backslashes, NUL/control bytes, URL/query/fragment forms, invalid Unicode and overlong/deep paths. Reject percent-escape syntax rather than decoding it repeatedly; `%2e`, `%2f`, `%252e` and mixed encodings cannot reach canonical storage. Normalize Unicode once with a documented case-sensitive identity; enforce the same path contract in MCP, HTTP, links, import and SQL uniqueness. Link heading fragments are parsed separately from note paths.
- Proposed defaults, frozen with units/ranges in P0: retain `MAISTER_AGENT_MEMORY_MAX_CHARS=32768` as the **entire rendered injection** cap. Add `MAISTER_AGENT_MEMORY_NOTE_MAX_CHARS=65536`, `MAISTER_AGENT_MEMORY_INDEX_MAX_CHARS=8192`, `MAISTER_AGENT_MEMORY_VAULT_MAX_CHARS=1048576`, `MAISTER_AGENT_MEMORY_MAX_NOTES=256`, `MAISTER_AGENT_MEMORY_MAX_PENDING=256`. Fixed protocol limits: path ≤512 UTF-8 bytes, depth ≤16, ordinary note/view page ≤16384 characters, page ≤100 entries, batch review ≤50 items. Authorized single-note CAS conflicts return the full current note, bounded by the absolute protocol storage/response ceiling frozen in P0. A lowered operator write cap cannot truncate an existing note in a conflict response. Character caps use JavaScript UTF-16 code-unit length. Hashes use exact UTF-8 bytes. Validate coupled budgets before use.
- Vault cap bounds live heads, with a separate bounded pending proposal budget; immutable historical revisions remain indefinitely and are never TTL-pruned. Repeated proposals cannot bypass live-content caps on acceptance. Monitor retained size without deleting history. Cap reductions can block growth but must still permit authorized delete, redact and size-reducing repair.
- A platform-owned `memory-protocol/v1` documents `index.md`, `notes/`, `progress/<TASK-KEY>.md`, frontmatter, link syntax, on-demand reads, CAS and review outcomes. Agent-specific instructions stay in definition bodies; add no guidance frontmatter field. Protocol, index and rendered path tree occupy the existing BEGIN/END untrusted-data block; escape marker-forging text consistently and keep framing outside user content.
- Inject protocol even for an empty enabled vault. Inject the full bounded index, then a stable ordered tree page within the remaining budget; explicitly identify omitted entries and how to page them. Never inject other note bodies. A hidden installation index is omitted without revealing its existence; still include protocol and authorized tree. Protocol+index must fit or return `CONFIG`; storage/capture failure does not silently degrade to no memory.
- Session persona precedence: attested `settings.agent` → attested run persona (`runs.agent_id`) → no agent vault. Explicit enabled attachment is required. A materialized subagent definition shares its host session and has no independent credential: it cannot select another vault. A binding requiring independent subagent memory must refuse before launch unless it has a distinct authenticated session; no client-selected persona override.
- Persist per-session/node manifests before dispatch and link application outcome at the existing prompt-application seam. Resume the same ACP context without reinjecting or replacing its original manifest; fresh context/retry gets a new manifest. Override prompts still receive required memory framing when an enabled persona applies. Enumerate fresh start, driver, every graph node, retry, idle recovery, steer/resume and company dispatch in tests.
- New `runs.agent_memory_hash` values hash a canonical, versioned injected-manifest representation. Preserve historical raw-file hashes and add an explicit format discriminator. For parallel sessions, hash an ordered immutable set of applied injection descriptors; retain the individual descriptors, not a last-writer-wins scalar. Stable ordering excludes application timestamps. Resume does not reset the set; session application recording is idempotent and versioned. Aggregate membership/hash update runs transactionally under the run-scoped lock; two parallel application receipts cannot overwrite each other. Before restoring an ACP context, recheck every retained source restriction, including original injections; if a source is no longer authorized, refuse resume before dispatch rather than reuse inaccessible context.

### D4. Source derivation and authorization

The owner explicitly confirmed conservative attribution: a run that reads A and B produces a note restricted to **A+B**, even if its text cites only A.

For revision R, `source_project_ids(R)` is the canonical union of previous/base revision sources, server-resolved entity-link sources, all projects disclosed to the authoring run up to this write, and inherited prompt/input, resumed-context, prior-vault and result sources. Apply this rule to human edits and librarian edits using the actual owner interaction evidence where applicable. Capture under the consumer lock **before delivering bytes**, including private current-content conflicts, receipt replays and prompt submission. Concurrent writes snapshot under the same lock. Later disclosures constrain later revisions. Run-wide union includes parallel-node disclosures. Persist across restart and any retry that inherits context. Keep v1 capture readable and version new context/revision restrictions. Aggregate project sets from every returned contributor. If the resolved set cannot fit the capture contract, refuse that disclosure before bytes leave and require a narrower request. Test that an overflow leaves the old set intact and returns no source content.

Include snippets, list metadata, aggregate contributors and injected memory; do not trust agent-provided `source_project_ids`. Entity links are pointers, resolved under current authority, and cannot launder hidden targets. Keep existing fine-grained knowledge/evidence/source restrictions alongside project IDs; never downgrade these to mere project membership. A human or librarian edit cannot strip existing restrictions by omitting links or replacing text. Promotion preserves restrictions and exact revision evidence.

| Principal / operation | Authority |
| --- | --- |
| Human project note bodies, tree/search/snippets/history/diffs | `readRepoFiles`; viewer denied. Avoid a separate metadata side channel. |
| Human project create/edit/delete/clear/revert/policy/review | `editSettings` plus read/source access; redaction excluded. |
| Global admin | All vaults/notes and admin-only revision redaction; explicit audited actor. |
| Project agent session | Bound acting persona + enabled project attachment + command scope + live source restrictions; existing cross-project reach does not grant other agents' private memory. |
| Installation agent, manual | Explicit live agent allow-list intersected with initiating user's current rights, per response data class. |
| Installation agent, unattended cron/event | Explicit live agent grant alone, audited `agent:<id>`; administrator who configured it remains provenance, not an impersonated execution user. |
| Non-admin reader of installation vault | Current company `specialists:read` on the binding owner, plus visibility of **every** source project and all finer source restrictions. Empty sources still require the binding reader grant. |
| Installation vault editor/reviewer | Current global admin plus source visibility; installation agents can propose only, even if attachment policy is `auto`. |
| Librarian | Active owner/turn-bound credential, allowed tool/mode and owner's live target rights. Confirmed mutations use the human path with owner attribution. |

The installation read allow-list covers project registry metadata, tasks, runs/activity, bounded Observatory aggregates, Brain recall, and knowledge search/get. Evidence embedded in these authorized responses retains its source guards; separate evidence/witness/conflict tools are not implicitly added to this installation allow-list. Grant each operation explicitly; no wildcard or automatic inclusion of future tools. Effective authority is the launch-captured reviewed binding/tool limits intersected with the current grant and, for manual runs, current user rights. Later grant additions cannot widen an issued credential/run. Preserve current refusal on exact binding-revision drift; a reviewed rebind requires fresh admission rather than rewriting an old execution snapshot. Responses containing source-derived transcripts/evidence apply their stronger gate for manual users. All direct task/comment/relation writes, run launch/stop/rework/delegate/message, stand operations and direct Brain/knowledge publication remain denied. Its only writes are vault/Brain/knowledge proposals. Do not broaden `CROSS_PROJECT_AGENT_SCOPES` or reuse the broad company Flow tool list.

Filter before limit/ranking/counts, and recheck before delivery: bodies, paths, tags, aliases, links, history, CAS conflicts, Inbox previews/counters, prompts and search/vector candidates. Denied installation notes/projects answer identically to missing resources. Project deletion/archival must not drop source restrictions. Archived projects cannot be newly read by installation agents; historical note visibility still checks retained source identity and current authority.

### D5. Structure, search and redaction

From P2, server-side parsing recognizes YAML `tags`/`aliases`, note links `[[note]]`/`[[note#heading]]` and entity links `[[task:KEY-N]]`, `[[run:<id>]]`, `[[brain:item/<id>]]`, `[[knowledge:<recordId>@<rev>]]`, `[[repo:<path>#L<n>]]`. Use bounded YAML parsing with YAML anchors and alias nodes, custom tags and duplicate keys refused. The plain string list under the `aliases` key supplies note lookup names. Resolve exact vault-relative path first, then unique basename/alias, then optional heading on the resolved revision. Missing, ambiguous and unauthorized targets share an unresolved outward representation where needed to hide existence. Note links resolve only inside their vault. Repo links use the owning project. Installation repo pointers require an unambiguous server-held source project context, and grant no repo body access. Preserve older raw Markdown during import and P2 indexing backfill. If legacy reserved frontmatter fails parsing, record a visible repair state with its raw Markdown intact. Apply strict validation when a new revision is authored.

Store raw link target, resolved note/entity reference, heading, source revision and resolution state; tags/aliases/links are derivative indexes of the current nondeleted head. Rename preserves note identity, recomputes resolution and records a diff; no automatic rewriting of every inbound note. Lexical search is always available. Reuse existing embedding provider/configuration and ranking mechanics behind a typed vault adapter; preserve Brain query semantics and candidate types. Optional vector cache keys include vault, note revision, model/dimensions and generation; filter source visibility within the candidate query. No private-note copy in shared Brain. Configured provider failure retries with warnings then returns the error; it must not silently fall back to lexical. Disabled vectors use the explicitly configured lexical mode.

Revision redaction removes the separately stored payload, with immutable revision ID, hash and provenance retained. Use the same vault/head locks as mutation and the destination's exact-evidence guards. In the redaction transaction, revoke access to materialized copies and derivatives under platform control, including pending proposals, librarian cards/receipts and published evidence-dependent projections. Store operation receipts and diffs via references so replay cannot reconstruct removed bytes. Redacting a current head appends a tombstone and updates quota and indexes. History shows redaction metadata after authorization. Accept/revert/promote and vector worker completion must recheck the exact revision at their apply boundary. Promotion must register its exact source dependency on read paths for evidence and any accepted content derived from that evidence. A prior external disclosure and independently authored revisions are outside the scope of this redaction operation.

### D6. Review, external inputs and librarian effects

- Project attachment write policy is `auto` by default or `review`; effective run writes are forced to review by server-derived external-input provenance (`trigger_source=webhook`, task external source, and inherited/retried/steered external content). Freeze the launch policy witness and retain monotonic external-input taint. Current revocation/disable and a switch to review constrain future calls; a switch to auto never releases already pending proposals. Installation agent writes are always proposals.
- Proposal captures exact command, base revisions, intended content, immutable author/source restrictions and diff. Pending content is not an active head, not injected or returned as committed. Acceptance rechecks rights, source visibility, enablement, quota and every base hash; stale targets yield `CONFLICT`, not silent rebase. Reject records a terminal decision without changing the head. Retried same decision is idempotent; opposite terminal decisions conflict.
- One canonical Inbox group, `Knowledge & memory`, combines vault proposals plus disjoint legacy Brain/native knowledge proposal kinds. Use reviewer/action eligibility, not generic readability or proposer visibility. Existing domain acceptance rules remain authoritative; e.g. legacy accept can require `manageCatalog` or `createTask` in addition to `writeBrain`.
- Batch actions use bounded discriminated refs, expected revisions and per-item operation keys. Each item has an independent transaction/receipt and explicit outcome; mixed failure does not claim atomic batch success. Removed/hidden rows yield no sensitive detail. One-click revert uses current-head CAS and creates a revision.
- Add `reviews` as a third, neutral attention count through the **existing** attention SSE snapshot/reconnect/change stream. Rail count and opaque `reviewVersion` cover the unfiltered reviewer-authorized set using the same base predicate as the filterable review list. Include item revision and allowed actions in the signature so a same-count replacement, changed preview or lost decision right invalidates `changed: ["reviews"]`. The RSC render and reconnect send both values as baseline. Missing or invalid review baselines force one review reconciliation for a compatible client. A review-only tick leaves the project scan watermark intact and can carry the same SSE id with a different review version. The client applies it by version and region. Hidden proposal activity cannot change this reader's review version, count or project IDs. Inbox shows amber `decisions` and neutral `reviews`. Activity retains neutral `updates` and amber publication remains driven by `DecisionKind`.
- Brain and `/knowledge/proposals` keep only read-only lists/history and links to filtered Inbox. Remove decision controls also from detail pages, not just list pages. Agent Memory UI retains tree/editor/history/revert, with a **single-line Inbox link for pending reviews**, no review cards.
- `memory_promote(path, target)` creates a pending Brain/knowledge proposal with exact vault revision evidence and restrictions; never publishes directly. Explicit destination is validated against target authority. A broad target cannot expose a narrower private note through copied content or evidence previews.
- Librarian `knowledge_propose`, Brain suggestions and vault mutations create ADR-187 confirmation cards. Freeze target, exact intended payload/diff, base revision/hash, evidence and digest. Capture source restrictions from disclosed bytes in the owner turn and any context it inherits, then freeze those restrictions at card creation. Confirm rechecks current rights, inherited sources and target state. Settle effect, audit, result receipt and card/operation in one DB transaction. Vault applies as a human edit with `editSettings` (admin for installation). Knowledge remains pending for `knowledge:review`. Brain follows the owner's existing rights. Attribute to owner via librarian, including turn/card/operation IDs. Card-only scope authorizes proposal creation and never authorizes an effect through a generic MCP write route.
- Owner-message/read-only-explain/tool-less-summary modes remain distinct. Personal librarian memory (ADR-190), reset barriers, turn cancellation and operation recovery remain intact.
- Librarian target selection is distinct from an execution agent's self-vault facade: expose `agent_vault_list`, `agent_vault_view`, `agent_vault_search`, `agent_vault_backlinks`, `agent_vault_tags` and `agent_vault_propose_edit`. These take a validated opaque vault selector, resolved under the owner's rights, and reuse the same domain services. The last tool creates a confirmation card only. Do not give the librarian a synthetic agent identity or a client-selectable persona through `memory`.

### D7. HTTP/MCP contracts and identifiers

Routes below define the planned operation inventory. P0 specifies methods, `operationId`s, parameters, strict request/response schemas and real fixtures. Treat query parameters as untrusted input. Build new body-bearing commands with the existing bounded JSON reader and use private `Cache-Control: private, no-store` for bodies, metadata, conflicts and receipts. Cap bytes at the transport and apply the configured UTF-16 note cap and paging rules at the domain boundary.

| Route family / operation | Identifiers and trust | Data and domain errors |
| --- | --- | --- |
| Browser project base `/api/projects/[slug]/agents/[agentId]/memory`. Retain existing GET/PUT/DELETE as index compatibility. New GET `/notes`, `/revisions`, `/revisions/[revisionId]`, `/search`, `/backlinks`, `/tags`; POST `/commands` and `/promote`. | `slug`, `agentId`, `revisionId`: url-param, resolved to server-state project/attachment/vault/note. Actor: auth-context. `path`, range, cursor, query, command, preconditions, destination and operation key: untrusted validated inputs. Compare revision/destination to the authorized vault or target. | GET `/notes` lists directory children or pages a note. `/revisions` lists history by stable note ID, including deleted notes only through authorized history. `/commands` owns create, replace, insert, rename, delete, clear and revert. `readRepoFiles` for reads and `editSettings` for mutations. |
| Browser installation base `/api/specialists/[specialistId]/bindings/[bindingId]/memory` with the same new subroutes. | `specialistId`, `bindingId`, `revisionId`: url-param, resolved to one exact reviewed installation attachment and vault. Auth-context supplies admin/reader. | Current binding and all note/source guards before DTOs. Admin-only human edits and review. No legacy installation alias. |
| Admin revision-redaction route `/api/agent-memory/revisions/[revisionId]/redact` | revisionId: url-param → server-state vault/owner; actor: auth-context global admin; reason and idempotency key: body-controlled. | No raw content in audit response; redact cannot be invoked through agent tool credentials. |
| External self-vault base `/api/v1/ext/agent/memory`: legacy GET/POST. New POST `/commands` (including `view`) and `/promote`, GET `/search`, `/backlinks`, `/tags`. | Run/session/node/persona/vault from current credential plus server attestation. Validate paths/query/commands/target refs. Scoped owner-aware admission for the projectless installation token, with identity from the Run. | 200 view/applied, 202 pending with proposal/operation receipt. MCP treats 202 as a valid pending result. Legacy GET keeps empty first-writer state and legacy POST keeps `content`/`ifHash`; both target index only. |
| `/api/inbox/reviews`, `/api/inbox/reviews/[kind]/[proposalId]` and `/api/inbox/reviews/decisions`; existing Brain/knowledge decision adapters | actor: auth-context; filter owner/project/agent/kind/cursor and discriminated item refs, expected versions, decisions and keys: body-controlled/query. Resolve each row and target from server-state, then current reviewer/source rights. | Review-authorized content only; bounded per-item outcomes. Existing APIs delegate to same services; no duplicate decision implementation. |
| Existing `/api/attention/stream` | user: auth-context; cursors/subscription filters: query-controlled validated; authorized projects/review generation: server-state. | Counts/changed regions only; no note paths/bodies in shared stream. |
| Existing POST `/api/specialists/[specialistId]/bindings`, GET/PATCH/DELETE `/api/specialists/[specialistId]/bindings/[bindingId]` and specialist intake/trigger consumers. | Binding/source ID from validated selector; principal/reach/source appointment/Run/chain from server state and auth context. | Explicit admin grant mutation. Server selects manual vs grant-only principal from authorized trigger kind. The company Flow binding route is a different resource. |
| Existing knowledge read/propose and project Brain MCP routes, `/api/v1/ext/librarian/cards`, card-decision endpoints; librarian vault reads via explicit target selector | owner/turn/conversation/token mode: auth-context + server-state; requested target/evidence/command/card ID: url-param/body-controlled, resolved and checked. Never trust body owner/source IDs. | Narrow librarian admission. Proposal/mutation request returns card; confirmation returns actual effect receipt. Missing project/note indistinguishable from hidden. |
| New `/api/v1/ext/librarian/vaults` and `/api/v1/ext/librarian/vaults/[vaultId]/{view,search,backlinks,tags}`; edits use the existing cards endpoint | `vaultId`: url-param opaque selector, never authority; owner/turn/mode: auth-context + server-state. Query path/filter/cursor: body-controlled/query validated; actual project/installation owner comes from vault lookup and live rights. | Visible-only list and source-derived content; no mutation endpoint and no arbitrary agent impersonation. |

New vault routes use 409 `PRECONDITION` for disabled memory after authority is established, following the shared error mapping. Use 409 `CONFLICT` for stale CAS/replay-key mismatch and 422 `CONFIG` for invalid path, command or caps. Unauthorized credentials use 401 or 403 as appropriate. Hidden targets use the same 404 response as missing, including nested selectors. Keep the legacy index endpoints' existing authorized empty-read/delete and disabled-token status semantics for the compatibility window. Legacy browser DELETE tombstones index only. Document the smaller cap for newly written index notes and that overflow imports require the new notes view to find `notes/legacy.md`. The legacy MCP alias retains old input shape and applied response shape, and adds the pending branch which bundled clients must handle. Scope the compatibility window to one release, with removal covered by a later change.

DTO/schema changes fan out to `mcp/src/tools.ts`, `toolsets.ts`, web token scopes and scope→action mapping, runtime enforcement mirrors, validators, OpenAPI, AsyncAPI and consumers. Use explicit `agent_memory:read/propose/write` operation scopes distinct from Brain `memory:*`. Freeze the exact set of methods, response data classes, project archive and auth rules, token scopes, tool names and provenance collectors for P4. Reuse the existing projects/tasks/runs/activity/Brain/knowledge read handlers where they can enforce this contract. Observatory needs a scoped read-only facade over its query service and an explicit contributor set for capture. P0 names its route and tool and registers them in the same allow-list. Librarian scopes permit read and card creation only.

### D8. Crash windows, lifecycle and migration

| Boundary | Durable state and recovery |
| --- | --- |
| DB mutation / proposal acceptance | One transaction owns head, revision, counters, proposal status, audit and invalidation. Death before commit has no effect; after commit retry returns content-matched receipt. |
| Post-commit SSE wake | Durable revision/invalidation committed before notification. Reconnect derives current authorized snapshot; lost wake cannot lose proposal/count state. No new polling loop. |
| Optional embedding provider | Durable version-keyed job/intention first; provider outside DB lock; fenced completion only if expected revision remains valid. Bounded retries/backoff; poison item recorded; current lexical operation explicitly separate. Reuse existing scheduler worker, stable keyset progress and renewal if call budget exceeds lease. |
| Prompt dispatch | DB manifest and existing prompt-application intent before supervisor request; application receipt after. Existing reconciliation owns uncertain delivery; replay same descriptor, never relabel newly read memory as already injected. Test death on both sides of delivery. |
| Librarian confirmation | Card target check + domain effect + settled receipt in one DB transaction. Restart reuses existing operation reconciliation; reject/cancel/stale/expired paths cannot leave an accepted effect with an unaccepted card. |
| Legacy import | Quiesce old writers/active legacy credentials, inventory sources, import exact bytes and verify the resulting receipts. Advance the durable cutover fence before bringing up the new writer. Clean up original files after cutover under the same maintenance boundary. Each cleanup verifies the exact file identity and digest against its receipt. A changed file conflicts and remains untouched. |

Migration is an explicit resumable operator command, dry-run by default; SQL migrations do not read arbitrary host files. Import all enabled/disabled/detached-but-retained identifiable attachment memories, with unresolved/orphan ownership reported and refused rather than guessed. If old text fits the index cap, import it byte-for-byte into index; otherwise place original text byte-for-byte in `notes/legacy.md` and create a small index link. If even legacy note/vault cap cannot hold it, fail before changing source and require an explicit cap adjustment; never truncate. Record original path/hash/length and destination revision receipts. Legacy project notes retain a tagged `legacy_project_private` provenance boundary for their known owning project under the existing `readRepoFiles` contract; this is not a claim that old read receipts existed. Never map an unidentified legacy owner or unknown installation execution to an empty/public source set. Moving/promoting imported notes preserves their project-private source guard; modern runs using them capture that disclosure. Clean up old `memory-snapshot.md` copies only through a separate inventory/verified migration step that preserves historical run evidence in Postgres before removing files. No new dedicated note/snapshot files are materialized.

Legacy run hashes retain their raw-file format and value. Preserve an available historical snapshot only with its Run identity, exact bytes and matching hash. Record missing or mismatched evidence as such, and refuse cleanup of a mismatched file. Enforce cutover generation at token and mutation admission, and use DB-backed guards for enabled generation. Maintenance must stop old binaries and drain or revoke legacy credentials because old file writers do not consult DB fences. Boot the new binary only after the durable cutover marker. Before activation, rollback can restart old binaries using intact originals. After activation or cleanup, rollback requires a vault-compatible build or an explicit consistent backup restoration procedure. Never reconstruct missing history from a current note.

## Contract and documentation map

| Changed surface | Canonical artifacts |
| --- | --- |
| Vault store/commands/policy/migration | `docs/system-analytics/agent-memory.md`, `docs/configuration.md`, `docs/database-schema.md`, `docs/db/agents-domain.md` |
| Persona Flow memory, installation reach and principal | `docs/system-analytics/agents.md`, `docs/system-analytics/specialist-runtime.md`, company Brain/assignment analytics where contracts live; root `CLAUDE.md` Current Scope; `docs/db/company-brain-domain.md` |
| Inbox review/attention | `docs/system-analytics/attention.md`, `docs/api/async/attention-stream.asyncapi.yaml`, `docs/screens/inbox.md`, `docs/screens/chrome/left-rail.md` |
| Memory UI and old review surfaces | `docs/screens/projects/project-settings-agents.md`, `docs/screens/projects/project-brain.md`, `docs/screens/company-brain.md`; add a dedicated memory screen doc only if needed and index it |
| Librarian scopes/cards | `docs/system-analytics/librarian-authority.md`, `docs/system-analytics/librarian-operations.md`, `docs/screens/chrome/librarian-panel.md` and `docs/api/async/librarian-stream.asyncapi.yaml` for the existing card refresh behavior. |
| Browser APIs | `docs/api/web.openapi.yaml` |
| External API/MCP commands and scopes | `docs/api/external/operations.openapi.yaml`, MCP schemas, existing knowledge schema generator, scope/toolset drift tests |
| New DB objects / vector projection | Main schema/migrations, Brain optional schema/migrations, `docs/database-schema.md`, relevant Mermaid domain ERDs, generated `docs/db/erd.dbml` via `db:erd` |
| Caps and import CLI/deployment | `.env.example`, `deploy/maister.env.example`, `docs/configuration.md`, `docs/getting-started.md`, `docs/deployment.md`, `web/package.json` and `web/CLAUDE.md` scripts |

ADR work uses new records for direction changes and dated amendments as pointers, never edits accepted decision text. Planned allocations from this base: ADR-210 vault (supersedes **only memory part C of ADR-152**, preserving pulse/summonability decisions); ADR-211 installation reach/principals; ADR-212 unified optional review; ADR-213 librarian knowledge/vault window. Append dated amendments to ADR-156/202/203, ADR-169/171 and ADR-186 respectively; mirror statuses/index stubs. P0 allocates actual records before cross-linking; numbers here are provisional reservations, not existing ADR links.

Main journal maximum is 0342; planned allocation: 0343 vault/storage/import/manifests; 0344 immutable-revision/redaction guards as a separate cross-cutting constraint migration; 0345 tags/links; 0346 vault proposals/policy; 0347 installation binding/principal contracts; 0348 disclosure provenance expansion. Brain journal maximum is 0011; reserve 0012 for the optional vault vector cache only. Recheck local and integration-base journals before writing; reserve additional migrations explicitly rather than editing applied files. T37 owns the rebase/renumber pass. New main migrations include SQL, journal, snapshot and matching Drizzle schema; Brain follows its existing hand-authored migration convention.

### SDD contract package and phase gate

P0 produces the Designed specifications linked above. An implementer must be able to select a requirement row, find its canonical specification and derive the expected result independently of the code. Keep the `AV-*` IDs from the acceptance matrix through the documentation Expectations, executable tests and phase evidence. Use the existing requirement-coverage verifier's declared mapping convention if registering a new group, and use the matrix below as the delivery checklist. A declared witness must be collected by its runner.

| Specification | Required deliverable and acceptance before the first behavior slice |
| --- | --- |
| System analytics | Under R5/R5a, specify owners, transitions, admissible predecessors, action-time authority, durable write boundaries, refusal outcomes and recovery/retry ownership. Cover note and proposal lifecycle, launch application and resume, import cutover, reviewer visibility and settlement, installation credential/reach/provenance, librarian capture/confirmation/recovery. Name the enforcing lock, predicate, receipt or constraint for each Expectation. Keep existing Implemented paths identified and mark prospective behavior Designed. Cross-link the precise API and DB contract instead of copying it. |
| HTTP OpenAPI and MCP | For each operation in D7 and P4's allow-list, provide the operation ID, method, route/transport, caller/required scope, identifier trust, input types/ranges/defaults, cursor binding, success variants and every typed refusal. Use closed schemas for commands, decisions, receipts and their union branches. Examples cover current/first-writer state, applied/pending, stale hash vs disabled, invalid input, hidden target and mixed batch. Validate examples against schemas. Use one runtime codec per shape and add parity checks with the canonical HTTP/MCP contracts by extending `scripts/validate-contracts.mjs`, `mcp/src/__tests__/tool-contract.test.ts` and the owning route tests. |
| SSE AsyncAPI | Specify the attention tick fields, old/new baseline compatibility, changed region, opaque review version and the same-cursor invalidation case. Heartbeat and timeout retain their existing shapes. Define what a review tick may reveal from the authorized set and what triggers each refresh. Reuse librarian's existing content-free refresh frames for card changes. Extend the attention contract assertions in `scripts/validate-contracts.mjs` and validate representative frames emitted by the real route. |
| DB and migration ledger | For every changed table, column, index or guard, record lineage, owning schema file and migration tag, null/default/backfill semantics, unique/partial constraints, exact FK targets and delete actions, transaction/lock order, and fresh vs upgraded expected state. Specify same-note/same-vault ownership for all head, parent, replay, proposal and evidence pointers. Spell out activation/visibility guards for partial migration and failure. Cutover is a separate versioned operator operation. Use the ERD and `docs/database-schema.md` for the contract, and regenerate DBML from schemas when DDL lands. |

P0 tests validate specification syntax, schema examples, links and traceability. Product RED witnesses start with P1. Each implementation phase validates delivered wire examples against actual handlers, updates only the delivered portion to Implemented, and runs the full phase gates. Any genuine contract change after P0 updates the canonical documents and expected test first, and records its reason. An unexpected failing test is investigated against the spec before changing either.

### Migration and upgrade requirements

| Slice | Frozen transition and executable verification |
| --- | --- |
| Main 0343–0344 (P1) | Add vault and history data, receipt/injection ownership, hash-format discriminant and immutable payload guards. Preserve the existing project attachment enablement storage as the authority for project attachments and resolve installation enablement through its reviewed binding. Default current data to legacy-compatible behavior. No legacy byte import in SQL. Test fresh main-only with no installed `vector`, upgrade from journal 0342 with populated legacy run/hash and enabled, disabled and detached attachments, cross-vault reference rejection, retention on ordinary owner lifecycle, failed transaction rollback and unchanged history on reapply. |
| Main 0345 / Brain 0012 (P2) | Apply main indexing changes before the Brain cache FK. Run the main without Brain migrations and exercise lexical indexing of existing vault heads. Test Brain optional setup both fresh and upgrading from 0011 with existing Brain items and embeddings. Validate exact cache ownership by vault/revision/model/generation. Historical source bytes and shared Brain results remain intact. Existing installation support for `db:check` still expects both deployment journals. |
| Main 0346 (P3) | Default project policy `auto`; add pending/decision receipts and external provenance fields with explicit unknown handling. A live legacy execution without sufficient source provenance cannot auto-apply. Add P3 idempotency and privacy constraints in the planned migration, and validate old rows and interrupted transactions. Install only if all P3 constraints and source/read paths are present. |
| Main 0347–0348 (P4) | Retain historical lean snapshots, grant versions and previous principal kind. Test known legacy/company-only behavior immediately after upgrade and require new explicit reviewed installation grant. Store versioned exact source references. Keep project IDs through archival/hard-delete using stable retained identity. Test non-widening for old decoders, null/unknown/corrupt provenance and fail-closed reads. |
| Filesystem import (T10/T39) | Hold cutover authority while the legacy writer is stopped. Verify exact UTF-8, owner mapping and caps before activation. Preserve original bytes through interrupted import, duplicate retry, source drift and cleanup retry. Import raw legacy text separately from any P2 derived indexing. Prove fresh vault writes use Postgres only after activation. |

Use `startMainPostgresTestDbUpTo` and `applyMainMigration` for seeded upgrades, the existing main-only/main+Brain fixtures for fresh paths, and the canonical SQL generator for helper DDL where applicable. Assert the installed extension state and actual constraints. Run Drizzle generation in an isolated writable checkout against its supported configuration, and require schema/journal/snapshot agreement and no unexpected generated diff. Keep SQL already applied to a durable database immutable.

## Tasks

Each task includes its tests/updated assertions; no task is complete merely because a test file was created. Logging instructions refer to the Settings safety contract. Paths named `agent-memory-vault/*` are new proposed modules under `web/lib/`; inspect existing helpers before creating them.

### P0 — Specify behavior, data and wire contracts before feature code

- [x] **T01 — Freeze vault persistence, command and migration contracts.**
  - Files: `docs/system-analytics/agent-memory.md`, `docs/db/agents-domain.md`, `docs/database-schema.md`, `docs/configuration.md`, new ADR-210 and hub/status amendment to ADR-152.
  - Specify D1–D3/D5/D8 state machines, refusal rows, lifecycle retention, redaction, manifest/hash versioning, import ordering and exact caps. Produce the allocation, constraint and data-transition matrix above with fixtures for each historical state. State the enforcement point for each expectation and preserve unrelated ADR-152 decisions.
  - Validation: schema/command/state tables agree, migration namespace allocation recorded, no live data deletion or ambiguous old-hash reinterpretation. Logging: document safe structured events; no runtime code.
  - Verification: `pnpm validate:docs` passed on 2026-11-19 with the vault ADR, analytics, ERD and settings changes.
  - Depends on: none.
- [x] **T02 — Freeze installation and librarian authority contracts.**
  - Files: new ADR-211/213 and amendments to ADR-156/202/203/186; `docs/system-analytics/agents.md`, `specialist-runtime.md`, `librarian-authority.md`, company-domain ERD, root `CLAUDE.md` Current Scope.
  - Enumerate every principal/scope/action/data class, current rights intersections, grant-only actor, source-union rule, subagent boundary, existing and new binding behavior and confirmation decision matrix. Specify each read's disclosure collector, exact restricted revision reference and bounded provenance failure, including turn-captured librarian sources. Preserve immutable ADR decision bodies.
  - Validation: positive grant and negative revocation case for each new allow-list entry; no implicit project reach or direct-write path. Logging: define grant/revoke/principal attribution audit fields.
  - Verification: existing source boundaries checked against the reviewed grant, turn-token and native knowledge gates. ADR anchor and documentation links passed.
  - Depends on: T01.
- [x] **T03 — Freeze review, route and event contracts.**
  - Files: new ADR-212 and amendments to ADR-169/171; attention analytics; `docs/api/web.openapi.yaml`, `docs/api/external/operations.openapi.yaml`, `docs/api/async/attention-stream.asyncapi.yaml`; relevant Inbox/rail/Memory/Brain screens.
  - Write the full HTTP/MCP and SSE contract package above. Specify distinct reviewer/action eligibility, batch outcomes, duplicate decisions, and same-count SSE invalidation. Confirm exact browser, bearer, scheduler and server-action entry points. Specify read-only old review surfaces and distinct neutral rail labels.
  - Validation: no double-counted native proposals, no DecisionKind widening, schemas validate and links/indexes resolve. Logging: structured per-item effect/refusal and content-free SSE revision events.
  - Verification: official OpenAPI/AsyncAPI parsers, ADR anchors and cross-surface schema parity passed.
  - Depends on: T01, T02.
- [x] **T04 — Define executable acceptance fixtures and Phase-0 consistency gate.**
  - Files: the affected analytics Expectations/Edge cases sections, existing test runner configs only if needed later; this plan's test mapping.
  - Match every acceptance row below to its enforcing transaction/guard, one primary executable witness and actual runner discovery. Assign the relevant boundary coverage needed for distinct assertions. Resolve policy interactions (manual/unattended × auto/review × external input × persona × revoked source) before implementation and verify each refusal has a safe response. Keep Designed and Implemented behavior explicit.
  - Validation: `pnpm validate:docs`, `pnpm validate:contracts`; explicit ADR anchor check; complete ERD/prose/API/event/refusal consistency, including failure/cancellation/restart. Logging: validation output only, no new runtime logs.
  - Verification: `pnpm validate:docs` and `pnpm validate:contracts` passed. The latter ran 18 validator cases including AV-13 and AV-15. Product witnesses remain tracked by their implementation tasks.
  - Depends on: T01–T03. **P0 exit:** all four specification deliverables are present in the repository, cross-checked and linked to runnable fixtures. Any unresolved behavior, data or wire contradiction blocks the affected code slice.

### P1 — Vault core, persona memory, migration and Memory tab

- [ ] **T05 — Add main-lineage vault schema and immutable history guards.**
  - Files: `web/lib/db/schema.ts`, migrations 0343/0344 + metadata, `web/lib/db/canonical/`, new `agent-memory-vault/types.ts` and store modules.
  - Implement D2 owner constraints, no destructive cascades, append-only history with guarded payload redaction mechanism, stable identities, injection/import/operation records. No dependency on Brain tables for basic vault operations.
  - Tests: `web/lib/db/__tests__/migration-agent-memory-vault.integration.test.ts` owns the migration matrix, including fresh/seeded 0342 upgrade, constraints, retention and no installed `vector`. Matching snapshots and `db:generate` show no schema changes. Logging: migration/import state and store effect IDs, never payloads.
  - Depends on: T04.
- [ ] **T06 — Implement command service, path validation, quotas and per-note CAS.**
  - Files: new `agent-memory-vault/paths.ts`, `commands.ts`, `store.ts`, `limits.ts`; adapt `web/lib/agents/memory-store.ts`, `native-memory-write.ts`, `web/lib/instance-config.ts`.
  - Implement all six MCP commands, bounded paging, append-only delete/clear/rename/revert, current-content conflicts and content-guarded idempotency. Use D2 lock ordering and atomic quota accounting. Extend the existing project native memory source guard with exact vault revision capture/refusal in this phase, including on alias GET and 409. Require current read rights before replaying a receipt and stable identity/version checks before accessing its payload.
  - Establish the minimal shared server-derived external-input classifier and fail-closed review-required gate here, before T07 exposes writes; T17 replaces that explicit interim refusal with pending proposals.
  - Tests: traversal/Unicode/path pure cases; real two-client same-note/different-note/first-create/delete/rename/clear/over-quota races. Assert loser blocked at store lock and one exact head effect, including guard-disabled control where practical.
  - Logging: DEBUG command/cap/lock timing metadata, INFO committed operation, WARN CAS refusal. Depends on: T05.
- [ ] **T07 — Expose authenticated MCP/HTTP vault operations and deprecated alias.**
  - Files: existing memory routes plus D7 command/read route family, `mcp/src/tools.ts`, `mcp/src/toolsets.ts`, `web/types/token-scopes.ts`, `web/lib/tokens/{ext-handler,verify}.ts`, scope-contract tests and OpenAPI.
  - Implement P1 view, history, revision-detail and command routes from D7, including browser revert/clear via commands. Derive self-vault from server-bound credential. Human endpoints resolve project/attachment first. Preserve the old index endpoints' compatibility semantics and mark `agent_memory_write` deprecated for one release. P3 adds its pending response to both HTTP and bundled MCP dispatch.
  - Tests: real route service + MCP stdio schema/dispatch parity, forged persona/run/project, hidden conflicts, disabled memory, read member vs viewer, edit member denial/admin success. Until P3, forced-review mutation refuses before a head write.
  - Logging: scoped actor/operation/result/deprecation IDs, no body. Depends on: T06.
- [ ] **T08 — Inject versioned protocol and DB manifests on standalone project launch.**
  - Files: `web/lib/agents/launch.ts`, new `agent-memory-vault/protocol.ts`, `injection.ts`, relevant prompt-application/session persistence helpers.
  - Implement D3 empty-vault and bounded protocol/index/tree rendering, marker escaping, immutable injection descriptors and manifest hash discrimination. Remove new filesystem snapshot writes. Freeze actual dispatched selection and settle application receipts through existing delivery/recovery machinery.
  - Tests: migrate `memory-launch.integration.test.ts` and `web/lib/run-results/__tests__/findings-access.integration.test.ts` from filesystem evidence to DB receipts. Assert payload bytes/size/hash, escape reserved control markers, empty/missing index, override and same-context resume, lost application receipt reconciliation and absence of new vault files. Retain the protected-finding source distinction.
  - Logging: DEBUG protocol/manifest version and lengths; INFO applied injection receipt; ERROR capture failures. Depends on: T06, T07.
- [ ] **T09 — Wire Flow drivers and node-persona identity without vault confusion.**
  - Files: `web/lib/flows/runner-agent.ts`, `web/lib/flows/graph/runner-graph.ts`, `web/lib/agents/{flow-binding,effective,tokens,project-links}.ts`, attach-edit modal and native node attestation consumers.
  - Resolve each active session's actual persona before injection and tool-token minting; support flow run driver persona and `settings.agent` precedence. Remove forced memory-off for flow attachments; require explicit attachment to enable memory. Carry identity through retry/idle resume and reject stale attempt tokens. Explicitly handle the shared-session subagent limitation from D3 in validation/UI.
  - Tests: `agent-driven-flow.integration.test.ts`, `flow-binding-floor.test.ts`, `memory-lifecycle.integration.test.ts`; two different-persona nodes see different vaults, same-persona parallel writes obey CAS, two parallel prompt receipts retain both manifest entries, absent attachment cannot implicitly gain memory, scratch/no-persona unaffected.
  - Logging: DEBUG attested persona/attempt/attachment resolution; WARN mismatch/missing grant. Depends on: T07, T08.
- [ ] **T10 — Implement resumable legacy import and fenced cutover.**
  - Files: new `web/scripts/import-agent-memory-vault.ts`, `web/package.json`, memory store legacy reader confined to import, migration/import receipts and cutover admission guard.
  - Implement the D8 states inventoried → imported → verified → activated → cleaned. Keep cleanup a separate explicit action after activation. Constrain filesystem traversal to the inventoried runtime root and exact regular files, rejecting symlinks and identity drift. Preserve oversized legacy content through the overflow rule, and classify matching/missing/mismatched run snapshots independently. Route/token admission checks the durable generation.
  - Tests: new real-Postgres import integration with temporary source files, disabled/detached ownership, oversized refusal, changed source, death at each boundary, re-run no duplicate revisions and no data loss. Existing historical hashes remain unchanged.
  - Logging: INFO counts/receipt IDs/checksum verification, WARN unresolved owner/source drift; no imported text. Depends on: T05–T09.
- [ ] **T11 — Replace the single-file drawer with the Memory surface.**
  - Files: `web/components/agents/agent-memory-control.tsx`, `web/components/board/panels/agent-memory-drawer.tsx`, project agent page/tab, new vault tree/history/edit components, `web/messages/{en,ru}.json`.
  - Tree and view-only history with dedicated edit page/modal (reuse installed Markdown editor), create/delete/rename/clear/revert through one aggregate command endpoint. URL-backed selected path/tab/page, current-content conflict recovery, disabled/empty/loading/hidden/error states; role checks server-side. Reserve one-line filtered Inbox link for P3, no proposal cards.
  - Tests: new `web/e2e/platform-agents-memory.spec.ts` under existing authenticated pattern, covering member/viewer/settings editor, tree/paging/edit/history/revert, responsive keyboard/focus and EN/RU. Migrate old drawer callers; no alternate blind writer remains.
  - Logging: existing client error boundary only; server command logs own effects. Depends on: T07, T09, T10.
- [ ] **T12 — Wire deployment caps and finish P1 validation/docs.**
  - Files: `.env.example`, `deploy/maister.env.example`, `docs/configuration.md`, `docs/getting-started.md`, `docs/deployment.md`, `web/CLAUDE.md`; inspect `Dockerfile`, `compose.yml`, `compose.production.yml`, `compose.public.yml`.
  - This checkout's compose services are Postgres-only, and `compose.override.yml` does not exist: caps belong to host web EnvironmentFile, not invented app service blocks. Update relevant topology comments only if needed. No new port, mount or sidecar; experimental Docker runtime receives documented env passthrough. Validate coupled config and import CLI packaging. SET/CLEAR/re-SET memory enablement/policy projection tests where persisted config is involved.
  - Validation: P1 test migration inventory below, main-only boot, docs/contract/type/lint gates and full phase suites green; mark only delivered contracts Implemented. Logging: safe CONFIG diagnostics and command gate output.
  - Depends on: T05–T11. **P1 exit: project vault plus both persona paths qualified; forced-review writes not auto-applied.**

### P2 — Frontmatter, links, tags, backlinks and search

- [ ] **T13 — Parse and transactionally index note structure.**
  - Files: new `agent-memory-vault/{frontmatter,links,indexes}.ts`, main migration 0345/schema, shared command service.
  - Implement D5 syntax, safe YAML bounds, alias ambiguity, headings/entity links, deletion/rename/revert reindexing and dangling/backlink semantics. Backfill active P1/imported heads without creating revisions. Make rebuilding resumable by exact head revision and safe against a concurrent edit. Keep malformed legacy content in a repair state. Reject malformed new reserved frontmatter before commit.
  - Tests: pure parser cases plus Postgres head/index atomicity and concurrent rename/create resolution; no foreign hidden target metadata. Logging: DEBUG parser counts/version and non-content validation reason. Depends on: T12.
- [ ] **T14 — Add lexical and explicitly configured vector search.**
  - Files: new `agent-memory-vault/search.ts`, Brain embedding provider/ranker adapters, `web/lib/brain/schema.ts`, Brain migration 0012, existing indexing worker registration.
  - Core lexical index is main-lineage and bilingual; optional vector projection is keyed by exact revision/generation and never published into shared Brain records. Reuse provider/ranker mechanics without changing Brain recall contracts. Source filters precede top-K; redact/delete disables stale candidates immediately. Durable reindex jobs use fenced completion, bounded retry and keyset progress, not a new clock.
  - Tests: main-only lexical search, pgvector when configured, stale generation and tombstoned revisions, visibility before ranking, bounded retry/poison item and real scheduler registration seam. T18 adds the redaction race when redaction is reachable. Logging: query lengths/ranking mode/profile/timing/job attempts, no query or snippet text. Depends on: T13.
- [ ] **T15 — Expose search/tag/backlink tools and Memory navigation.**
  - Files: MCP registry/dispatch, D7 routes, vault UI, message catalogs, scope/enforcement mirrors.
  - Add `memory_search`, `memory_backlinks`, `memory_tags`; bounded stable cursors and visible-only counts. UI adds backlink panel, tag filter, alias/dangling indicators and authorized entity navigation; no graph view. Search/error state is URL-backed; no inline row mutation.
  - Tests: HTTP/MCP schema parity, UI filter/navigation, hidden tags/counts/dangling existence, active revision update after edit. Logging: DEBUG operation/count/cursor metadata only. Depends on: T13, T14.
- [ ] **T16 — Complete P2 regression and documentation checkpoint.**
  - Files: affected vault/Brain tests, `docs/system-analytics/agent-memory.md`, DB/ERD/API/config/screen artifacts, requirement coverage cases.
  - Extend `web/lib/brain/__tests__/private-memory-isolation.integration.test.ts` to prove vault notes never appear in shared Brain import/recall. Ensure index rebuilding cannot mutate immutable note history and provider failure is explicit. Update designed/implemented status and generated ERD.
  - Validation: P2 runnability, focused E2E, all phase suites green and docs/contracts clean. Logging: validation output only. Depends on: T13–T15.

### P3 — Review policy, redaction, promotion and one Inbox

- [ ] **T17 — Persist policies, external-input taint and pending vault proposals.**
  - Files: main migration 0346/schema, attachment settings, new `agent-memory-vault/{policy,proposals}.ts`, mutation/launch/trigger/task-source/resume/steering consumers.
  - Implement D6 auto/review outcomes, persisted launch witness and monotonic external provenance from webhook/task external source through descendants/retry/continuation. Human editing is separately authorized. Capture exact diff/author/base; pending writes leave heads untouched and bounded. Old alias uses same service.
  - Tests: auto+manual, review+manual, auto+webhook, external-task manual trigger, inherited/steered external content, policy changes, duplicate proposal and quota races; SET/CLEAR/re-SET persisted policy. Logging: INFO effect/proposal IDs, DEBUG policy reason, no diff text. Depends on: T16.
- [ ] **T18 — Implement CAS review actions and revision redaction.**
  - Files: proposal/domain services, revision payload guards, admin redaction/revert routes and UI history modal.
  - Apply/reject with current authority, immutable base/source checks and same-transaction receipt; test accept/accept and accept/reject races. Implement D5 admin-only redaction, head tombstone and removal from all derivative content channels. Revert cannot reintroduce redacted or newly hidden source content.
  - Tests: real Postgres stale CAS, source revocation, caps changed while pending, partial directory proposal refusal, conflict/history/receipt payload denial and non-admin denial. Assert a worker completion that raced redaction cannot revive a vector cache entry. T19 and T35 qualify the evidence and card cases at their own boundary. Logging: INFO audited decision/redaction reason code and reference IDs, WARN conflict. Depends on: T17.
- [ ] **T19 — Promote exact vault revisions through existing governed proposals.**
  - Files: new vault promotion service, Brain/knowledge source-reference and proposal services, MCP `memory_promote`, existing schema validators.
  - Resolve explicit destination under current rights and retain exact source revision plus fine-grained restrictions. Create pending proposal and promotion receipt in one transaction. For Brain, use its existing guarded submission primitives with a mandatory human-review admission for this origin, even when another proposal path auto-drafts. Both destination review and subsequent governed reads honor the exact source dependency. Handle deleted/redacted source, duplicate key and changed destination payload.
  - Tests: project Brain and company/project knowledge targets, narrower source than destination, no auto-draft, revocation before accept, and redaction before and after accept cannot expose the source in evidence or dependent content. Logging: INFO source/destination/proposal IDs, no content. Depends on: T17, T18.
- [ ] **T20 — Add canonical reviewer-filtered Inbox read model and batch service.**
  - Files: new `web/lib/queries/knowledge-memory-reviews.ts`, shared review dispatcher, existing `brain/{proposals,knowledge-proposals,knowledge-proposal-query}.ts`, D7 Inbox routes.
  - Disjoint source union, one list/count predicate, per-action affordances, stable pagination/filtering, exact source access before previews. Batch delegates to existing domains and vault service with per-item transactions/results; no parallel decision engine.
  - Tests: mixed legacy/native/vault populations, proposer-not-reviewer excluded, differing Brain accept/reject rights, hidden source/count, stale/repeated/opposite decisions and partial batch outcomes. Logging: bounded batch/item IDs, authorized outcome and timing. Depends on: T18, T19.
- [ ] **T21 — Extend attention SSE and rail with neutral reviews.**
  - Files: `web/app/(app)/layout.tsx`, `web/app/api/attention/stream/route.ts`, `web/lib/use-attention-stream.ts`, `web/components/attention/attention-live-refresh.tsx`, `web/components/chrome/{left-rail,left-rail-nav}.tsx`, attention notification consumers and contracts.
  - Implement the D6 review version contract in initial props, counters, reconnect and refresh routing. Verify both stream branches that emit ticks and reauthorize the current reader on each counter pass. Preserve the project-change cursor when only reviews move. Test existing and new client baselines to prevent refresh loops. Review invalidation must stay out of amber publication.
  - Tests: stream reconnection, role loss while connected, no hidden counts, same-count replacement, collapsed/mobile/expanded rail accessible labels; no periodic client refresh. Logging: DEBUG authorized counter/generation transitions only. Depends on: T20.
- [ ] **T22 — Build the Inbox group and remove duplicate decision controls.**
  - Files: `web/app/(app)/inbox/page.tsx`, review components, Brain panel/actions, `web/app/(app)/knowledge/proposals/**`, knowledge decision controls, Memory UI, EN/RU catalogs.
  - Filterable single review surface with details/diff, multi-select batch actions outside view-only rows and explicit partial results. Fix Inbox empty state. Old Brain/knowledge views link to filtered Inbox; no accepted/rejected control remains there or in Memory tab. Keep history inspectable.
  - Tests: `web/e2e/inbox.spec.ts`, memory spec, source review navigation/deep links, permissions and focus/error behavior in EN/RU. Logging: existing UI diagnostics only; domain owns audit. Depends on: T20, T21.
- [ ] **T23 — Verify integrated webhook-to-Inbox review.**
  - Files: `web/e2e/inbox.spec.ts` and existing authenticated seed/trigger helpers.
  - Exercise webhook trigger → pending mutation → reviewer sees it in Inbox → accept once → updated note and neutral rail count. Verify amber count throughout. Use the entry points from T17–T22 and reuse their DB and stream witnesses for races, redaction and publication isolation.
  - Validation: the browser checks the journey and a durable applied receipt. Detailed error/policy matrices remain in their owning integration suites. Logging: test diagnostics with IDs only. Depends on: T17–T22.
- [ ] **T24 — Finish P3 contracts and first-release readiness.**
  - Files: affected docs/ADRs/status metadata, OpenAPI/AsyncAPI/ERDs, deployment/import instructions and compatibility tests.
  - Ensure P1 temporary forced-review refusal is replaced by durable pending outcome, all writers including alias/UI/internal calls share policy/history, and no second review controls survive. Document one-release alias window and bounded history storage behavior.
  - Validation: P3 focused E2E, full phase suites, docs/contracts/type/lint green; dry-run cutover acceptance, no production apply. Logging: validation output only. Depends on: T23.

### P4 — Installation-scope bindings, principals, provenance and UI

- [ ] **T25 — Extend reviewed company bindings with explicit installation reach.**
  - Files: `web/lib/agents/company-binding-types.ts`, `company-bindings.ts`, `company-agent-definition.ts`, main migration 0347/schema and binding routes.
  - Versioned binding/grant contract, global-admin-only explicit allow-list, company-only default, workspace-none enforcement and exact-revision revoke. Lift memory refusal only for explicit installation binding, preserving all project attachments and legacy company behavior.
  - Tests: historical snapshot decode, no widening after migration/upgrade, positive admin attach and non-admin company-manager denial; authoring/picker/action preconditions agree. Logging: INFO grant/revoke actor/binding/version, WARN policy refusal. Depends on: T24.
- [ ] **T26 — Implement manual and unattended execution principals end to end.**
  - Files: `company-agent-execution-types.ts`, `company-agent-context.ts`, `company-session-context.ts`, `company-run-credential-owner.ts`, company launch/retry/trigger context, `web/lib/tokens/{verify,owned-ext-handler,ext-handler}.ts`, `web/lib/brain/{knowledge-access,knowledge-run-identity}.ts`.
  - New discriminated principal snapshot: manual user-intersection vs unattended agent grant. Revalidate live authority on launch/token/read/write/resume/retry; retain source admin only as provenance. Preserve exact legacy bytes/decoders. No user-null shortcut to broad access.
  - Tests: grant removal, initiating user removal, unattended reviewer departure vs actual grant revocation, stale node credentials, forged principal flag, grant addition cannot widen an existing token, exact binding drift refusal, and retry/reset attacks. Logging: DEBUG principal kind/current authority and INFO credential lifecycle IDs, never token. Depends on: T25.
- [ ] **T27 — Add the strict installation read/proposal facade.**
  - Files: company runtime MCP enforcement profile/mirrors, token scope mapping, project/task/run/activity/Observatory/Brain/knowledge handlers and query services.
  - Build the allow-list and scope-specific query adapters for D4, including the Observatory read facade if required. Parameterize queries by verified principal and enforce response data-class gates. Keep the new installation routes/tools unavailable to live runs until capture and versioned admission are wired. Deny direct mutation/delegation/stand operations at the server handler as well as MCP discovery.
  - Tests: positive case per granted read/propose scope, future project, archived project, denied unlisted scope, cross-project legacy unchanged, no command/file/repo mount capability. Logging: DEBUG target/data class/decision, INFO proposal receipt, WARN unauthorized invocation. Depends on: T26.
- [ ] **T28 — Capture all project disclosures and immutable source unions.**
  - Files: `web/lib/brain/knowledge-disclosure.ts` and restrictions/source-capture helpers, new vault provenance adapter, main migration 0348, every read service admitted by T27.
  - Complete capture for every allow-listed response before enabling the grant. Include list/aggregate contributors, launch input, index/tree/prior-note reads and resumed/inherited context. Serialize read/write capture. Compare against the previous revision and link resolution. Preserve finer restrictions and refuse unknown or overflowing captures before output.
  - Tests: concurrent A/B reads plus write, process death before response, read/inject A → idle → revoke A → resume denied before dispatch, hidden source/link and aggregate contributions, and retained restrictions after source deletion. T29 verifies that a B-only reader cannot see the A+B note.
  - Logging: provenance receipt/count/fingerprint only; no project names in unauthorized responses. Depends on: T26, T27.
- [ ] **T29 — Enable installation vaults with complete visibility filtering.**
  - Files: vault owner/authorization/read/search/injection/review services and company memory route family.
  - `(agent, installation)` persistence and admin management; installation agent mutations always pending. All derived surfaces use source-union+fine restriction checks, including conflict content, history, tags/backlinks, manifest/tree, review count and promotion evidence. Empty-source notes still require installation reader authority.
  - Tests: admin sees/reviews, members with A+B vs only B, revoked source access, index hidden without existence leakage, vectors and pending proposal visibility, same agent's project vault remains separate. Logging: DEBUG safe visibility decision code, INFO mutation/proposal IDs. Depends on: T25, T28.
- [ ] **T30 — Wire grant-only cron/event execution into existing scheduling lifecycle.**
  - Files: `company-cron-dispatch.ts`, `company-event-dispatch.ts`, company trigger/source/reservation and specialist intake services, `web/lib/scheduler.ts`, existing chain-depth and retry/resume consumers.
  - Enable manual admission only when T25–T29 are in place, and enable grant-only cron/event through existing source review, singleton tick, claim/reservation and pool. Preserve `MAISTER_MAX_CONCURRENT_AGENTS`, live slot release/admission and `runs.agent_chain_depth`. Trigger kind and source appointment select the principal. Preserve existing authenticated webhook behavior and deny any unsupported installation trigger. Missing chain provenance fails closed.
  - Tests: actual scheduler claim→dispatch for cron, event source lineage, cap race, bounded retry/poison candidate progress, grant revocation in queue/resume and chain exhaustion. A task/proposal must not automatically launch cross-project work.
  - Logging: INFO source/claim/run/principal/outcome, WARN bounded retry/refusal with reason. Depends on: T26–T29.
- [ ] **T31 — Add admin installation attach/edit and Memory navigation.**
  - Files: existing company binding administration surface/routes, agent attachment/picker UI, company memory screen and EN/RU catalogs.
  - Explicit all-current-and-future-nonarchived-projects grant explanation, allowed scopes, workspace-none validation, proposal-only write summary and revocation. View-only table with modal/page editing, one aggregate endpoint and URL state; no implicit widening on ordinary company edit.
  - Tests: authenticated admin UI and denial for non-admin manager; inspect grant version and Memory/Inbox links; configuration enable/disable/re-enable leaves history intact.
  - Logging: existing client diagnostics; binding domain audit is authoritative. Depends on: T25, T29, T30.
- [ ] **T32 — Qualify P4 isolation and update contracts.**
  - Files: installation authority/provenance/scheduler integration suites, existing company bindings/context/records/cross-project/budget tests, relevant docs and generated ERD.
  - Run D4 positive/negative matrix across manual/unattended, active/archived/future projects, company-only/installation, stale/current credentials and resumed/fresh context. Preserve ordinary company agent and company Flow runtime; do not implicitly enable installation-reach coordinators/delegation.
  - Validation: cron reads A+B→pending restricted note→admin Inbox accept; B-only all-channel absence; full phase suites and docs/contracts green. Logging: validation output only. Depends on: T25–T31.

### P5 — Librarian knowledge/vault reads and confirmed proposals

- [ ] **T33 — Enable narrowly admitted librarian read tools.**
  - Files: `web/types/token-scopes.ts`, both librarian toolset mirrors, `owned-ext-handler.ts`, `knowledge-access.ts`, knowledge read handlers, vault target resolver and `web/lib/librarian/` session profile/disclosure capture.
  - Admit `knowledge_search/get/evidence/witness_get/conflicts`, existing Brain reads and the explicit `agent_vault_*` read tools/routes from D6/D7 through active owner's live rights. No raw conversion of arbitrary bearer into user. Keep owner-message, read-only explain and tokenless summary modes explicit. Projectless installation reads apply D4/D5 source filters. Personal memory unchanged.
  - Tests: existing librarian authority/admission/visibility/profile/toolset tests plus positive knowledge/vault reads and missing/hidden equivalence. Logging: DEBUG tool/turn/target class and outcome only.
  - Early delivery after T12 may include knowledge reads and `agent_vault_list/view`. Register search/backlinks/tags after T15. Expose installation targets once their guarded reads are available.
  - Depends on: T04, T12, T15, T29, T30 for full completion.
- [ ] **T34 — Route knowledge, Brain and vault mutation tools into confirmation cards.**
  - Files: `web/lib/librarian/cards.ts`, tool adapters, MCP registry/toolset, ext librarian cards route, operation payload/schema mirrors and confirmation UI/i18n.
  - Add discriminated knowledge-proposal, Brain fact/proposal and vault-command card types, including `agent_vault_propose_edit` dispatch. Freeze complete payload/diff/evidence/base/target/digest; show exact pending action. Projectless cards admit only separately authorized company knowledge/installation vault targets. Explain cannot propose. No effect before confirmation.
  - Tests: every tool creates one owner-bound card; raw mutation endpoints still deny librarian bypass; duplicate/changed-key handling, captured turn sources and hidden-target refusal. Keep new card types unadvertised until T35 can settle them. Logging: INFO card/turn/type/digest creation, no proposed body. Depends on: T24, T33.
- [ ] **T35 — Execute confirmed effects atomically under owner's current rights.**
  - Files: `web/lib/librarian/card-decisions.ts`, operations/recovery/reset barriers and shared vault/Brain/knowledge transaction entry points.
  - Recheck live owner, source and target/CAS, then execute as human and settle card+operation+effect receipt+audit in one transaction. Vault edit applies with `editSettings`; installation needs admin; knowledge returns pending proposal, not publication; Brain returns owner-authorized proposal/item. No second confirmation for the same vault edit.
  - Tests: permission revoked after card, stale hash, source redacted while a card is open, repeated/opposite decision, cancellation/reset race, crash/rollback, same request different body and immutable author attribution. Accepted card must point to an actual durable effect and replay must respect current disclosure restrictions.
  - Logging: INFO owner-via-librarian effect receipt, WARN stale/denied; ERROR failed transaction without hidden content. Depends on: T34.
- [ ] **T36 — Complete librarian UI acceptance and scope regression.**
  - Files: `web/e2e/librarian-acceptance.spec.ts`, `web/playwright.librarian.config.ts`, card/authority/operation/memory-boundary suites, librarian authority/docs/screens/API schemas.
  - Ask to record a project Brain fact → visible card → confirm → durable owner-attributed proposal/item. Cover knowledge pending review and vault apply, EN/RU, hidden project, stale rights and no pre-confirm effect. Preserve ADR-190 personal-memory paths and existing owner confirmation behavior.
  - Validation: separate librarian runner actually lists/executes the scenario; all P5 phase suites and docs/contracts green. Logging: validation output only. Depends on: T33–T35.

### Final integration — Namespace integrity and release acceptance

- [ ] **T37 — Reconcile ADR/migration allocation against integration base.**
  - Files: only colliding new ADR/index/status references and new migration SQL/journal/snapshots/schema; affected prose and tests.
  - After an authorized rebase, re-read base maxima, allocate unique numbers and grep all numeric/prose references. Never renumber historical ADRs or rewrite migrations applied durably. Re-derive shared CHECK constraints from current schema, preserve migration order main→Brain and regenerate ERD.
  - Validation: newest snapshot exists; `db:generate` clean; real migration fresh/upgrade fixtures; ADR anchor/bijection and docs gates. Logging: validation output with old/new allocation map only. Depends on: T24, T32, T36.
- [ ] **T38 — Execute integrated acceptance and adversarial regression gates.**
  - Files: affected integration/E2E and contract tests; only fixes directly necessary for this feature.
  - Execute the acceptance matrix below against isolated real Postgres and supported local supervisor/MCP seams. Reuse real facade routes for authorization; fake ACP is acceptable for deterministic prompt transport but must be labeled. Run targeted real adapter/MCP smoke with configured credentials before claiming adapter qualification. Review every fix cycle for data leaks, scope bypass, stale identity, event-ordering and lock races; rerun affected gates after a fix.
  - Validation: all required suites run, green with exact commands and exit status; distinguish local evidence from hosted CI/live provider acceptance. No production dispatch or remote mutation is implied. Logging: bounded test diagnostics only. Depends on: T37.
- [ ] **T39 — Verify release cutover and compatibility on disposable data.**
  - Files: import/cutover integration fixtures, compatibility tests and canonical deployment/configuration docs.
  - Rehearse old state → import → verify → cutover → new writes → restart → cleanup using the existing tests' fixtures. Observe the version fence, preserved historical receipts, lease/runner retirement and filesystem state. Verify backup/rollback boundaries and refusal of unsupported binaries or uncaptured sources.
  - Validation: `pnpm validate:docs`, contract checks, all phase gates and release acceptance. Record any provider/hosted qualification separately with its actual execution result. Logging: migration receipts and validation output only. Depends on: T38.

## TDD execution and test ownership

Apply this cycle to each behavior slice in P1–P5, including migration, authorization, wire and UI changes.

1. **RED.** Start from the agreed specification and a discovered test in the owning runner. Record the requirement ID, test path/name, command, pre-fix revision, and failing observable with expected and actual values. Use the normal entry point or the boundary that owns the invariant. For migration tests seed the immediately preceding production schema, then apply the real migration and assert the changed invariant. Missing infrastructure, skipped tests, compile errors and assertions that only check for a missing implementation do not qualify as behavioral RED.
2. **GREEN.** Implement the smallest coherent behavior satisfying the specification. Run the same witness, then adjacent compatibility cases at the affected boundary. Reuse existing authorizers, admission locks, scheduler and receipts. Keep HTTP/MCP/SSE adapters thin, domain policies independent of transport, explicit transaction/admission interfaces, strict types and typed domain failures. Use SOLID for responsibility boundaries, DRY for shared authority/invariants and KISS for routes and state. Preserve project conventions and EN/RU.
3. **REFACTOR.** Simplify the production path and test setup while keeping the same assertions and user-visible contract. Improve existing helpers where appropriate. Rerun the focused witness and complete owning suites, generated schema parity and relevant lint/type checks. If behavior changes, start a new RED cycle with an updated spec. The resulting evidence records exact commands and exit statuses without raw note/source bodies.

| Test boundary | Assertion it owns |
| --- | --- |
| Pure unit/contract fixture | Input partitioning and stable deterministic transformations: path/encoding normalization, frontmatter and links, command transforms and canonical digest. Tables include at least one valid case plus meaningful edge classes. Schema fixture parity tests exercise encoded requests and responses. Duplicate equivalent tests, schema boilerplate and render snapshots without behavior are omitted. |
| Postgres integration | Actual constraints, migrations, source authorization and revoke timing, atomicity, replay, quotas, locks, outbox/counter behavior and durable row effects. Use independent clients and controlled barriers for races, and assert committed revisions/receipts. Route tests cover auth, error shapes, bounded parsing and read/disclosure semantics on real handlers. Test each rule at its actual enforcement layer. |
| MCP/ACP/worker integration | Verify advertised tools and privileges against actual dispatch, status/error translation and prompt/scheduler/recovery seams. Fake ACP may drive deterministic sessions to verify the application's bytes and receipts. Record when a real adapter was exercised separately. |
| Playwright | One essential browser journey per surface: Memory edit/history/revert, webhook review in Inbox with rail update, and librarian confirmation. Include targeted deep-link, accessibility or EN/RU assertions where an interaction needs them. Reuse existing specs and seed helpers. Keep role, policy and race matrices in integration tests. |

Run discovery and capture a clean applicable baseline before the first RED slice. Investigation of failures preserves existing regression intent. A phase passes only when all required new cases execute, the applicable full suites are green, and the tested contract matches the spec. Leave unrelated failures outside feature scope by documenting their exact pre-change baseline and following the project's existing quarantine process if needed. A failure in a feature witness, new regression or unexecuted required test blocks that phase. Qualification tasks rerun the assigned witnesses on the integrated candidate and avoid creating duplicate cases.

## Existing test assertion migration and runner map

| Existing tests | Required change / invariant |
| --- | --- |
| `web/lib/agents/__tests__/memory-store.test.ts` | Move path encoding/disk IO behavior to legacy-import tests; new paths/caps are pure-function tests. Remove old unreadable/over-cap silent degradation expectations. |
| `web/lib/agents/__tests__/memory-store.db.integration.test.ts` | Preserve actual same-note first-writer/update/clear race proof; add distinct notes and shared quota/directory racers. |
| `web/lib/agents/__tests__/memory-launch.integration.test.ts` | Replace standalone-only, whole-file and disk snapshot expectations with protocol/index/tree, manifest version, node identity, disabled/empty/override/resume and failed capture assertions. |
| `web/lib/run-results/__tests__/findings-access.integration.test.ts` | Preserve the protected-finding regressions. Replace disk snapshot and broad project-memory references with exact vault-revision restrictions. Verify real alias GET and authorized conflict disclosure capture, plus refusal/guard on destination reads and writes. |
| `web/lib/agents/__tests__/memory-lifecycle.integration.test.ts` | Remove forced flow-memory-off assertion; preserve detach/reattach/repin ownership/history; add explicit absent-attachment refusal. |
| `web/app/api/projects/[slug]/agents/[agentId]/memory/__tests__/route.integration.test.ts`, `web/app/api/v1/ext/agent/memory/__tests__/route.integration.test.ts` | Compatibility alias plus new current-content CAS, immutable history, reviewer policy and owner/persona authorization. |
| `web/lib/agents/__tests__/agent-driven-flow.integration.test.ts`, `flow-binding-floor.test.ts` | Driver vs node persona, actual token/attestation dispatch and no subagent vault impersonation. |
| `web/lib/brain/__tests__/private-memory-isolation.integration.test.ts`, `proposals.integration.test.ts`, `company-records.integration.test.ts`, `knowledge-query-planning.integration.test.ts` | Keep private stores out of Brain; preserve per-kind review/source rights and add restricted revision evidence. |
| `web/app/api/attention/stream/__tests__/route.integration.test.ts`, `web/lib/queries/__tests__/decisions.integration.test.ts`, `web/lib/notifications/__tests__/attention-consumer.integration.test.ts` | Third neutral count/review generation, no amber/push pollution, same-count updates, permission revocation/reconnect. |
| `web/components/attention/__tests__/attention-live-refresh.dom.test.ts`, `web/components/chrome/__tests__/left-rail-nav.test.ts` | Separate accessible Inbox counts and refresh without polling/loops. |
| `web/lib/agents/__tests__/company-bindings.integration.test.ts`, `company-agent-context.integration.test.ts`, `company-flow-context.integration.test.ts`, `company-execution-snapshot.test.ts`, `cross-project-reach.integration.test.ts`, `agent-budget.integration.test.ts`, `turn-admission.integration.test.ts` | Historical company behavior unchanged; explicit new principal/reach positive cases, cap/chain and live revocation. |
| `web/lib/librarian/__tests__/{authority,cards,operations,session-profile,memory-boundaries}.integration.test.ts` | New read/card discriminants, owner attribution, no direct writes, unchanged personal memory and reset/recovery. |
| `web/app/api/v1/ext/__tests__/{librarian-admission,librarian-visibility,librarian-audit}.integration.test.ts` | Narrow knowledge/vault admission, hidden targets, mode separation and same-transaction audit. |
| `mcp/src/__tests__/{tools,tool-contract,librarian-tools}.test.ts`, `mcp/src/__tests__/stdio.integration.test.ts`, `web/lib/tokens/__tests__/scope-contract.test.ts` | Schema/toolset/enforcement/scope-action parity. Assert alias compatibility in schema validation and real stdio command/202/error dispatch. |

New pure tests live under `web/lib/agent-memory-vault/__tests__/*.test.ts`; DB/route tests use `*.integration.test.ts` in existing `lib/**` or `app/**` runner globs. Use `web/test-support/pg-container.ts` for main/Brain test setup; never point at a dev DB. MCP tests use its own unit/integration projects. New memory browser spec uses `platform-agents-memory.spec.ts`, which matches the current authenticated Playwright naming rule; Inbox uses `inbox.spec.ts`. Librarian acceptance runs through `playwright.librarian.config.ts`, since it is intentionally excluded from the default project.

Before each phase exit, list tests using `pnpm --filter maister-web exec vitest list --project unit` and the corresponding integration project, plus MCP list and Playwright `--list` for changed tests; verify filenames are collected. Run commands separately, not chained:

```text
pnpm --filter maister-web typecheck
pnpm --filter @maister/mcp typecheck
pnpm --filter maister-web exec eslint <changed-web-files>
pnpm --filter @maister/mcp exec eslint <changed-mcp-files>
pnpm --filter maister-web test:unit
pnpm --filter maister-web test:integration
pnpm --filter @maister/mcp test:unit
pnpm --filter @maister/mcp test:integration
pnpm --filter maister-web test:e2e --project authed platform-agents-memory.spec.ts inbox.spec.ts
pnpm --filter maister-web test:e2e:librarian librarian-acceptance.spec.ts
pnpm validate:docs
pnpm validate:contracts
```

Run only relevant focused browser lanes at each phase and all three delivery journeys at final integration. Include supervisor full unit/integration gates where changed enforcement or execution contracts touch supervisor code. Integration and E2E require Docker. Record harness failures and unexecuted cases explicitly. Record the exact candidate revision, results and coverage of each phase.

## Acceptance matrix

| ID | Specification and required witness | Primary test owner and tasks |
| --- | --- | --- |
| AV-01 | D2/D3. Apply a one-line `str_replace` to one of 20 notes using only patch and preconditions. The other 19 heads are identical. Two differently scoped node writes succeed. A same-note race yields one new revision and one 409 with the authorized current body. | Postgres command/Flow integration (T06, T09) |
| AV-02 | D3. Fresh enabled launch injects only protocol, bounded index and bounded visible tree as memory. Verify exact bytes/hash and marker escaping. Two parallel receipts retain both sessions. Same-context resume preserves the prior manifest and refuses a revoked source. | Existing memory-launch/prompt application and Flow integration (T08–T09, T28) |
| AV-03 | D4/D5. Deny viewer body/metadata. Allow member read and settings editor mutation. Admin redaction removes exact revision payload from history, diff, search, replay, injection and referenced destinations. Retain ordinary deletion/detach history. | Postgres route, redaction and source-consumer integration (T07, T18–T19, T35) |
| AV-04 | D6. Webhook mutation is pending, reviewer accepts in Inbox, note changes once, neutral count changes and amber remains stable. External task, retry and steer cases use the policy service tests. | Authenticated Inbox Playwright (T17, T23) |
| AV-05 | D4. A grant-only cron reads A+B and proposes a note restricted to A+B. B-only reader with company binding read grant sees missing, authorized A+B reader sees the applied note, and admin sees/reviews the proposal. | Scheduler/memory integration with real read handlers (T28–T32) |
| AV-06 | D1/D4. Explicit grant reaches future nonarchived projects. Archive, cross-project launch/delegation and ungranted tools refuse. Manual user/grant intersection, immutable binding version, cap and chain-depth behavior hold. Legacy company/project reach keeps its prior effective scope. | Binding, credential and scheduler integration (T25–T30) |
| AV-07 | D6. Librarian request for a project Brain fact creates a confirmation only. Confirm creates an actual owner-attributed proposal/item. A required permission or source disappearing at confirm has zero effect. | Librarian Playwright for the journey and confirmation integration for races/refusals (T34–T36) |
| AV-08 | D4/D6. Librarian owner/explain read coverage for each knowledge and vault tool. Hidden equals missing. Confirmed knowledge proposal stays pending, confirmed vault edit follows human authority, direct librarian mutation refuses. Personal memory regressions remain green. | Librarian route/operation integration (T33–T36) |
| AV-09 | D5. Frontmatter, tags, links and backlinks index the exact head. Verify alias/dangling and legacy repair behavior, lexical and configured vector ranking after filtering, stale worker refusal and shared Brain isolation. | Parser unit table and Postgres search/index integration (T13–T16, T18, T29) |
| AV-10 | D8 and migration matrix. Fresh main without `vector`, seeded upgrade, verified import overflow/retry/cleanup and preserved legacy hashes. Fresh and upgraded optional cache migration preserve Brain rows. New writes and manifests are DB-only after cutover. | Migration and import integration (T05, T10, T14, T37, T39) |
| AV-11 | D6/D7. Brain/knowledge pages and Memory tab link to one Inbox review surface. Mixed batch reports applied, stale, denied and replay outcomes. Test independent accept/reject rights. Verify EN/RU accessibility and deep links. | Inbox batch integration and browser navigation (T20, T22–T23) |
| AV-12 | D2/D3/D7. Reject traversal and invalid command shapes before mutation. Exercise create/delete/recreate with same bytes, unique rename destination, directory conflict and quota race. Same-key/same-digest replay returns the original permitted result. Changed digest conflicts. | Existing CAS integration plus deterministic path/patch tests (T06–T07) |
| AV-13 | D6. Equal count but changed visible item or action changes review version. Review-only reconnect reconciles at the same cursor. Revocation stops visibility and hidden-only activity emits no review invalidation. Amber notification projection has no review side effects. | Real attention SSE route and publication integration (T21) |
| AV-14 | D4. Read/capture and write interleavings yield the correct union. Provenance overflow refuses the new disclosure and leaves the prior set intact. A run returning a private conflict body captures that dependency. Deleted project/source cannot shrink the retained restrictions. | Capture/Findings integration (T06–T08, T28) |
| AV-15 | D7. Real route and MCP schema/dispatch parity, first writer state, old/new disabled mapping, 202 pending and hidden/no-store responses. Advertised tool lists match credential scopes at runtime. | OpenAPI/MCP validators and transport integration (T07, T15, T17, T27–T29, T33–T35) |
| AV-16 | D2/D6. A reviewer cannot accept stale/disabled/over-quota or redacted content. Concurrent accept/reject settles one outcome. Promotion pins the source revision and retains exact restrictions through review and accepted reads. | Proposal/revision/evidence Postgres integration (T17–T20) |
| AV-17 | D3/D4 and screen spec. Use the Memory tab to browse tree/history, save an edit, and revert as a newly attributed revision. Exercise narrow viewport and keyboard focus with localized text. | Authenticated Memory Playwright (T11, T15) |

### Executable fixture ownership

The P0 schema cases for AV-13/AV-15 execute in
`scripts/validate-contracts.test.mjs` through `pnpm validate:contracts`.
The witnesses below run when their owning behavior slice lands. A test
description carries the referenced requirement ID and keeps the observable
assertions at that boundary.

| Requirement | Runner and primary witness |
| --- | --- |
| AV-01, AV-12 | Web integration `web/lib/agents/__tests__/memory-store.db.integration.test.ts` for independent connections, old hash after A→B→A, exact head count and transactional quota. The Web unit project owns the canonical path case table. |
| AV-02 | Web integration `web/lib/agents/__tests__/memory-launch.integration.test.ts` for exact manifest bytes and repeat application. Extend the existing Flow driver test for distinct authorized node personas. |
| AV-03, AV-16 | Web integration `web/app/api/projects/[slug]/agents/[agentId]/memory/__tests__/route.integration.test.ts` for role defaults and conflict payloads, and vault proposal integration for redaction and decision CAS. |
| AV-04, AV-11 | Web Playwright `authed`, `web/e2e/inbox.spec.ts` for the webhook journey. Web integration `web/lib/queries/__tests__/decisions.integration.test.ts` owns mixed proposal authorization and batch behavior. |
| AV-05, AV-06 | Web integration `web/lib/agents/__tests__/company-bindings.integration.test.ts` and `company-agent-context.integration.test.ts` for reviewed reach and actor resolution. A cron claim through the real reservation path provides the A+B effect witness. |
| AV-07, AV-08 | Web integration `web/lib/librarian/__tests__/operations.integration.test.ts` for confirmation, live owner changes and effect uniqueness. `web/e2e/librarian-acceptance.spec.ts` uses the librarian Playwright config. |
| AV-09 | Web unit for bounded frontmatter and link grammar. Web integration `web/lib/brain/__tests__/private-memory-isolation.integration.test.ts` protects Brain separation; the vault indexing tests check visible-only ranking and stale generation. |
| AV-10 | Web integration `web/lib/db/__tests__/migration-agent-memory-vault.integration.test.ts` seeds 0342 and exercises fresh, upgrade and repeated migration. Import tests use disposable files and check exact DB receipts before cleanup. |
| AV-13 | Web integration `web/app/api/attention/stream/__tests__/route.integration.test.ts` for stable counts with changed eligible items and the same cursor, alongside the P0 frame-schema cases. |
| AV-14 | Web integration `web/lib/run-results/__tests__/findings-access.integration.test.ts` for private conflict witness and capture before publication, plus installation capture integration for overflow and source revocation. |
| AV-15 | P0 Node contract fixture, MCP `unit` tool-contract check, MCP `integration` stdio route fixture and owning Web route tests for actual response envelopes. |
| AV-17 | Web Playwright `authed` `web/e2e/platform-agents-memory.spec.ts` for editor and revert behavior. |

### Policy interaction cases

| Actor and input | Current policy/authority | Expected durable result |
| --- | --- | --- |
| Project standalone or attested Flow persona, trusted input | Attached and enabled, project preference auto, sources retained | Applied with one operation and revision receipt. |
| Same persona, webhook/external task or inherited taint | Attached and enabled, project preference auto | Pending after P3. A P1/P2 build refuses before mutation. |
| Same persona, trusted input | Attached and enabled, project preference review | Pending even when its Run started with auto. |
| Detached, disabled, stale node attempt or spoofed acting agent | Current binding check fails | No mutation, proposal or vault disclosure. |
| Installation manual, ordinary request | Reviewed binding plus current initiating user and source rights | Authorized data captured under the Run lock. Only a pending proposal may be created. |
| Installation reviewed cron/event | Frozen allowed operation and live agent grant | Same proposal-only result, audited as agent. No user principal substitution. |
| Installation manual or unattended loses a source | Grant remains but source or binding revision fails recheck | No subsequent read or proposed write under the old capture. Ordinarily hidden target semantics. |
| Authorized reviewer accepts after source changes or head is stale | Decision privilege remains | No head effect. Source refusal or conflict. |
| Librarian owner confirms a previously valid card | Source redacted, owner rights changed or target moved | No effect and no settled success receipt. |

## Commit plan

Commit locally after each verified phase.

1. P0, T01–T04: `docs: specify agent memory vault and review authority`
2. P1, T05–T12: `feat: add versioned agent memory vault and legacy import`
3. P2, T13–T16: `feat: add vault links tags and scoped search`
4. P3, T17–T24: `feat: govern knowledge and memory reviews in inbox`
5. P4, T25–T32: `feat: add installation agents and vault provenance`
6. P5, T33–T36: `feat: expose knowledge and vaults through librarian confirmations`
7. Final integration, T37–T39: `test: qualify memory vault migration and authority boundaries`

## Explicit exclusions

No librarian package/Flow/settings management; no scheduled dreaming/consolidation; no graph-view UI; no new OS isolation claim; no optional installation repo checkout; no cross-project automation/delegation; no change to Project Brain or structured knowledge publication semantics beyond exposing their existing proposal decisions in Inbox and carrying exact vault evidence. Implement only after a separate implementation instruction.

## Planning validation

- On 2026-11-17, `pnpm validate:docs` passed repository index and ERD checks (193 indexed documents, 196 tables). `pnpm validate:contracts` passed the existing wire contracts, schema parity, validator tests and Company Brain traceability. These are baseline checks. P0 will add the Designed contract artifacts and their fixtures.
- Plan refinement preserves the 39 task IDs and commit checkpoints. P0 owns writing the specifications and P1–P5 own the product TDD witnesses.
