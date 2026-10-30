# Project configuration persistence

## Purpose

(Implemented) Separate runtime application of project configuration from explicit,
reviewed repository persistence. This domain owns export status, review intent,
local commit publication, recovery and separate optional push. Registration and
runtime package/runner behavior keep their existing domain owners.

## Domain entities

- Project export projection and monotonic revision.
- Immutable configuration review / persistence operation and observed SHA receipt.
- Operation-owned private Git worktree/ref; never another configuration source.
- Separate immutable push intent and destination/outgoing-range review.
- See the [project ERD](../db/projects-domain.md) for storage ownership.

## State machine

The commit operation admits only the transitions shown; uncertain effects are
inspected before reentry, terminal outcomes replay without another effect.

```mermaid
stateDiagram-v2
    [*] --> previewed
    [*] --> noop: equal owned values
    previewed --> preparing: valid explicit confirm and durable claim
    previewed --> stale: expired or changed state
    preparing --> prepared: verified private commit
    prepared --> publishing: reviewed state revalidated
    publishing --> committed: observed target publication
    preparing --> failed: proven no-effect failure
    preparing --> recovery_required: uncertain effect
    prepared --> stale: safe supersession before target effect
    prepared --> recovery_required: uncertain ownership
    publishing --> recovery_required: incomplete or uncertain publication
    recovery_required --> prepared: private commit proved
    recovery_required --> publishing: safe partial publication proved
    recovery_required --> committed: target publication proved
    recovery_required --> failed: absence of effect proved
    noop --> [*]
    stale --> [*]
    failed --> [*]
    committed --> [*]
```

## Process flows

A local commit is independent of any later push result.

```mermaid
sequenceDiagram
    actor U as Operator
    participant W as Persistence API
    participant DB as Postgres
    participant G as Git
    U->>W: preview
    W->>G: inspect committed baseline and checkout
    W->>DB: store immutable review
    W-->>U: full diff, branch, message, expiry
    U->>W: confirm previewId
    W->>DB: lock, revalidate, accept intent
    W->>G: private commit and guarded target publication
    G-->>W: observed commit SHA
    W->>DB: committed receipt and manifest locator
    W-->>U: local commit receipt
    opt separate explicit push review and confirmation
        U->>W: pushPreviewId
        W->>G: push exact reviewed SHA and destination
        W->>DB: independent push outcome
        W-->>U: push result without local rollback
    end
```

## Publication protocol (Implemented)

The target is the checked-out configured main branch. Preview performs no
repository write and no remote call. Git inspection disables optional index
refresh writes. A scalar status is observed or explicitly cached/unverified.

1. Acquire the canonical-common-directory repository fence and re-read the
   actor, project export revision, HEAD, source blob, index entries and status.
   Persist accepted intent before creating operation-owned private material.
2. Create a private linked worktree outside the tracked repository. For an
   unborn target, create a private empty root scaffolding commit; amend it with
   the real reviewed commit, resetting author identity. The scaffold never
   becomes a target ancestor. Normal commit hooks and signing apply to the
   reviewed commit. Verify its parent, complete path set, mode, bytes and message.
3. Anchor the prepared commit under `refs/maister/config-persist/<id>` and
   record its SHA. Recovery may also inspect the recorded private worktree HEAD
   if death preceded ref/DB acknowledgement. Never manufacture another commit
   before resolving that evidence.
4. Start `git update-ref --stdin`: `start`, conditional `update HEAD <new>
<old>` (or `create HEAD <new>` on unborn HEAD), then `prepare`. Git holds
   HEAD and referent locks. Re-read symbolic HEAD after prepare; abort unless it
   is exactly the reviewed main-branch ref. The redundant `symref-verify HEAD`
   transaction command is not used because Git rejects overlapping HEAD updates.
5. Under the prepared ref transaction, recheck the canonical index/worktree and
   project revision. Run Git's guarded `read-tree -m -u <old-tree> <new-commit>`;
   an unborn baseline uses the empty tree. Never rename over a user file or use
   reset/stash/discard. Commit the prepared ref transaction only after successful
   tree publication; read back actual ref/blob and record the committed receipt.
6. Git and Postgres are separate stores. If interruption leaves the old ref with
   the operation's new index/file, complete forward only after proving all
   relevant state is exactly the stored old/new state. Unknown bytes, locks,
   ownership or a read failure means recovery_required, never overwrite/rollback.
   Once the ref advanced, finalization repairs DB metadata without another commit.

