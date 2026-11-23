# Implementation plan for Flow Studio packages, agent sessions and human questions

**Branch** `feature/studio-catalog-imports` · **Created** 2026-11-24 · **Implementation baseline** `22df665aa` plus the existing node-skills changes in this worktree.

## Feature request in English

Let package authors assemble versioned skills, MCP servers and session agents in Flow Studio from approved public sources. Make package-level sharing automatic on project attachment, give project maintainers explicit overrides, and let triage or a user select a Flow without configuring a capability profile on each task. Give an agent-bound node the selected agent’s prompt, skills, tools and private session. Keep standalone launches scoped to the agent. Prepare only the selected MCP servers on the execution host assigned to the Run. Extend `ask_human` so a librarian can ask inside its conversation and an agent node can receive a human answer through Inbox and continue its work.

The author can import, edit and update pinned skill trees and reviewed MCP descriptors. Skill sharing defaults on per package; MCP sharing defaults off per server. A project inherits package choices and can override an MCP, add connected MCPs to an individual agent, or edit and compare its local persona. A bound Flow node materializes its agent definition from the correct pin in its own ACP session. The release must demonstrate one design Flow, one unrelated coding Flow and one standalone agent on the same project without leaking private tools between them. A remote supervisor must handle HTTP connections, install and reuse pinned stdio packages, and reach the web API for the built-in facade. Human answers return to the original librarian conversation or the waiting Flow attempt after restart.

## Settings

- **Mode** Full, current branch and worktree. The implementation and commit checkpoints below are future work.
- **Testing** Spec-driven development with RED → GREEN → refactor for each behavior change. Focused integration, E2E and real-host acceptance. Prefer existing harnesses. Record observed artifacts, tool results and recovery behavior. Use focused unit tests for pure resolver, digest and compatibility cases.
- **Logging** Standard structured diagnostics with optional DEBUG detail. Use INFO for transitions, WARN for retryable failures and policy refusals, ERROR for exhausted recovery. Carry operation, package, run, attempt and host identifiers where relevant. Redact credentials, headers, private endpoints, persona text, file bodies, questions and answers.
- **Docs** Mandatory `$aif-docs` checkpoint for each changed contract with EN/RU public and UI parity.

## Roadmap Linkage

Milestone: "none"

Rationale: The user chose a branch-scoped delivery plan without a roadmap milestone.

## Implementation baseline

- Studio already supports package composition, local import, version cuts and project adoption. The public catalog connectors and source update path are planned.
- The node-level `settings.skills` and `settings.enforcement.skills` retirement is **implemented locally** in the worktree. New authoring and cuts reject them, stored revisions retain their historical read/dispatch contract, and prompt skill mentions remain supported. The local `maister-plugins@b716f9bcc` audit covered 16 packages, 49 Flows and 275 nodes, with zero retired keys. The sibling author guide has its own working-tree edit. Previous focused verification passed 274 unit tests, 17 integration tests, 8 Playwright checks, typecheck and documentation checks. Preserve this completed work in the first implementation checkpoint.
- Node role binding already works, including `bmad-bmm:sally-ux` in the sibling repository. The ordinary project resolver currently combines role text and task text, the agent definition accepts MCP refs, and standalone launches use providing-package skill roots. Explicit agent skill selection and complete delivery of its profile to a bound node remain to implement. Named ACP sessions currently allow cross-node reuse.
- Package attach registers MCP records with `selectedByDefault`. MCP Hub target binding and disabled/trust/runner checks exist. Native install, readiness and remote selection require host-specific work. Task/Flow qualification already has routing metadata and a triager. Use a prototype and a bugfix as distinct `route_when` examples.
- Standalone agents already support task-bound human asks. Specialist-assignment-backed native Flows also have an attempt checkpoint and answer continuation. Ordinary project Flow nodes and inline librarian cards are the new contexts. Preserve the existing standalone code-delivery retrigger and operational same-Run continuation contracts.

## Author experience

A package author opens a new local package or forks an installed package, then chooses **Skills → Add from catalog**. They search approved sources or paste a supported skills.sh or GitHub link, review the publisher, exact revision, license, file tree and destination, then add a skill. It opens in the existing skill editor with its companion files. The author can edit the instructions in the draft. Attaching the released package makes those skills available automatically to its Flows and standalone agents.

**MCP → Add from catalog** follows the same interaction. The preview shows the publisher, transport, endpoint or distribution, required configuration, supported runners and local reference. In Studio the author sets “Share with all project Flows and agents” independently on each MCP declaration. It starts off for a new declaration. Attaching a release automatically inherits the scope from that package revision. The project MCP Hub shows the effective scope and its source. A maintainer can override it for one server in either direction or choose “Use package setting” to resume inheritance. Studio shows what the package supplies and what the project must configure. Commit and Cut version use the existing package lifecycle. A second project can attach that same version.

Both tabs search external sources as the author types. Debounce input, cancel superseded requests and render only results for the current query, including after clearing it. Show loading, empty, per-source error and rate-limit states. Selecting a result opens a preview. Importing or updating content requires the author’s explicit action.

**Update from source** is an explicit action. Show the upstream changes, local edits and affected references. Conflicts require a decision in the draft. A new cut and project adoption make the changes effective. Keep earlier revisions reproducible.

## Existing contracts and implementation decisions

| Concern | Reuse and required change |
| --- | --- |
| Studio authoring | Reuse composition tabs, skill subtree editor, package diff, editor lock, validation and version cut. The current folder/archive importer accepts local files. External discovery needs a source resolver and a reviewable, recoverable apply operation. See `web/components/studio/{package-composition,skill-screen,import-dialog}.tsx`, `web/lib/local-packages/{import,lock,versions}.ts`. |
| Skill delivery | A fresh scaffold writes `skills/<slug>/SKILL.md`. Project attach reads skill trees under manifest `capabilities[].path`. Store imported trees under manifest-registered roots so the existing project bundle materializer can discover them. Retire the legacy node-level skill list as recorded in the implementation baseline. For a fresh package, use the shipped `capability/skills/<slug>/` convention and register its bundle. For existing packages, select a declared root explicitly when ambiguous. Preserve the current draft browser for legacy paths and offer explicit registration/move on use. See `web/lib/{packages/attach,capabilities/package-catalog,capabilities/package-skills,flows/editor/reference-sources,local-packages/scaffold}.ts`. |
| MCP delivery | Studio lists manifest declarations and `mcps/*.yaml` files. Project attach reads `maister-package.yaml` → `mcps[]`. Use the manifest declaration as the executable contract. Derive the descriptor editor from it for catalog imports and keep file edits, rename, removal and node references consistent. Project the imported refs into the existing project MCP Hub and resolve them using the existing bindings. Detect ambiguous or divergent legacy pairs before release. See `web/lib/{packages/manifest,packages/attach,local-packages/bom,mcp/materialization-gate}.ts` and `web/components/flows/artifact-editors/mcp-template-editor.tsx`. |
| Origins | The existing manifest supports descriptive `metadata.sources`. Add a versioned, portable import record in the package for machine comparisons. Record catalog ID, publisher/repo, source URL, commit and subtree or registry record version, source digest, destination, license/notice and applied content digest. Author edits change the current package digest while preserving the original source identity. Distinguish source evidence from the instance's current approval. |
| Package precedent | The sibling `maister-plugins/packages/core-skill-authoring` already ships curated upstream skills in a registered capability bundle and records their origin. Use its layout as a compatibility fixture. The existing project-scoped Git capability importer and the whole-package Studio fork/upstream lifecycle have different ownership and update targets. |

## Sources and trust decisions