Git 2.54.0 local mechanical checks prove prepared HEAD/referent locking,
concurrent symbolic-HEAD refusal and clean publication for born/unborn targets.
These are design evidence, not feature acceptance. Implementation tests own
all interruption/race windows. The unborn scaffold+amend avoids a dependency
on newer `git worktree add --orphan`; no deployment Git upgrade is required.

## Lock and recovery contract (Implemented)

Lock order is repository, project, operation. An exclusive ownership directory
under the canonical common Git directory fences all managed parent-repository
mutators without introducing database access into standalone Git helpers. A
short transaction locks the project row, rechecks the export revision and accepts
the durable active intent. Its trigger refuses concurrent export mutations until
completion or recovery. Git runs outside database transactions. The ownership
directory and active intent survive connection/process loss; neither expires.
Configuration recovery may adopt only its exact operation fence after proving
the recorded process dead. Ordinary pull/promotion/fast-forward actions use a
reserved repository-mutation identity: retry retires only a proven dead ordinary
owner, then rechecks the new action's normal preconditions. It never replays an
unknown prior callback or adopts a configuration intent.
Unknown ownership or a still-live process requires explicit recovery guidance.

Fence adoption uses a short kernel-backed SQLite transaction mutex in the common
Git directory. This permanent mutex file stores no configuration or operation
state; it is never unlinked, and process death releases its kernel exclusion.
The transaction covers retired-owner/group/index proof and owner replacement.
Concurrent recovery refuses immediately with `operation_busy`. Owner replacements
are staged outside the active fence directory and atomically renamed: death before
rename preserves the prior owner. Incomplete staging files remain inert evidence;
unknown contents inside the active directory still refuse adoption. Existing anonymous
legacy recovery directories remain unknown evidence and require operator
inspection; upgrades must drain old binaries. Normal Git execution remains outside
this short mutex, and durable owner/group evidence remains authoritative.

Each Git mutation starts behind an IPC gate. The host records its detached
process group in the fence before permitting Git to start. Owner death before
permission starts no Git command; owner death afterwards retains the group as
recovery evidence. Recovery refuses while any recorded group has a live member,
including orphaned hooks. Exited zombie members cannot issue effects. The
supported Linux/macOS process-table inspection uses `ps`; the container already
ships `procps`. Unreadable process evidence fails closed. Commands have bounded
execution and terminate their owned group on timeout.

GET status/receipt and new preview never advance earlier operations. Explicit
recover and a one-shot post-migration startup pass inspect accepted intents;
startup never commits an unused/expired preview or starts a push. Archive or
authority revocation blocks new Git effects; completed effects still reconcile.
Recovery uses keyset progress and isolates poison records without inventing a
terminal result from failed reads. No new watcher, polling loop or scheduler job.

## Wire and storage bounds (Implemented)

Manifest limit is 1 MiB valid UTF-8 (replacement decoding is refused as unsupported checkout); complete diff limit is 2 MiB; preview lifetime is
10 minutes. Never issue a confirmable truncated review. Revisions are decimal
strings on the wire. Git commands use a 30-second bounded execution window;
remote read-only inspection has at most three attempts with 250/1000 ms delays
and warnings. A potentially successful Git mutation is inspected before retry.

Commit states are previewed, preparing, prepared, publishing, committed, noop,
stale, failed, recovery_required. Active uniqueness covers preparing, prepared,
publishing and recovery_required. Terminal outcomes replay without effects.
Push intents have previewed, pending, succeeded, failed, unknown, stale states;
pending/unknown exclude another push intent for that parent/destination. Failed
push does not occupy the local commit slot. A fresh confirmed push review starts
a new attempt after known failure; unknown acknowledgement is reconciled first.

The exact DTO/schema tables live in OpenAPI and the project ERD/narrative.
The operation and push-intent snapshots are immutable and content-digest guarded.
FKs restrict destruction of retained evidence. Empty expired previews can be
pruned; nonterminal operations cannot. Committed receipts are retained with the
project; cleanup removes only proven operation-owned private material.

Scalar status may include the current actor's operation locator so an interrupted
save remains discoverable after reload. It never includes another actor's locator
or source content; the receipt route rechecks both stronger permissions. An active
own local intent takes precedence, then a pending/unknown own push on its committed parent, then the latest own terminal/no-op receipt. A later no-op must not hide an accepted push that still needs recovery.