- **Skills.** Start with the publisher-maintained [Anthropic skills](https://github.com/anthropics/skills) and [Vercel agent skills](https://github.com/vercel-labs/agent-skills) in the operator-approved set of public GitHub repositories and index their skill directories for search on a plain self-hosted installation. Accept skills.sh links that resolve unambiguously to one approved repo and skill. Pin the commit before reading bytes. Resolve directory identity from the source tree, since a catalog slug can differ from its directory name. Show official publisher status and audit findings only when supplied, with their scope and date. The documented skills.sh search, curated set and audit API use Vercel OIDC. Qualify self-hosted access independently before enabling native global search. An unavailable connector should report its status while the GitHub source remains independently selectable. [skills.sh API](https://skills.sh/docs/api) · [Official collection](https://skills.sh/official) · [Agent Skills bundle format](https://agentskills.io/specification)
- **MCP.** Consume curated metadata from the official Registry, or an operator-approved public repository containing a supported, versioned descriptor. The Registry verifies publisher namespaces and points to a distribution or hosted endpoint. Keep registry ID and collision-checked MAIster reference separate. Start with concrete, approved HTTPS Streamable HTTP endpoints requiring no credentials. An entry with a different transport, OAuth, a distributable package or ambiguous alternatives explains what is required. A later local-server slice covers reviewed stdio distributions from public repositories. [MCP Registry](https://modelcontextprotocol.io/registry/about)
- **Authority.** An instance administrator approves source scope. A package editor previews and applies to their editable target. Project adoption, MCP target bindings, runtime execution trust and company authority retain their existing owners. Keep these decisions visible independently. A review of downloaded skill content includes embedded instructions and companion code. Limit the first skill import to fully representable, reviewable text bundles. Reject an unsupported file or limit violation before writing anything. Preserve applicable upstream license and notice files, including repository-level notices.
- **I/O.** Fetch public content with a restricted source client, bounded retries and size limits. Validate redirect destinations, resolved addresses, archive members, link types, normalization and per-file/total budgets. Fetch and preview do not execute installers, hooks, package scripts or MCP commands. Build the apply request from the reviewed snapshot. UI-supplied URLs, file paths, catalog labels and provenance files cannot grant runtime authority.

## Runtime contract

### Run materialization and Flow dependencies

- **Run preparation.** For each project Run executing a Flow, capture and materialize every package attached to the project at launch. Preserve package identity in the prepared trees. Later attachment or version changes apply to subsequent Runs.
- **Flow skills (proposed).** A Flow ships the skills required by its authored prompts. An unbound agent node discovers its Flow package’s skills plus the libraries shared with project Flows. A node with a session agent applies the agent profile described below. The package-level “Share skills with all project Flows” checkbox defaults to on, including when the manifest omits it. Core is shared through this default. An author can turn it off, for example to keep design skills within the design package. MCP sharing has an independent, per-server default of off. Use the pinned package metadata, independent of package name, number of Flows or MCP declarations. Capture the exact source pins at launch, including for a child Flow and retry. Qualify existing shared skill bundles before switching existing projects to scoped discovery.
- **Discovery.** Expose the same skill inventory to the adapter and progressive-disclosure prompt. An owning-package skill wins a same-slug collision with an optional library. Surface conflicting shared-library slugs before launch so install order cannot select the content. An optional shared skill can improve a Run. A Flow that explicitly requires a skill must ship it for portability under the current contract.
- **Standalone project agent.** Use the same pinned agent skill selection as a bound node, with only the providing package as its skill source. Keep the limited MCP list declared by the pinned agent. Add MCPs intentionally shared with all project sessions and explicit instance additions from the project Hub. Instance owners can remove their own additions. Inherited servers are read-only on the instance.
- **MCP sharing (proposed).** The versioned package declaration owns the default scope. Store only explicit project overrides, keyed by project attachment and logical MCP ref. Resolve the override if present, otherwise use the adopted release’s setting. Keep an explicit override even when a later package version happens to match it. Reset removes the override. Package scope supplies the default MCP set for that package’s Flows and lets its agents select their declared refs. A narrower explicit node selection keeps its existing meaning. A project-shared ref joins every eligible project Flow and standalone project agent session. For a bound agent node use its declared refs as the local MCP selection before applying explicit node MCP settings and shared project refs. Sibling nodes resolve their own selections. An explicit project-agent addition can use a connected server from another package without changing its sharing scope. Scope controls automatic delivery. Project bindings, credentials, disabled targets, trust, adapter checks, required vs additional semantics, and company execution keep their existing authority.
- **Resolution boundary.** Resolve an explicit deduplicated MCP set on the server before host preparation, native adapter configuration, probe and ACP session creation. Preserve existing non-package project MCP configuration and platform facade rules. Zero selected package refs produces an empty package server list. Preparing all attached package trees must not start servers, emit native MCP configuration or expose tools from an unselected package. Carry the owning Flow and persona package pins and scope snapshot into the Run. Resolve a child Flow against its own package and preserve shared-session profile consistency.
- **Implementation owners.** Project capture and bundle preparation live in `web/lib/tasks/launch-capability-materialization.ts` and `web/lib/capabilities/materialize-bundle.ts`. Trace source package identity through the existing run/revision pins into `web/lib/capabilities/{adapter-home,package-skills}.ts`. Keep the shared run preparation separate from each session’s discoverable skill directories, including when several sessions share a workspace. Qualify runners that discover skills through cwd as well as runners that use generated homes.

### Package agent profiles and session isolation

- In the Studio package agent editor, select skills from that agent’s package and MCP refs from the package declarations. Extend the existing strict agent `capability_profile` with optional `skills` alongside `mcps`. Resolve refs against the pinned revision, round-trip manifest and editor, and validate missing refs before cutting a release. An omitted skill selection preserves the whole providing-package bundle. An explicit empty list selects zero of that package’s skills.
- For an `ai_coding` node binding a `mode: session` agent, resolve its effective prompt and declared capabilities together, including when its package differs from the Flow’s. The explicit selection replaces the contribution from the agent’s own package even if that package also supplies the Flow or shares its skills. The Flow’s own skills (when a different package) and other libraries shared with project Flows remain discoverable. Use package-qualified provenance and pin the selected agent skill on a slug collision. A standalone launch uses the same declaration without the Flow libraries. Continue to support node-level MCP refinements and automatically shared MCPs. Resolve any required-ref conflict before starting the attempt.
- Give each bound node its own logical ACP session within the same Flow Run. Scope the conversation handle, adapter home, skill discovery paths, and MCP configuration to that node. Resume a suspended attempt using its own session and captured profile where supported. Retry and rework retain their existing policies within that node boundary. Prevent both directions of cross-node session reuse, including explicit named sessions and parallel attempts. Surface shared named-session conflicts when authoring a new revision and preserve historical revision semantics. The existing Claude subagent mode keeps its own delegation contract.
- Verify with two adjacent nodes using different agents, the same logical session name as a conflict case, and an agent from another pinned package. Assert distinct actual ACP session IDs, an actual read of the selected skill and a companion, absence of an unselected private skill in discovery, and a real call through the expected MCP on the assigned host. Inspect the sibling’s actual tool list, skill index and adapter config for leakage. Repeat with overlapping attempts and a same-attempt continuation. Cover older definitions with no skill selector and an explicit empty selection.

### Agent nodes and human input

Use the existing `ai_coding` node binding (`settings.agent`, `mode: session`, agent trigger `flow`). The node executes inside the originating Flow Run. Declare its result or artifact and let the graph advance on completion. Use a `form` for a planned clarification and a `human` review for approval or rework. A question raised during an ordinary agent node uses the proposed attempt-bound continuation in Phase 6. Existing specialist-assignment Flows supply the checkpoint and continuation precedent. Qualify the planned package/agent/node MCP resolution using the actual server list for a bound designer and its sibling session.

## Decisions for implementation

**Compatibility and source ownership.** Version the new package delivery semantics so an old adopted revision without a per-server field preserves its recorded legacy behavior. A newly authored MCP declaration defaults to package scope. Skill sharing defaults to on even when omitted. Preserve omitted versus explicit-empty agent skills. Capture package install pins, copied skill digests, persona body and digest, MCP origins and logical targets, scope and node/attempt ownership on existing Run, session or attempt records. Keep secret values out of snapshots. Dispatch, retry, resume, child routing, completion, cleanup, read models and audit read these witnesses. Recheck current access, revocation and host assignment at the action boundary. A removed or incompatible target yields a diagnosis with its logical ref.

**Identifiers and access.** Extend existing authenticated routes and reuse their status conventions. Finalize concrete paths and response examples in T02. Apply the following identifier rules to each route in the group.

| Surface | Identifier and authorization rules |
| --- | --- |
| Studio catalog search, preview, apply and update | Draft ID is a URL parameter. Actor and edit authority come from auth context. Query, catalog ref/link, skill selector, preview ID and expected draft version are body/query-controlled. Derive destination root, approved origin, exact bytes and draft lock from server state. Bind the preview to actor, draft, source digest and draft base. Validate read permission for file previews and diffs. |
| Project package scope and agent instance PATCH/read/diff | Project slug, attachment/agent ID and MCP ref are URL parameters resolved together. Actor and project role come from auth context. Scope, additional refs, prompt and expected revision are body-controlled. Resolve allowed refs, stable link, base install and actual rights from server state. Check definition-read access for both sides of the diff and editSettings on mutation. |
| Host prepare, readiness and probe | Run/session/command URL identifiers resolve through authenticated host/assignment state. Fence commands, receipts, downloads and any later publication by assignment epoch. Body-controlled artifact identifiers must match reviewed Run inputs. Resolve executables, platform and cache destinations inside the host workload. Use host admin authority separately for an operator’s diagnostic probe. |
| Librarian ask/answer, project node ask and Inbox/Run answer | Credential identifies caller kind, conversation owner or authorized execution. Derive conversation/segment/turn or project/Run/node attempt/turn and current recipient from server state. Question fields, options, answer and request key are body-controlled. Check card/request URL parameter against that state. Human answer requires current conversation ownership or current project assignment authority. Existing standalone endpoint compares task locator to token. A private card and a project Inbox item have separate audiences. |

**Writes and recovery.** Use the existing domain owner’s durable intent, compare-and-set (CAS), transaction and observed completion receipt. For catalog apply lock the draft, for overrides lock the stable attachment/link with its expected revision, for an answer lock the request and owning turn/attempt, and for install lock the runtime/OS/arch/artifact digest on the selected host. Competing actors on the same resource must produce one winning effect. Compare canonical payload digests on every replay. Include the content revision and normalized inputs in the digest; keep wall clock, random IDs and secrets out. Stage files on the same filesystem and publish atomically. Reconcile interruption before publish, after publish but before DB acknowledgement, and after acknowledgement before response. Inspect the exact artifact or delivery receipt before retrying the external effect.

| Result of external work | HTTP behavior and durable state |
| --- | --- |
| Validation, access or stale input fails before claim | Existing 400/403/404/409/422 convention. No external effect. A different answer under a used key returns 409. |
| Durable intent accepted, delivery pending | Return 202 and a stable operation ID where asynchronous. Keep answer acceptance separate from delivery and resumed execution. Idempotent repeats return the recorded state. |
| Timeout, transient network failure or downstream 5xx | Keep pending work retryable. Return 503 for a synchronous request. The existing recovery owner reconciles uncertain effects, retries with bounded backoff and exposes exhausted recovery. |
| Revoked target, terminal Run, replaced attempt or reset segment | Recover the same owner when its checkpoint permits it. On a proved stale or terminal owner, close/reject that operation with 409/410 as appropriate and record the cause. Never deliver its payload to a different owner. |
| Observed success | Commit the matching output/delivery receipt, return 200/201 or finish the prior accepted operation, and emit the live event. Read back state after restart. |

Human waits release the live turn after a recoverable checkpoint. On failed persistence, cancel/close any opened transport request and release its lease; reconcile acknowledged checkpoint intents on restart. Cancellation, supersession, terminal execution and explicit dialog reset settle pending work. Preserve other attempts' sessions and credentials. Reuse durable events and the registered recovery workers. For new worker arms, implement a fair cursor or per-item attempt stamp, capped backoff per intent, fenced lease renewal and a poison-item terminal diagnosis. Test the real worker registration and a healthy item behind a failing item.

## Specification and implementation sequence

T01 and T02 deliver the first reviewable increment. Mark the proposed behavior **Designed** in its owning system analytics. Give each expectation a stable ID, an actor, a precondition, an observable result and a primary acceptance test from the matrix below. Update the analytics index. Use `flow-studio` and `local-packages` for source review and cut, `capabilities`, `mcp-management` and `agents` for resolution and adoption, `execution-hosts` for preparation, `librarian-conversation` for private turns, and `hitl` and `assignments` for attempt questions. Keep each rule in one domain and link its consumers. Include the scope decision table, a draft publish/recovery sequence, a web A → supervisor B/C deployment diagram and separate state diagrams for private and project questions. Document rejection, recovery owner and terminal state for each transition. Follow R3, R5/R5a and R6 in `docs/CLAUDE.md`.

T02 closes when the domain expectations, OpenAPI 3.0.3, AsyncAPI 2.6.0, planned migration sequence, wire examples and test ownership agree. Record deferred choices explicitly. Before changing a specified behavior, revise its governing contract, acceptance row and affected examples together. At implementation, use the existing domain services, strictly typed schemas, pure resolution logic and narrow I/O boundaries. Keep one owner for precedence, authorization and each durable transition. Apply SOLID, KISS and DRY in the repository's functional style. Add an abstraction only for distinct callers or an actual boundary.

### API and event decisions for T02

The following are proposed wire contracts. T02 records the final paths, operation IDs, security schemes, request limits, examples and typed domain errors in the owning spec. Preserve the existing multipart Studio import, project agent PATCH response, legacy task ask and specialist response branches for their existing callers.

| Operation and caller | Accepted request and observable response | Conflicts and recovery |
| --- | --- | --- |
| Studio editor searches with `GET /api/studio/local-packages/{id}/catalog/search` | `kind`, `q` and source-bound cursor. Return 200 with stable source/result IDs, publisher, next cursor and per-source availability. One unavailable source can coexist with valid results. | Reject a cursor from another query/source with 400. All sources rate-limited gives 429 with retry guidance. Total upstream unavailability gives 503. |
| Editor previews with `POST …/{id}/catalog/preview` | Source/result or supported link, selected subtree/distribution, destination and optional existing import identity for an update. Return 200 with preview ID, exact upstream pin/digest, expected draft base, diff, notices and configuration requirements. | Reject unsupported/unapproved input before writes. Bind the preview to actor and draft. Recheck source approval and edit access at apply. |
| Editor writes with `POST …/{id}/catalog/apply` | Preview ID, expected draft base, resolved file conflicts and request key. One operation owns tree plus manifest/provenance. Return 200 with applied draft receipt or 202 with operation ID during reconciliation. Supply a draft-authorized status read for that ID. | Same key and canonical payload reads the receipt after reauthorization, even after the apply advanced the base. Changed payload or stale base returns 409. Missing preview returns 404, expired preview 410. Never refetch a floating revision to complete an apply. |
| Project maintainer sets `PUT /api/projects/{slug}/packages/{attachmentId}/mcps/{refId}/scope` | `scope` takes `package`, `project` or null to inherit. Require expected install and scope revision. Return 200 with declared/effective scope, its origin and revision. Re-reading the Hub supplies the current precondition. | Competing edit/adoption returns 409 with current revision to authorized editor. Unknown or removed ref gives 404. Replayed stale precondition cannot overwrite newer scope. |
| Project maintainer edits existing `PATCH /api/projects/{slug}/agents/{agentId}` | For these new fields require `schedulesRevision` and expected providing install. `additionalMcpRefs` replaces only local additions, empty clears. `promptOverride` accepts text or null to restore inheritance. An omitted field preserves its value. Return existing 200 `{ok:true}`. Read effective origin, current revision and divergence via guarded GET. The diff requires definition-read access on both sides. | Resolve refs against connected MCPs in this project under the same CAS as adoption/link edits. Reject stale saves with 409, invalid new fields with the route's typed validation error, and missing attachment with 404. Keep inherited refs effective on clear. |
| Assigned host prepares selected MCPs | Extend the authenticated command envelope with reviewed install descriptor, digest, host ID, epoch and target runtime. T02 specifies the prepare invocation and receipt schema alongside `POST /mcp-probe`, session create/resume and `GET /commands/{commandId}`. Receipt identifies distribution digest, host/runtime and readiness. HTTP endpoints require a workload probe only. | Same command and identity reuses its receipt. Stale epoch or changed payload gives 409. Never publish a late command into the new assignment. Missing runtime, unsupported distribution and failed integrity have distinct typed terminal reasons. |
| Runtime invokes `ask_human` | Retain the task-scoped external endpoint. Specify separate credential-derived external operations for the librarian and ordinary Flow node. Accept request key, question and typed form/options. Return 201 with stable question ID when durably open, or 202 with pending checkpoint identity. Owner and recipient are server-derived. | An exact replay returns its current state. Another payload with the same key gives 409. A node question becomes actionable only after the matching checkpoint is recoverable. |
| Human answers | Proposed `POST /api/librarian/cards/{cardId}/answer` for owner and existing `POST /api/runs/{runId}/hitl/{hitlRequestId}/respond` for the authorized project responder. Submit the schema-valid answer. Return 202 once claimed and queued, 200 after confirmed delivery, with request ID and current state. | Same answer returns the recorded state, different answer after claim gives 409, invalid form 422, superseded/reset/terminal undelivered owner 410. A current authorization check precedes receipt lookup/disclosure. |

For each new operation define missing credentials (401), denied action on a visible resource (403) and hidden or mismatched resource (404) using the existing route's disclosure rules. Pin bounded retry, error code and response examples per operation. For streams specify channel, audience, event discriminator/version, cursor and reconnect snapshot. Publish only committed transitions. Two views of one question converge on the same ID and state. After a cursor gap the authorized read model reconstructs the outcome. Keep option text, prompt and answers out of general activity streams. Validate example bodies against the schema and exercise producer/consumer parity, including the generated MCP input and unchanged legacy callers.

### Persistence and migration decisions for T02

| Owning implementation | Storage contract and upgrade invariant |
| --- | --- |
| T05 · draft import | Persist exact source/base and reviewed destination in the package. Register a replayable operation under the existing Studio draft lock, using the recoverable operation pattern in `web/lib/local-packages/create-flow-operation.ts`. Compare tree and manifest digests before acknowledgment. A concurrent cut sees one complete revision. Legacy drafts with no origin remain editable. |
| T07 · sharing | Persist sparse overrides keyed uniquely by stable `project_package_attachments.id` and logical MCP ref. Retain the release pin and revision as write preconditions. Adoption rebuilds derived MCP records, so preserve surviving overrides across that rebuild. Remove dropped refs transactionally, never transfer an override on rename by guesswork. Detach deletes the override. Reattach starts with inheritance. |
| T08–T10, T13 · frozen profiles | Add a versioned profile to existing launch/materialization and attempt/session witnesses. Retain canonical package pins, selected refs/digests, persona source, node owner and assignment epoch. Version-gate readers of old snapshots. Preserve historical bytes, hashes, named-session rules and retry identity. Bind an attempt to its Run with existing composite identity. |
| T11–T12 · project agent | Store additions and nullable prompt on the project/agent link or its owned child rows. Enforce unique scoped refs and validate membership at write/dispatch. Adding fields leaves old links inheriting their persona with zero additions. Coordinate attachment and link CAS under one lock order. Legacy field-only PATCH cannot erase newer fields. |
| T14–T16 · host | Reuse execution command receipts and session incarnations for assignment and effect identity. The supervisor owns the verified artifact cache, atomic publish and cleanup. A cache hit never grants current trust. Share artifact bytes only. Keep environment, working directory and credentials isolated per session. |
| T19 · private ask | Extend `librarian_cards` question kind, payload validator and SQL kind/status checks together. Bind to conversation, segment, owning turn and request key. Store accepted answer and delivery receipt separately. Uniqueness scopes replay to the turn. Preserve existing card kinds and reset semantics. Private questions create zero project assignment/HITL rows. |
| T21–T23 · Flow ask | Extend `hitl_requests` shape checks and owner-specific unique indexes for ordinary agent questions. Link the exact Run/attempt, turn, assignment epoch and human assignment. Constrain origin-specific required and forbidden identifiers, including SQL NULL cases. Preserve existing task/retrigger and specialist shapes. First answer intent, claim and delivery command commit atomically. Record delivered state only on matching receipt. |

In each owning task, specify exact columns/types, nullability, checks, uniqueness, composite FKs, indexes for user reads and worker claims, delete rules and deployment order **before** feature writes. Use the next available Drizzle SQL, snapshot and journal entries. For each migration run a fresh install and a populated pre-change upgrade via `web/test-support/migration-upgrade.ts` on disposable Postgres. Seed legacy and live owners, compare row counts, source pins and historical bytes, verify accepted and rejected direct inserts, rerun the migrator and check journal integrity. Use additive schema → compatible readers → writers. A legacy record without sufficient evidence stays on its specified legacy path. Define a write-enable/rollback point per slice. After new-format writes, allow rollback only to a reader that understands them or stop new writes and roll forward. Package rollback in T24 means adopting an older release. It never rewrites retained Run evidence.

For T21 specify the aggregate Run status and slot ownership for parallel questions. The existing specialist path uses a Run-wide current step, released fence and idle status. A waiting node releases only its own live session/credential after checkpoint. Keep the Run runnable while a sibling can work. Enter human-wait idle only when the graph has no runnable or running work and a human wait remains. On answer, revalidate the original attempt and assignment, reacquire capacity and issue one continuation. A concurrent stop or replacement fences the old continuation. Test two pending nodes answered in reverse order and one independently completing sibling.

## Tasks

Each task names the implementation owner, observable acceptance and diagnostic events. `After` lists prerequisite task IDs. The phase checks below apply to every implementation checkpoint.

### Phase 0 — Contracts and compatibility

- [x] **T01. Specify the three capability inventories.**
  - **After** none.
  - Update `docs/system-analytics/{flow-studio,local-packages,capabilities,mcp-management}.md`, `docs/flow-dsl.md` and `docs/screens/studio/editor.md`. Freeze the bound/unbound/standalone matrix, exact ref precedence, skill name collisions, sharing defaults, removal/reset, required MCP refusal and native discovery on each supported adapter. Record prompt/agent/package origin at launch. Keep per-task profiles and project-instance skill editing open.
  - **Acceptance** — a worked design/development/core example including cross-package agents, a disabled binding and a child Flow.
  - **Diagnostics** — specify DEBUG provenance and WARN refusal fields.
- [x] **T02. Specify storage, authorization, protocol and recovery.**
  - **After** T01.
  - Update `docs/system-analytics/{hitl,execution-hosts,librarian-conversation}.md`, `docs/supervisor.md`, `docs/database-schema.md`, domain ERDs and the contract map below. Enumerate each allow-listed transition, status, question origin, recipient, reset, token scope, host failure and read surface. Reserve the next ADR/Drizzle numbers at implementation start (checkout head has ADR-217 and migration 0368). Recheck the journal before merging; regenerate snapshots and validate fresh DB, populated upgrade and repeat.
  - **Acceptance** — the specification gate above passes. Register a `studio-catalog` group with the existing requirement coverage validator and index `docs/system-analytics/studio-catalog-traceability.md`. Check forward and reverse task coverage, concrete Planned test IDs, both wire readers, deployment order and a populated upgrade fixture per storage owner.
  - **Diagnostics** — define audited operation/actor and host receipt fields.
- [x] **T03. Retire node-local skills in new Flow authoring.**
  - **After** none.
  - Local prerequisite already delivered in `web/lib/config.schema.ts`, `web/lib/flows/manifest-parser.ts`, node forms, grammar, tooltips, fixtures and EN/RU docs.
  - **Acceptance** — the baseline audit above and regression for old immutable manifests versus new cuts. Preserve stored strict enforcement and the existing prompt composer.
  - **Diagnostics** — existing parser refusal surface and code. Carry the local edits through implementation checkout and review.

### Phase 1 — Reviewed catalog import into a versioned package

Verification on Node 24 included a live read of Anthropic frontend-design at e4bb5d960d87126ff3b3a8af1a104b7db67560ba with its notices and the Registry record ai.sageteacher/learning-printables@1.0.0. IT-CAT-03 passed six PostgreSQL apply, cut and recovery cases. E2E-CAT-02 passed on a production Web build, checking both imports, edited companion bytes, version cut and project attachment. The Studio and local-package regression suites passed 263 cases.

- [x] **T04. Implement approved source discovery.**
  - **After** T01, T02.
  - Extend `web/lib/local-packages/` and the Studio route family; reuse existing Git imports where safe. Build self-hosted search over approved publisher repositories, resolve supported skills.sh links, and search the official MCP Registry or approved descriptor repositories. Keep Vercel OIDC search conditional on verified deployment support. Preview skill subtrees with relative companions and license/notice files. Normalize HTTP remotes and exact distribution descriptors; unsupported transports explain their requirements.
  - **Acceptance** — real source identity, bounded retries/size, error per source, redirect/address/archive validation, no install execution during fetch.
  - **Diagnostics** — DEBUG source ID, latency, digest, WARN refusal or retry.
- [x] **T05. Preview, apply and update exact reviewed bytes.**
  - **After** T04.
  - Extend `web/lib/local-packages/{import,lock,working-dir-save,versions,sync-merge}.ts` and companion catalog routes beside `web/app/api/studio/local-packages/[id]/import/route.ts`. Serialize atomic writes with save/cut/commit, persist upstream base and notices, detect modified/removed files and local collisions on update. An interrupted import must expose either its complete old tree or complete new tree to cut.
  - **Acceptance** — stale preview, cross-user replay, parallel cut, local edit conflict, idempotent reapply and three crash windows. Verify a fetched fixture with an install script produces no execution effect.
  - **Diagnostics** — INFO applied revision, DEBUG byte/file counts, WARN stale/conflict.
- [x] **T06. Integrate search-as-you-type and source review into Studio.**
  - **After** T04, T05.
  - Extend `web/components/studio/{package-composition,skill-screen,import-dialog}.tsx`, `web/lib/local-packages/{bom,scaffold,rename-artifact}.ts`, `web/lib/queries/package-bom.ts` and `web/components/flows/artifact-editors/mcp-template-editor.tsx`. Use manifest-registered skill roots; migrate legacy layout explicitly. Keep draft MCP descriptor and manifest refs aligned. Support loading, empty, failure, cancellation, keyboard selection and dirty-draft review in EN/RU.
  - **Acceptance** — search A→B→clear with out-of-order replies, import/edit/cut/attach in a second project, and matching draft/installed IDs and companion bytes.
  - **Diagnostics** — server request/operation IDs and outcomes, with user-facing diagnostics.

### Phase 2 — Package scope, agent authoring and effective inventories

IT-CAP-03 and IT-CAP-04 exercised three adopted packages on PostgreSQL, child and owning Flow pins, omitted versus empty selectors, a duplicate slug and distinct private companion bytes during concurrent preparation. The host integration started two ACP processes, observed separate adapter homes and server lists, and resumed the first ACP session by its original ID. Studio picker and raw editor tests passed. Migration 0369 upgraded legacy attachments and retained explicitly set overrides across adoption and rollback.

- [x] **T07. Persist sharing defaults, overrides and adoption.**
  - **After** T02.
  - Extend `web/lib/config.schema.ts`, `web/lib/packages/{install,attach,manifest}.ts`, `web/lib/db/schema.ts`, the project attachment routes and MCP Hub. Store overrides by stable project attachment plus ref across adoption; attach currently rebuilds capability records. Support both override directions and reset. Maintain required-only slots and independent target binding/trust.
  - **Acceptance** — SET/CLEAR/re-add, two projects on different pins, old attachments, dropped/new refs, explicit equal-to-default overrides, and stale concurrent adoption.
  - **Diagnostics** — INFO adoption/override revision and source, WARN version conflict.
- [x] **T08. Add skill and MCP selection to package agent definitions.**
  - **After** T02.
  - Extend `web/lib/agents/{definition,effective,frozen-definition}.ts` and `web/components/flows/artifact-editors/frontmatter-artifact-editor.tsx`. Add optional skill refs beside MCPs, keep omitted/empty distinct in round trips, resolve package IDs and check at cut. Preserve old frozen hashes and signed bytes.
  - **Acceptance** — picker/raw editor parity, missing ref diagnostics and old/new/explicit-empty definitions on standalone and bound paths.
  - **Diagnostics** — DEBUG profile schema version and validated counts, WARN invalid refs.
- [x] **T09. Resolve and freeze the effective Run and session inventories.**
  - **After** T07, T08.
  - Extend `web/lib/tasks/launch-capability-materialization.ts`, `web/lib/capabilities/{resolver,materialize-bundle,adapter-home,package-skills}.ts`, `web/lib/agents/{launch,flow-binding,retry-snapshot}.ts` and `web/lib/flows/graph/runner-graph.ts`. Prepare all pinned packages once per Flow Run, select the correct trees per session, and hand an explicit MCP list to native config and ACP. An empty selection stays empty. Honor node restrictions, agent refs, project sharing and permission preflight.
  - **Acceptance** — two product packages with shared core, same-slug source resolution, child Flow pin, action-time revocation, package adoption during a Run and unchanged old retry witnesses.
  - **Diagnostics** — INFO resolved pin/digest, DEBUG origin and withheld reason per ref.
- [x] **T10. Isolate each bound session agent and its continuation.**
  - **After** T09.
  - Update `web/lib/flows/{runner-agent,graph/runner-graph}.ts`, `web/lib/runs/node-resume-session.ts`, `web/lib/execution-host/{owned-session-create,session-binding}.ts` and the named-session compiler/validator. Fence reads **and writes** of the ACP handle by Run, node attempt and assignment. Give sibling sessions separate adapter homes/tool configs; preserve explicit same-attempt continuation, rework policy, historical graphs and Claude subagent semantics.
  - **Acceptance** — different ACP IDs and tool/skill inventories for adjacent and overlapping agents, a reachable selected companion file, an actual MCP call and an authoring diagnostic for an incompatible shared name.
  - **Diagnostics** — DEBUG owner/epoch/profile and INFO session create/resume.

### Phase 3 — Project agent instances

IT-CAP-05 passed on populated PostgreSQL, including two project instances, stale edits, inherited MCPs, changed trust at dispatch and retry after a persona edit. The production browser scenario passed in EN and RU with keyboard save, divergence tooltip, diff and restore. The running controlled supervisor received the saved prompt. The full three-consumer delivery scenario is tracked separately under T25.

- [x] **T11. Add and remove instance MCP additions.**
  - **After** T07, T08.
  - Extend `web/lib/agents/project-links.ts`, `web/app/api/projects/[slug]/agents/[agentId]/route.ts`, `web/components/agents/project-agents-panel.tsx`, `web/lib/mcp/{hub-service,binding-service,requirements-ledger}.ts` and the link schema/migration. Limit picker and save to connected project servers. Inherited entries are read-only. Removing an addition also declared by an adopted package leaves that inherited ref effective.
  - **Acceptance** — manual/triggered agent dispatch, deduplication, stable refs on upgrade, sibling isolation and denial across project IDs.
  - **Diagnostics** — INFO link revision and origin, WARN unavailable target.
- [x] **T12. Edit, save and compare instance persona text.**
  - **After** T02, T11.
  - Extend the same guarded link PATCH, the agent definition read route, `web/components/agents/project-agents-panel.tsx` and `web/components/workbench/diff-view.tsx`. Render only an accessible icon with hover/focus tooltip for divergence; activation opens a read-only diff against the adopted package revision. Save, clear and restore by CAS. Normalize line endings, distinguish meaningful whitespace, reject blank content, compare again after adoption.
  - **Acceptance** — both EN/RU flows, keyboard use, read/write permission differences and unchanged package bytes.
  - **Diagnostics** — INFO link revision and override state, excluding persona text.
- [x] **T13. Apply effective agent configuration to real launches.**
  - **After** T09, T10, T11, T12.
  - Wire `web/lib/agents/{effective,flow-binding,launch,frozen-definition,retry-snapshot}.ts` and shared agent read models. Freeze effective prompt, origin and selected refs for standalone manual/triggered runs and where a bound Flow actually consumes the persona. Preserve independent system/task prompt planes and company authority.
  - **Acceptance** — two projects and sibling agents, manual versus triggered parity, exact prompt delivered on dispatch and restored on retry, disabled target withheld/refused according to requirement.
  - **Diagnostics** — INFO launch witness and effective persona digest.

### Phase 4 — MCP preparation on the assigned execution host

On two independent Linux containers, a real supervisor and ACP protocol peer called the synthetic HTTP MCP, pinned stdio MCP and bundled MAIster facade. B reused its cache offline. After B stopped, fresh C installed the pinned bytes and rejected epoch 1. The mTLS qualification recorded B epoch 1 receipts d34eba4b-97d3-46dc-88c7-4054a601b70e and d5ae983e-7f59-409c-8f60-86f2d7de53bc, then C epoch 2 receipt ad1818ce-4bb3-4a2a-b5ff-379c80572131. The A/B Playwright lane passed 6/6. The production image sha256:638fe8b37708ce0d6617a890d67b5372ff6da186d49513b34546daf1cb38de2f ran as UID 1001 with a read-only root, dropped capabilities and a writable state volume on Linux arm64. T17 remains open for a tool call against a real public MCP. Automatic approval review rejected the public ACP test because it could transmit project or prompt content. Static inspection of the public distribution and successful local protocol calls cover separate checks.

For a first HTTP smoke test, qualify the public [Microsoft Learn MCP endpoint](https://learn.microsoft.com/en-us/training/support/mcp) and confirm a compatible registry descriptor. For local stdio, derive the pinned package and transport from the [Registry package formats](https://modelcontextprotocol.io/registry/package-types). Record a real tool response from each supported distribution.

- [x] **T14. Route readiness, probes and facade launch by actual assignment.**
  - **After** T02, T09.
  - Trace `web/lib/execution-host/{placement,resolver,client}.ts`, `web/lib/mcp/{probe-service,readiness-host}.ts`, `web/lib/agents/facade-launch.ts`, `web/lib/librarian/session-profile.ts` and `supervisor/src/{http-api,mcp-probe,acp-client}.ts`. Replace local-host assumptions at both selection and transport. Establish web A → supervisor B first. For relocation, use actual registered host-specific endpoints and assignments for B and C; implement the necessary routing on this boundary before qualifying multi-host selection. Run Streamable HTTP from the workload, including DNS, environment and binding checks.
  - **Acceptance** — a real remote tool response and stale-epoch refusal; web/host paths and localhost differ in the fixture.
  - **Diagnostics** — host ID, command ID, epoch, transport and sanitized diagnosis.
- [x] **T15. Prepare a reviewed npm/stdio distribution on demand.**
  - **After** T04, T14.
  - Extend `web/lib/execution-host/contracts.ts`, `supervisor/src/{http-api,mcp-probe,acp-client}.ts` and a supervisor-owned preparation module. Resolve npm publisher association (`mcpName`), exact tarball and transitive integrity, executable, license and platform support. Restrict the initial format to reproducible runnable artifacts under the host execution policy. Acquire with least privilege, stage and verify, then atomically publish a cache entry keyed by full digest and runtime/OS/architecture. Keep secrets session-local. Hand an absolute, workload-visible executable to newSession/resumeSession.
  - **Acceptance** — offline reuse, two concurrent installations of one artifact, crash mid-install, missing runtime, digest mismatch, disabled trust and child cleanup.
  - **Diagnostics** — INFO installation receipt and hit/miss, WARN validation failure.
- [x] **T16. Deployment wiring for HTTP, stdio and the MAIster facade.**
  - **After** T14, T15.
  - Wire binaries/runtime and workload path in `Dockerfile` and the consuming package manifest/lockfile, writable cache/permissions in `compose.production.yml` and the active dev deployment, reachable `MAISTER_API_BASE_URL` and any new settings in `.env.example` and `docs/configuration.md`. Review `compose.yml` (DB-only dev), applicable compose overrides and `docs/getting-started.md` for host services. Deliver the bundled facade inside the remote workload; web and librarian must stop discovering a web-local executable for the remote path.
  - **Acceptance** — production read-only image plus declared cache volume, dev parity, scoped facade call to web, no credentials inherited by unrelated ACP processes, no unselected server started.
  - **Diagnostics** — sanitized readiness capabilities and effective host runtime.
- [ ] **T17. Qualify install and relocation with real tool calls.**
  - **After** T16.
  - Extend `web/e2e/execution-ab-content.spec.ts`, `web/lib/mcp/__tests__/probe-service.integration.test.ts` and `supervisor/src/__tests__/mcp-probe.test.ts`.
  - **Acceptance** — On B, exercise a public HTTP endpoint and pinned stdio artifact, repeat stdio offline, then run on clean C with B unavailable. Call the built-in facade back to A. Inspect exact host assignment, distribution receipt, agent-visible server list, tool result and process cleanup. Gate the multi-host claim on two actual distinct execution environments; local transport doubles remain regression evidence.
  - **Diagnostics** — INFO test run, host, cache digest and actual tool identity, excluding payload secrets.

### Phase 5 — Durable human questions and the private librarian surface

IT-ASK-02 and the populated migration and recovery suites passed 21 PostgreSQL cases. All 568 MCP unit tests and eight stdio modes passed. E2E-ASK-02 used the running Web process, supervisor, stdio facade and a deterministic ACP peer, restarted both services at a pending private question, answered from two tabs, and observed one continuation in the original conversation. The keyboard and reload scenario also passed.

- [x] **T18. Extend the caller-aware ask contract.**
  - **After** T02.
  - Extend `web/lib/services/{agent-question-contract,agent-question,agent-question-response}.ts`, `web/lib/specialist-assignments/flow-question.ts`, `mcp/src/{tools,toolsets,main}.ts` and the generator for `runtime/ask-human-input.schema.json`. Reuse the typed MAIster form, suggested answers and custom responses. Derive caller and owning turn from its ephemeral credential. Expose appropriate inputs without task IDs/retrigger flags for librarian and node calls. Keep existing standalone and specialist shapes independently readable.
  - **Acceptance** — positive and denied calls per origin, unavailable/expired capability, cross-owner forgery, and unchanged legacy tool schema behavior for old callers.
  - **Diagnostics** — INFO origin and request ID, WARN wrong scope.
- [x] **T19. Persist a private question and continue its conversation.**
  - **After** T18.
  - Extend `web/lib/librarian/{authority,cards,conversation,prompt-owner,turn-recovery,reset,stream,toolset}.ts` and scoped librarian HTTP/MCP routes. Bind the pending question to owner/segment/turn, keep an idempotent answer intent and delivery receipt, reconcile worker restart. A tab close preserves pending input; explicit reset supersedes it. Teammate questions about a Backlog task keep their recipient-directed assignment.
  - **Acceptance** — same conversation continues once after a response, access denied to another user, stale reset answer rejected, no private text in project task/Inbox or logs.
  - **Diagnostics** — IDs and state transitions.
- [x] **T20. Render the question inline, with live outcome.**
  - **After** T19.
  - Extend `web/components/librarian/librarian-panel.tsx`, librarian read models, stream and EN/RU resources. Show options, custom input, submit, submitted answer and pending/resumed feedback in transcript order. Reuse existing form controls and private SSE.
  - **Acceptance** — keyboard-only answer, reload, duplicate click/two tabs, server-side errors and eventual continuation in `web/e2e/librarian-panel.spec.ts`.
  - **Diagnostics** — only service-side delivery failure/retry and opaque request ID.

### Phase 6 — Ordinary Flow node questions and Inbox

IT-ASK-03/04 exercised parallel waits, reverse-order answers, lost acknowledgements, revoked authority and the original ACP handle after restart. E2E-ASK-03 ran in Chromium against production Web and the supervisor. Run 567da745-5538-4818-b054-05188244988a, question 8473564f-80ac-45ea-82d9-14b217934993. Separate Inbox and Run forms raced: the winner received 202, the competing claim 409 and the delivered replay 200. Anonymous access returned 401. Both views updated, and the SSE reconnect recovered both durable transitions.

- [x] **T21. Issue the least-privileged node tool and park its attempt.**
  - **After** T10, T18.
  - Generalize `web/lib/specialist-assignments/flow-question.ts`, `web/lib/services/{agent-question,assignment-question-response}.ts`, `web/lib/flows/{runner-agent,graph/action-resume}.ts`. Ordinary nodes need a scoped ask even without a vault configuration. Reuse the checkpoint/pause mechanism and bind the intent to exact execution, attempt, turn and epoch. Fence token revocation, termination observations and open-question lookup to that owner. Prevent stale/cross-node delivery and preserve concurrently live siblings.
  - **Acceptance** — confirmed recoverable park before exposure, recovery from lost acknowledgement, and unchanged specialist-assignment behavior.
  - **Diagnostics** — INFO checkpoint/activation state and owner, WARN stale epoch.
- [x] **T22. Route one question to Inbox and Run detail.**
  - **After** T21.
  - Extend `web/lib/assignments/service.ts`, HITL/Run read models, answer routes, Inbox and Run components. A real human assignment identifies the agent, task, Run and node, with eligible recipient/role and a link. Display the same question from both surfaces. Atomically claim the first eligible answer, return replay or conflict for a second, and distinguish answer accepted from delivery/resumed/failed.
  - **Acceptance** — recipient/role visibility, denial after access change, EN/RU, existing SSE refresh and one answer across tabs/surfaces.
  - **Diagnostics** — answer state and actor ID, never form contents.
- [x] **T23. Deliver the answer and resume the same work.**
  - **After** T14, T21, T22.
  - Extend `web/lib/flows/graph/{action-resume,runner-graph}.ts`, `web/lib/execution-host/{session-binding,owned-session-create}.ts` and existing reconcilers. Reuse specialist answer-prompt/authorized-resume helpers. Target original profile and checkpoint and persist successful delivery/restart evidence. Advance the graph only on its normal node result. Preserve other in-flight work, cancel/reset races and slot accounting.
  - **Acceptance** — checkpoint plus host restart, double delivery, expired assignment, replaced attempt, stop while awaiting an answer and a lost acknowledgement after actual delivery.
  - **Diagnostics** — INFO answer receipt, attempt, host and actual resume status, ERROR exhausted recovery.

### Phase 7 — Adoption and qualification

- [ ] **T24. Exercise adoption, conflicts and rollback.**
  - **After** T05, T07, T09, T12, T13.
  - Extend `web/lib/local-packages/{versions,sync-merge}.ts`, `web/lib/packages/attach.ts` and matching integration suites. Adopt revisions in two projects, diff scope/skill/prompt changes, preserve unrelated local edits and explicitly resolve incompatible renames. Use the migration-tested legacy installation from T07 with a live Run and recorded approvals. Refuse ambiguous reconciliation with actionable IDs.
  - **Acceptance** — set/clear/re-add, rollback, same pinned history, incompatible source guard, package detach and old-version consumers.
  - **Diagnostics** — adoption source/target and reconciliation outcome.
- [ ] **T25. Qualify a design Run alongside development.**
  - **After** T06, T13, T17, T20, T23, T24.
  - Use `web/e2e/`, existing execution-host and public package fixtures. With shared core and deliberately private design/development skill bundles, launch one Flow of each kind. The designer actually reads its selected companion, invokes a design MCP, asks about the checkout path, resumes from the Inbox answer and returns a clickable prototype or inspectable prototype artifact. The developer reads its own/core skill and receives no private design tools, native MCP config or stdio process. Verify a standalone agent’s reduced inventory, one instance addition, shared-scope override/reset, and no per-task package picker. Link T20’s private librarian and T17’s relocation evidence from the qualified build.
  - **Acceptance** — exact run IDs, package pins, ACP IDs, host identity, actual artifacts and tool/continuation receipts. Test a harmless tool on an approved real endpoint/product subject to available credentials; distinguish any substitute from qualification of the named product.
  - **Diagnostics** — evidence references and outcome.
- [ ] **T26. Finish shipping contracts and operator guidance.**
  - **After** T17, T20, T23, T24, T25.
  - Complete the contract map, phased `$aif-docs` checks, public EN/RU instructions and diagnostics for self-hosted catalog setup, install/runtime trust, host relocation, unsupported sources/transports, prompt diff and answer recovery. Cross-check diagrams, schema journal, generated tools and public examples against the accepted build.
  - **Acceptance** — runnable examples and all validation gates below, with actual availability labeled.
  - **Diagnostics** — no new runtime events; verify documented diagnostics against captured events.

## Acceptance ownership and RED → GREEN → refactor

The IDs below seed the domain specifications and traceability matrix. The primary test owns the observable behavior. Add parameter cases to that test for the listed boundaries. Another layer earns a case only if it observes a different failure, such as SQL rejecting an invalid owner, the browser discarding a stale response, or an actual remote ACP tool call.

| Requirement | Tasks | Primary test and acceptance |
| --- | --- | --- |
| CAT-01 · trusted search | T04 | IT-CAT-01 resolves approved repo subtrees and registry descriptors to a pin, preserves notices, distinguishes empty results, rate limit and unavailable source, and rejects unsafe redirects or oversized/unrepresentable content before any write. |
| CAT-02 · authoring | T05, T06 | E2E-CAT-02 searches A→B→clear with reordered replies, then imports, edits and cuts a skill and MCP. A second project reads the exact companion bytes and executable declaration. |
| CAT-03 · atomic update | T05 | IT-CAT-03 races apply against cut and restarts at each publish boundary. Exact replay yields one complete revision. Changed local files, changed request payload and revoked approval cannot silently publish. |
| CAP-01 · node skills retirement | T03 | Reuse T03's existing legacy-read, new-cut and designer regression cases and package audit. New authors cannot set node skills. Old Runs read the original revision. |
| CAP-02 · scope and adoption | T07, T24 | IT-CAP-02 upgrades two populated attachments, sets both override directions, resets, removes and reattaches. Distinct projects keep independent scopes and the old Run still reads the same pin. |
| CAP-03 · per-session inventory | T08, T09 | IT-CAP-03 captures Flow package plus shared core, standalone providing package only, agent omitted/all versus empty/none, and exact selected MCPs, including zero. Ref collisions, child Flow routing, required-ref refusal and revoked targets have deterministic outcomes. |
| CAP-04 · isolation | T10 | IT-CAP-04 observes distinct bound ACP sessions and homes on adjacent/parallel nodes, survives same-attempt resume and rejects named-session crossover. Verify adapter-native discovery as well as the prompt index. |
| CAP-05 · instance | T11, T12, T13 | IT-CAP-05 saves local MCPs and persona on one of two links, rejects stale writes, exercises manual, triggered and bound dispatch, and reads back the same frozen retry. E2E-CAP-05 alone owns keyboard access to icon, tooltip, diff, save and restore. |
| HST-01 · assignment | T14, T16, T17 | E2E-HST-01 calls HTTP, stdio and scoped facade from B, then from clean C with B down. Capture actual host/epoch, tool response, selected server list and process exit. Test stale assignment refusal at the command boundary. |
| HST-02 · installation | T15 | IT-HST-02 races two installers, interrupts staging, verifies digest/runtime mismatch refusal, reuses offline bytes and observes cleanup. An unselected server has zero preparations and starts. |
| ASK-01 · caller | T18 | IT-ASK-01 exercises each generated input against its actual facade and route. Current credential selects owner. Forged locators and expired authority have no durable effect. Existing task and specialist shapes retain their semantics. |
| ASK-02 · librarian | T19, T20 | IT-ASK-02 submits across restart/reset and obtains one reply on the original private turn. E2E-ASK-02 owns inline options/custom answer, keyboard, reload and live completion. Another user and project Inbox cannot read it. |
| ASK-03 · ordinary Flow question | T21, T22 | IT-ASK-03 parks two attempts independently, exposes only checkpointed questions and permits eligible responders. Inbox and Run details show one assignment and agree across reconnect. Claim races yield one accepted answer. |
| ASK-04 · continuation | T23 | IT-ASK-04 loses the delivery acknowledgment, restarts the host and reconciles one continuation on the owned checkpoint. Answer in reverse node order, cancel, replace or revoke and observe graph, slot and credential state for each sibling. |
| CAP-06 · end-to-end release | T25, T26 | E2E-CAP-06 routes a prototype and a coding task with shared core and private design capabilities, captures a design artifact after Inbox continuation, checks standalone inventory and links release-build host and librarian receipts. |

For each behavior slice record its requirement ID, discovered test title, command and revision. **RED** runs the smallest case through the normal entry point on the pre-change behavior and records the expected assertion failure. Fix setup or discovery errors first. **GREEN** adds the minimum production change and verifies the observable outcome. **Refactor** simplifies the implementation with the owner test and its sibling consumers green. For compatibility that is already green, retain the existing test as a regression witness and use the newly introduced boundary for RED. Migrations exercise the same sequence against populated Postgres. Avoid trivial getters, snapshot-only assertions, duplicate mock suites and repeated copies of the same E2E. Mark each row Implemented only when its owner tests pass and evidence is tied to the candidate.

## Contract map and phase gates

| Contract | Governing artifacts |
| --- | --- |
| Package, Flow and agent declarations, compatibility, Studio UX | `web/lib/config.schema.ts`, `web/lib/agents/definition.ts`, `web/lib/flows/flow-dsl-grammar.ts`, `docs/configuration.md`, `docs/flow-dsl.md`, `docs/screens/studio/editor.md`, `site-docs/reference/flow-manifest.md` and its RU counterpart |
| Studio, attachment, MCP Hub, agent and human response HTTP APIs | `docs/api/web.openapi.yaml`, and `docs/api/external/operations.openapi.yaml` where an external operation changes. Cite the concrete example and refusal in the owning Studio, MCP, agent, librarian or HITL analytics. |
| Host preparation/probe/session wire and workload deployment | `docs/api/supervisor.openapi.yaml`, `docs/supervisor.md`, `docs/system-analytics/execution-hosts.md`, `docs/api/async/execution-host-events.asyncapi.yaml` and, for new supervisor SSE events, `docs/api/async/supervisor-sse.asyncapi.yaml` |
| Ask payload and live UI projections | `web/lib/services/agent-question-contract.ts`, `web/scripts/generate-ask-human-json.ts`, `runtime/ask-human-input.schema.json`, `mcp/src/tools.ts`, `docs/api/async/{librarian-stream,attention-stream,web-runs}.asyncapi.yaml`, `docs/screens/inbox.md` |
| Durable metadata, changes and deployment | `web/lib/db/schema.ts`, Drizzle SQL/snapshots/journal, `docs/database-schema.md`, `docs/db/{capabilities-domain,agents-domain,hitl-domain,assignments-domain,librarian-domain,execution-hosts-domain}.md`, `docs/error-taxonomy.md`, `.env.example`, configuration and operator guide |

Use Node 24 and the frozen pnpm workspace. Drive focused integration cases with real disposable Postgres, existing Playwright fixtures and a built facade. Verify new cases are collected by their assigned Vitest project with `pnpm --filter maister-web exec vitest list --project integration` or by Playwright test listing. Update the runner include patterns in the same phase if they are missing. Run each command separately. These are implementation gates; the pre-existing T03 evidence is the only completed behavioral gate.

| Phase | Focused check or existing assertions to extend |
| --- | --- |
| 0 | `pnpm validate:docs:all` and `pnpm validate:contracts`. In historic parser/authoring tests keep legacy-read, new-cut refusal and retired-control assertions separate. Exercise a fresh DB and upgrade on any migration-bearing phase. |
| 1 | `pnpm --filter maister-web test:e2e e2e/studio-local-edit.spec.ts`. Extend Studio composition and version-adoption fixtures to compare registered paths, complete bytes and upstream provenance after cut. |
| 2 | `pnpm --filter maister-web exec vitest run --project integration lib/packages/__tests__/attach.integration.test.ts lib/local-packages/__tests__/version-adopt.integration.test.ts lib/flows/graph/__tests__/runner-graph.materialize.integration.test.ts`. Replace unconditional package defaults only in new-revision cases. Add explicit omitted/empty and sibling ACP-handle assertions. |
| 3 | `pnpm --filter maister-web exec vitest run --project integration lib/agents/__tests__/project-links.integration.test.ts`. Extend agent panel/diff and standalone manual/triggered E2E assertions for origin, access and local text. |
| 4 | `pnpm --filter maister-web test:e2e:execution-ab` plus T17's real host call evidence. Extend probe-service integration and supervisor MCP probe fixtures to assert selected host and workload rather than the local admin transport. |
| 5–6 | `pnpm --filter maister-web exec vitest run --project integration lib/services/__tests__/agent-question.integration.test.ts lib/specialist-assignments/__tests__/project-source-recovery.integration.test.ts lib/librarian/__tests__/turn.integration.test.ts`. Add ordinary-node parallel waits and restart cases beside the specialist fixtures. Run `pnpm --filter maister-web test:e2e e2e/librarian-panel.spec.ts` plus the new Inbox/Run scenario. |
| 7 | Collect T17, T20 and T25 receipts from the release candidate. Rerun any gate whose inputs or build changed. Run `pnpm --filter maister-web typecheck`, `pnpm --filter @maister/supervisor typecheck`, `pnpm validate:contracts`, `pnpm validate:docs:all` and `pnpm --filter @maister/site-docs validate`. |

For each behavior-changing phase, run the web unit and integration scripts (`pnpm --filter maister-web test:unit`, `pnpm --filter maister-web test:integration`) and corresponding supervisor scripts when touched. Keep owner suites green, fix changed expectations in the same phase and identify pre-existing failures by test name against the pinned baseline. A baseline comparison helps diagnose failures. Release requires all applicable suites and acceptance gates green on the shipping build, including interop, migrations, lint, typecheck, contracts and public docs. Repair harness failures, collect missing real-host evidence and rerun affected gates before release. A skipped required case, a changed assertion that weakens its contract, or an unavailable runner leaves its gate open. Review each checkpoint for sibling callers, authorization bypass on reads/writes, deferred cleanup, incompatible legacy rows and missing positive-path evidence.

## Commit Plan

Suggested reviewable checkpoints on this branch:

1. **T01–T03** — `feat(flow): retire node skills and specify package delivery contracts` (record the sibling author-guide edit in its own repository).
2. **T04–T06** — `feat(studio): import reviewed skills and MCP descriptors`.
3. **T07–T10** — `feat(runtime): resolve package scopes and isolate agent nodes`.
4. **T11–T13** — `feat(agents): support project MCP additions and persona overrides`.
5. **T14–T17** — `feat(supervisor): prepare MCP servers on the assigned host`.
6. **T18–T20** — `feat(librarian): answer private agent questions inline`.
7. **T21–T23** — `feat(flow): continue an agent node from its Inbox answer`.
8. **T24–T26** — `test(platform): qualify adoption, recovery and remote agent delivery`.

**Release boundary.** Per-task execution profiles and project-instance skill selection/editing remain open product options. External global skills.sh search depends on supported self-hosted authentication. Additional MCP distribution formats follow qualification of npm/stdio. Company-owned execution keeps its independent authorization and selection path.