A no-op review records a terminal no-op and may repair a null manifest locator to
the proven committed root manifest under a short revision-checked transaction.
It changes no exportable/runtime setting, file, index, ref or commit. This keeps
legacy null-path readers usable when an operator already committed matching YAML
outside MAIster; path repair never becomes persistence-status authority.

## Expectations

- **CPC-01:** (Implemented) Each successful package/runner change affects the intended runtime rows and advances export revision as specified; complete tracked/untracked manifest state, index and HEAD fingerprints are unchanged. DB-only edits neither write YAML nor falsely mark exported values different. Enforced by T2.1, T7.1 and IT-CPC-01 parameter table; see [traceability](project-config-persistence-traceability.md).
- **CPC-02:** (Implemented) First save, existing-manifest update and repeated save use the permanent action; a confirmed change yields exactly one reviewed manifest-only commit/receipt, and a semantic no-op yields zero commits/writes. Enforced by T4.1, T6.1, T9.1 and IT-CPC-02; E2E-CPC-02 for durable entry wiring; see [traceability](project-config-persistence-traceability.md).
- **CPC-03:** (Implemented) Fresh detail status compares normalized DB projection with target-branch committed content, independent of path presence; missing, pending, in-sync, blocked and cached/unverified remain distinguishable. Enforced by T3.1, T9.1 and IT-CPC-03; E2E-CPC-03 for last-observed presentation; see [traceability](project-config-persistence-traceability.md).
- **CPC-04:** (Implemented) Before any effect the full diff, target branch, exact message and author policy are displayed; actual committed parent/blob/mode/path-set/message equal the approved review. Cancel/no-op/oversize never issue a commit. Enforced by T3.1, T4.1, T6.1, T9.1 and IT-CPC-04; E2E-CPC-02 for review-before-submit; see [traceability](project-config-persistence-traceability.md).
- **CPC-05:** (Implemented) Save issues no remote request. Separate push confirmation binds destination, range and recorded SHA; rejection leaves the local commit and DB receipt intact and retry does not recommit or push later commits. Enforced by T2.1, T6.1, T9.1 and IT-CPC-05 with local bare remote; see [traceability](project-config-persistence-traceability.md).
- **CPC-06:** (Implemented) Attach, detach, upgrade, downgrade, initial creation, and SET/CLEAR/SET through both runner APIs all pass the same mutation/export contract; no package member becomes a duplicate standalone flow. Enforced by T3.1, T7.1, T8.1 and IT-CPC-01 and IT-CPC-02, shared rather than duplicated; see [traceability](project-config-persistence-traceability.md).
- **CPC-07:** (Implemented) Rich source fixture retains unrelated source bytes/comments, standalone flows/runner, every capability array, imports/trust, roles and promotion.remote; patch only owned leaves; malformed/unsupported structures refuse without effects. Enforced by T3.1 and IT-CPC-07 preservation/refusal table; see [traceability](project-config-persistence-traceability.md).
- **CPC-08:** (Implemented) Dirty/staged/untracked/ignored target collisions and unsupported layouts refuse; before/after bytes, refs and full index fingerprint are identical. A final-seam concurrent edit/stage cannot enter the commit or be overwritten. Enforced by T4.1, T14.1 and IT-CPC-08 guarded-seam table; see [traceability](project-config-persistence-traceability.md).
- **CPC-09:** (Implemented) Every bound DB/repository change, including exportable SET→CLEAR→SET, requires a fresh preview. Same accepted intent has one effect; changed payload/foreign identity is refused. A harmless Git index refresh with unchanged entries is not falsely treated as a user edit. Enforced by T2.1, T4.1, T6.1, T14.1 and IT-CPC-09 stale/idempotency/authorization table; see [traceability](project-config-persistence-traceability.md).
- **CPC-10:** (Implemented) Each enumerated DB/FS/Git/push interruption reaches a specified outcome, releases or conservatively retains its fence, and has a tested retry/recovery path. No duplicate commit, reset, unrelated cleanup, or rollback of successful local commit occurs. Enforced by T2.1, T4.1, T5.1, T6.1, T14.1 and IT-CPC-10 process/DB-loss table; IT-CPC-05 for push windows; see [traceability](project-config-persistence-traceability.md).
- **CPC-11:** (Implemented) Registration modes, source validation, owner/task-key defaults, package trust/pins and in-flight snapshots remain correct. Missing-manifest registration adds no file; existing-source bootstrap still materializes the same pins; actual launch observes the selected DB runner. Enforced by T7.1, T8.1 and IT-CPC-11 registration/execution table; retained owning pin/launch regressions; see [traceability](project-config-persistence-traceability.md).
- **CPC-12:** (Implemented) EN/RU wiring, methods/bodies/errors, applied migration/trigger behavior and analytics match the frozen contract; every acceptance/edge has one primary runnable test and all required suites pass without hidden omissions. Enforced by T1.1, T13.1, T10.1, T2.1–T9.1, T11.1, T12.1, T14.1 and CT-CPC-12 contract/schema gate plus the owning IT/E2E reports; see [traceability](project-config-persistence-traceability.md).

## Edge cases

- **EDGE-CPC-01:** Omitted defaults versus explicit defaults; null/default runner and promotion SET/CLEAR/SET; clear package path; reordered mapping and semantically equal package order; no normalization-only commit. Owner: IT-CPC-03/07; T3.1. Refusal uses CONFIG/PRECONDITION/CONFLICT or explicit EXECUTOR_UNAVAILABLE; exact wire outcomes are in [OpenAPI](../api/web.openapi.yaml).
- **EDGE-CPC-02:** All four package actions; both runner routes; DB-only mutation; missing install consistency refusal; no package-member duplication; failed runtime mutation does not advance committed config state. Owner: IT-CPC-01; T2.1/T7.1. Refusal uses CONFIG/PRECONDITION/CONFLICT or explicit EXECUTOR_UNAVAILABLE; exact wire outcomes are in [OpenAPI](../api/web.openapi.yaml).
- **EDGE-CPC-03:** Leading/inline/deleted-entry comments, standalone runner/flows, all eight capability arrays, import trust, roles, promotion.remote, unknown siblings, aliases/merge/duplicate keys; safe patch or explicit refusal. Owner: IT-CPC-07; T3.1. Refusal uses CONFIG/PRECONDITION/CONFLICT or explicit EXECUTOR_UNAVAILABLE; exact wire outcomes are in [OpenAPI](../api/web.openapi.yaml).
- **EDGE-CPC-04:** Dirty/staged manifest and unrelated paths; untracked/ignored manifest; staged deletion/rename; user edit/stage at final publication seam; byte/ref/index nonmutation on refusal. Owner: IT-CPC-08; T4.1/T14.1. Refusal uses CONFIG/PRECONDITION/CONFLICT or explicit EXECUTOR_UNAVAILABLE; exact wire outcomes are in [OpenAPI](../api/web.openapi.yaml).
- **EDGE-CPC-05:** Wrong/detached/unborn branch; moved target ref; changed source blob/mode; active merge/rebase/cherry-pick/revert/bisect; symlink/nonregular target; sparse/skip-worktree/unsupported Git format/layout; non-ENOENT read errors. Owner: IT-CPC-08/09; T3.1/T4.1. Refusal uses CONFIG/PRECONDITION/CONFLICT or explicit EXECUTOR_UNAVAILABLE; exact wire outcomes are in [OpenAPI](../api/web.openapi.yaml).
- **EDGE-CPC-06:** Stale DB revision including change-and-reversal; stale index entries/flags, not stat-only refresh; changed author/message policy; expired review; external committed change/pull versus local dirty file; cached last-observed display. Owner: IT-CPC-09/03; T2.1/T3.1/T9.1. Refusal uses CONFIG/PRECONDITION/CONFLICT or explicit EXECUTOR_UNAVAILABLE; exact wire outcomes are in [OpenAPI](../api/web.openapi.yaml).
- **EDGE-CPC-07:** Same accepted ID/same content, same ID/different content, two confirmations and two different reviews; later HEAD advancement; no-op receipt replay; terminal failure replay requires new review for a new attempt. Owner: IT-CPC-09/02; T2.1/T4.1/T6.1. Refusal uses CONFIG/PRECONDITION/CONFLICT or explicit EXECUTOR_UNAVAILABLE; exact wire outcomes are in [OpenAPI](../api/web.openapi.yaml).
- **EDGE-CPC-08:** Unauthenticated/inactive/unauthorized actor; positive owner/admin; foreign project/principal IDs; malformed/unknown fields; archive/revocation between preview, confirm and recovery; no content disclosure through scalar status/logs. Owner: IT-CPC-09 and actual-response schema samples; T6.1. Refusal uses CONFIG/PRECONDITION/CONFLICT or explicit EXECUTOR_UNAVAILABLE; exact wire outcomes are in [OpenAPI](../api/web.openapi.yaml).
- **EDGE-CPC-09:** Upgrade and clean install; preserved legacy null/non-null paths and project/attachment data; semantic trigger bump/no-op/rollback; illegal state/receipt mutation; active uniqueness; pending-evidence deletion refusal. Owner: CT-CPC-12 migration portion; T2.1. Refusal uses CONFIG/PRECONDITION/CONFLICT or explicit EXECUTOR_UNAVAILABLE; exact wire outcomes are in [OpenAPI](../api/web.openapi.yaml).
- **EDGE-CPC-10:** Confirm versus package/runner transaction, pull/promotion/FF, unrelated repo progress; canonical-path aliases; DB lock-connection death while Git child is live; duplicate startup/explicit recovery owners. Owner: IT-CPC-10 concurrency portion; T14.1/T4.1. Refusal uses CONFIG/PRECONDITION/CONFLICT or explicit EXECUTOR_UNAVAILABLE; exact wire outcomes are in [OpenAPI](../api/web.openapi.yaml).
- **EDGE-CPC-11:** Death after accepted intent, private write, commit before private-ref/DB acknowledgement, prepared receipt; failed hook/signing/default author; no duplicate SHA or user-index contamination. Owner: IT-CPC-10 preparation portion; T4.1. Refusal uses CONFIG/PRECONDITION/CONFLICT or explicit EXECUTOR_UNAVAILABLE; exact wire outcomes are in [OpenAPI](../api/web.openapi.yaml).
- **EDGE-CPC-12:** Every specified target ref/index/worktree update window; post-publication DB failure; user edits before recovery; target advanced/reset; ambiguous effect, stale owner and unknown lock; cleanup failure after success. Owner: IT-CPC-10 publication portion; T4.1. Refusal uses CONFIG/PRECONDITION/CONFLICT or explicit EXECUTOR_UNAVAILABLE; exact wire outcomes are in [OpenAPI](../api/web.openapi.yaml).
- **EDGE-CPC-13:** Push off/success/auth/network/non-FF failure; changed origin/destination/remote base/range; later local commit excluded; known-failed retry via fresh push review; lost ACK/DB receipt; next local save despite failed/unknown push. Owner: IT-CPC-05; T6.1. Refusal uses CONFIG/PRECONDITION/CONFLICT or explicit EXECUTOR_UNAVAILABLE; exact wire outcomes are in [OpenAPI](../api/web.openapi.yaml).
- **EDGE-CPC-14:** GET status/receipt and new preview cause no Git/FS/recovery writes; recover cannot accept unused preview or authorize push; startup skips unconfirmed reviews, handles accepted intent only and issues no push. Owner: IT-CPC-10/09; T4.1/T6.1. Refusal uses CONFIG/PRECONDITION/CONFLICT or explicit EXECUTOR_UNAVAILABLE; exact wire outcomes are in [OpenAPI](../api/web.openapi.yaml).
- **EDGE-CPC-15:** Expired unused preview versus accepted/prepared/published operation; explicit stale prepared-operation replacement versus unresolved publication fence; retention/prune only owned terminal artifacts; poison recovery row cannot starve next row. Owner: IT-CPC-10; T2.1/T4.1/T5.1. Refusal uses CONFIG/PRECONDITION/CONFLICT or explicit EXECUTOR_UNAVAILABLE; exact wire outcomes are in [OpenAPI](../api/web.openapi.yaml).
- **EDGE-CPC-16:** Clone/local/new-empty with absent manifest; present-invalid refusal; naming/task-key/default-branch precedence; deferred git-init/compensation; existing package bootstrap and null-path CLI read handling. Owner: IT-CPC-11; T8.1. Refusal uses CONFIG/PRECONDITION/CONFLICT or explicit EXECUTOR_UNAVAILABLE; exact wire outcomes are in [OpenAPI](../api/web.openapi.yaml).
- **EDGE-CPC-17:** Launch with runtime settings before first save and after each version/runner change; actual resolved runner/pin provenance; existing in-flight snapshot unchanged; persistence performs no install/trust/setup/import. Owner: IT-CPC-11 plus existing launch/pin owners; T7.1/T8.1. Refusal uses CONFIG/PRECONDITION/CONFLICT or explicit EXECUTOR_UNAVAILABLE; exact wire outcomes are in [OpenAPI](../api/web.openapi.yaml).
- **EDGE-CPC-18:** Real Studio cut's deleted temporary source, mutable local directory changed since attachment, unsupported coordinate, supported source's attached revision match; no guessed/omitted source. Owner: IT-CPC-07 local-coordinate portion; T3.1. Refusal uses CONFIG/PRECONDITION/CONFLICT or explicit EXECUTOR_UNAVAILABLE; exact wire outcomes are in [OpenAPI](../api/web.openapi.yaml).
- **EDGE-CPC-19:** Exact full-diff byte/size boundaries; UTF-8/newline/mode preservation; empty or malformed bodies; broken filesystem/Git/DB/remote reads produce explicit unavailable/refusal rather than absence/no-op. Owner: IT-CPC-04/07 plus actual-response schema samples; T3.1/T6.1. Refusal uses CONFIG/PRECONDITION/CONFLICT or explicit EXECUTOR_UNAVAILABLE; exact wire outcomes are in [OpenAPI](../api/web.openapi.yaml).
- **EDGE-CPC-20:** EN/RU parity; cancel before confirm; busy double-submit/Escape/backdrop; focus/status failure while the banner dialog is open; timeout then reopen same receipt; focus restore; no-op; banner dismissal; repeated durable action; separate push review and local-success/push-failure feedback. Owner: E2E-CPC-02; E2E-CPC-03; E2E-CPC-04; T9.1. Refusal uses CONFIG/PRECONDITION/CONFLICT or explicit EXECUTOR_UNAVAILABLE; exact wire outcomes are in [OpenAPI](../api/web.openapi.yaml).

## Private publication cleanup and independent push ownership

The publication and push rows each add `cleanup_state` (`pending | complete | retained`, default `pending`), nullable `cleanup_checked_at`, and nullable bounded `cleanup_reason`. A completed or retained cleanup requires a check timestamp; retained requires an actionable reason. These fields describe private host output only and never alter the committed/push outcome. Failure to remove staging cannot undo a successful local commit. A retry may move retained cleanup back to pending and then complete after verifying the same ownership markers. No cleanup deletes unknown files, changes a caller index, removes unknown Git locks or drops an unresolved operation row.

Push rows additionally add nullable `owner_token`, `owner_process_id`, and `process_group`. Pending/unknown rows require a non-null token and positive owner PID; a present group must be positive. Cleanup reasons are exactly `unexpected_private_content`, `cleanup_failed`, `operation_busy`, `recovery_required`, or `authority_changed`. A short compare-and-set transaction claims a reviewed push, then the detached Git gate records its process group durably before permitting network effects. Pending/unknown recovery cannot adopt while the original web owner or any non-zombie group member remains live. Same-process ownership also uses a live invocation registry. Push issuance does not hold the repository mutation fence: a failed or uncertain push leaves the local commit and later independent local saves available. The existing active-destination constraint still prevents a duplicate attempt for the same operation and destination until the earlier outcome is settled.

The push snapshot adds the captured effective remote URL, effective resolved pre-push hook path/digest, and a server-owned private content directory. Credential-bearing HTTP URLs and ambiguous chained URL rewrites are refused before storing a review. The displayed URL is redacted; no response contains the host-private locator. Preview performs only bounded read-only remote discovery; it never fetches objects, pushes or creates a commit. Missing local ancestry proof requires explicit operator fetch before a fresh preview.

At issuance, use the immutable commit SHA and captured effective URL plus destination ref. A private pre-push wrapper accepts exactly one update and checks Git's observed remote old OID against the reviewed baseline. It delegates the original configured hook with Git's actual original argv and stdin unchanged. Baseline disagreement refuses the update; normal server fast-forward/CAS rules remain enabled. No force flag, force-with-lease, policy bypass or moving branch source is used. When acknowledgement is lost, settle by read-only remote observation after the recorded group retires; never reissue an unknown push. Startup can inspect accepted outcomes but never initiate a push.

API receipts expose `cleanupState` and optional `cleanupReason` (stable allow-listed reason keys); push results expose the equivalent push cleanup status. These are required fields in the deployed new API family. Current runtime settings and the manifest schema do not gain any of these operational fields.

Package installation retry is an additional export writer: `installPackageRevision`
can update an existing install's status and manifest metadata, including
`sourceSubpath`. The install-update trigger advances attached projects in
sorted ID order for exported coordinates/status; the accepted-publication guard
refuses changes while an intent is active. Trust/timestamp-only updates stay
DB-only. Migration 0198 closes concurrent binding changes: before attachment
insert/delete or semantic binding update, lock the referenced old/new install
rows in sorted order with `FOR SHARE NOWAIT`. These locks conflict with metadata
updates, unlike the foreign key's key-share lock. Contention returns
`CONFLICT/operation_busy` without partial writes; retry after the other operation
finishes. An update already waiting on a binding transaction observes the newly
committed attachment before advancing revisions (READ COMMITTED trigger queries).
No dependency on a pre-existing attachment or application-only locking remains.
Real two/three-connection tests own both orders, pin switches, retry and accepted
publication while the installation writer waits.

The immutable repository snapshot encodes canonical Git-quoted ASCII index entries as base64. `core.quotePath=true` keeps arbitrary path bytes, control characters and non-ASCII names lossless across the text/JSON boundary. Expected published index entries are derived from the immutable prepared commit tree, never a mutable private index. PostgreSQL JSONB cannot represent U+0000; the lossless encoded value remains part of the reviewed-state digest. Do not strip delimiters or normalize path text. Repeated persistence against a non-empty index is a real-Git/real-Postgres acceptance case.

A review binds both the project row's exact registered repository path and the resolved canonical checkout. Recheck the row value in the short acceptance transaction, and recheck canonical path resolution outside that transaction immediately before privileged effects. A relocated path or retargeted symlink requires a fresh preview. Full proposed manifest validation reuses the registration loader's structural/reference parser (including duplicate flow IDs and role/capability identifiers) without running installers.

The live ownership registry survives Next.js module reloads; a reload cannot
adopt a still-running same-process intent between Git subprocesses. Each managed
Git group has parent and independent child deadlines. A one-shot group check on
Git exit refuses unnoticed surviving hook children; a signalled Git exit remains
uncertain even if a commit object already exists. Recovery inspects that object
and the published branch before deciding an outcome. No process watcher or
polling loop is added, and arbitrary detached hook daemons are not a containment
boundary of this workflow.

## Linked artifacts

- [ADR-194](../decisions/adr-194.md)
- [Feature SDD](../../.ai-factory/specs/project-config-git-workflow.md)
- [Traceability](project-config-persistence-traceability.md)
- [Configuration](../configuration.md), [projects](projects.md), [Git](git-integration.md)
- Implemented services: `web/lib/project-config-persistence/`; the compatibility
  endpoint family delegates to these reviewed-operation services.

## Final caller-index reservation

The final Git `read-tree` transition may preserve a concurrently staged unrelated
path. Therefore the HEAD ref transaction alone is insufficient confirmation
binding. After `read-tree` (or recognition of its exact partial result), reserve
the caller's standard `index.lock` with an atomic no-clobber hard link from a
fsynced operation marker in the common repository fence. The fence owner record
first durably binds the marker digest, canonical index-lock path and owner nonce.
While the reservation is held, normal Git staging cannot change the caller index.
Recheck the entire index against the immutable prepared commit, the exact proposed
manifest bytes/mode, original HEAD/branch/policy, DB revision and authority, and
all other checkout/operation evidence. Only then commit the already prepared ref
transaction. A preserved concurrent stage refuses publication and leaves every
user byte and index entry available for explicit recovery and a fresh review.

Hold the reservation until the owned Git conversation and hook process groups
retire. A restart may remove a reservation only for the same accepted operation,
after proving the old owner and groups retired, and matching the target and
private marker device/inode, exact digest, mode, UID and nonce. An absent target
permits removal of the verified private marker only. An existing different lock,
changed/missing marker, unsupported filesystem hard links, or unknown metadata
refuses adoption with guidance; no unknown Git lock is removed. A collision
before successful linking leaves the existing lock untouched. A crash after
linking, after ref commit or during reservation cleanup is resumed by that same
proof before any repository mutation or receipt repair.
