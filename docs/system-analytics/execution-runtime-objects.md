# Execution runtime objects

**Status:** Implemented host registry, reserve/upload/delete routes, manager catalog and **safe content delivery (AB-12, S3.4)**; **Implemented native intent/seal reconciliation (AB-09, S3.1)**; **Implemented host seal/read verification (AB-13)**; **Implemented manager message-integrity (AB-15, S3.3)**; **Designed** crash-gap recovery and fair retention corrections (AB-14). Bytes remain host-owned and manager locators remain opaque.


## Purpose

Define opaque, fenced access to ACP runtime files without exposing a host path
to the web tier, browser, or manager database. The host owns private bytes and
object registry paths; the manager owns catalog metadata, authorization, and
artifact association.

## Domain entities

- `execution_runtime_objects` is the manager catalog of object ID, association,
  kind, metadata, retention, state, and tombstone without a path.
- Host-private object registry records canonical private path, upload intent,
  generation, sealing, and deletion state.
- `ArtifactLocator {kind:"execution-object",objectId}` associates a cataloged
  host object with an existing artifact without host/run/path data.
- `runtime_object.available` and `runtime_object.state` are canonical catalog
  events.
- Stage A `execution_commands`, receipts, assignment ID, and epoch fence own
  reserve, upload, and delete side-effect identity.
- Capability profile JSON and instruction Markdown are distinct typed runtime
  objects; `session.create` accepts only their opaque IDs and validates each
  expected kind before deriving child environment paths.

## State machine

```mermaid
stateDiagram-v2
  [*] --> pending: reserve command
  pending --> available: matching canonical availability
  available --> deleting: fenced delete command
  deleting --> deleted: durable host tombstone then unlink
  available --> missing: verified absent
  available --> corrupt: checksum failure
  deleted --> [*]
```

`expires_at` is deletion eligibility, not a persisted terminal state. The
manager's 60-second sweep leaves a referenced object or an object owned by a
live/checkpointed session `available`; otherwise it commits `deleting` with the
fenced delete command. The matching ACK or canonical state event establishes
`deleted`. A terminal delete refusal retains the unavailable intent and error;
it does not restore availability.

## Process flows

```mermaid
sequenceDiagram
  participant M as Manager catalog
  participant H as Host registry
  participant A as ACP process
  M->>H: reserve opaque object ID and metadata
  M->>H: fenced streaming upload with same command ledger
  H->>H: temp write, verify digest/size, atomic rename
  H->>M: durable available event and receipt
  M->>M: project canonical available metadata into catalogue
  Note over A,H: Host-owned producer registration is B3.5
```

## Native intent and seal reconciliation (Implemented — S3.1)

`runtime-object-evidence.ts` applies upload/reserve ACKs, prompt-output receipts,
recovered object receipts, canonical availability and deletion evidence under
the same catalog object lock.
An ACK establishes matching size, SHA-256 and seal time while keeping `pending`;
only accepted canonical availability makes that object available. Commit wakes
projection, and a lost wake is covered by durable replay. Later evidence must
match both immutable identity and the established seal, even after deletion;
it cannot restore deleting, deleted, missing or corrupt bytes to availability.

Migration `0160_runtime_object_declarations` adds paired nullable
`declared_size_bytes` / `declared_sha256`. Reserve records them with the original
intent before host dispatch; a changed retry fails in the manager before another
command is issued. Backfill uses only the first exact recorded reserve request,
including its expiry. Tied earliest timestamps do not prove the original request.
A compacted/missing or ambiguous original request, or a producer allocation, leaves declarations
unknown; neither a later request nor sealed metadata invents an original promise.
The host's reserve/upload checks independently enforce the expected bytes.

Released and superseded assignments retain only their exact catalog object's
historical evidence. Session content references and overflow segments additionally
prove the original committed command and session. This exception never changes a
successor assignment or creates an object from an unsolicited event: missing or
conflicting intent produces a permanent projection failure for operator repair.
The historical-import origin and crash-gap repair remain the S4/S3.5 contracts below.

The real Postgres/supervisor suite `runtime-object-lifecycle.integration.test.ts`
executes both ACK/event orders, lost ACK with the same command, receipt recovery,
invalid/changed declarations, foreign ID refusal, released/superseded ownership,
seal conflicts, unsolicited objects and delete/availability replay.
`runtime-object-retention.integration.test.ts` also checks that a terminal delete
refusal preserves `deleting`. `runtime-object-declarations-migration.integration.test.ts`
executes the 0159→0160 backfill without changing established seals.

## Runtime-object lifecycle, security and integrity (Designed)

Use one reducer over immutable object identity `{objectId,generation,hostId,runId,kind,MIME,origin}` and separately sealed metadata `{sizeBytes,sha256}`. Origin is an explicit union: native command/output allocation with required assignment/epoch/session/command provenance, or authorized historical import `{importId,manifestHash,itemId}` without a fabricated active assignment. Any uniquely proven historical assignment is optional provenance. Import availability uses verified host import receipt plus deterministic `legacy_import` canonical evidence; it is not a fake native host event. The import adapter stores this proof using the existing 0131/0133 fields and import lanes/host manifest, so it works before forward schema additions. Pending rows may have null sealed fields; declared expected size/hash, when present, are immutable independent fields. Compare intent identity first, then establish sealed metadata once. Same metadata replay is idempotent; different metadata/generation conflicts without overwrite.

| State / evidence | Legal action | Refusal / recovery |
| --- | --- | --- |
| No intent | Reserve with durable command/owner intent | Unsolicited foreign object event is quarantined; never infer run/project from body. |
| Pending, upload not complete | Write exclusive private temp/chunks; persist upload progress | ACK loss queries exact object/command; retry same bytes/key. Changed declared bytes conflict. |
| Bytes sealed, event/receipt pending | Reconcile durable host seal to missing receipt/event | No duplicate file generation; manager catalog remains pending until matching canonical availability. |
| Available event before ACK | Fill sealed fields via object reducer | Valid pending identity succeeds; no impossible null-and-equal conjunction. |
| Available ACK before event | Persist matching evidence and wake reconciliation | ACK does not forge a canonical event; retry replay until event arrives. |
| Released/superseded assignment | Retain exact old intent's bytes/metadata as historical evidence | Never attach to current successor. Historical object evidence exception requires exact committed intent, not a general stale-event bypass. |
| Available, verified missing/corrupt | Host persists typed state and outbox evidence; manager projects state | No success response with stale digest. Read failure does not delete metadata or silently retry a different object. |
| Deleting | Durable delete intent/tombstone precedes unlink | New references denied under same object/generation lock; unlink/recovery retries same operation. |
| Deleted | Keep catalog and idempotency tombstone | Replayed available cannot resurrect; identical delete succeeds; read reports typed gone. |

**Seal and read:** flush/close producer writable handles; seal to a distinct private immutable inode by tmp+rename and record identity. Never label the actively appended log inode immutable; seal segments and a manifest with ordering/total length for continued logs and full prompt output. Preserve structured result transport (`MAISTER_OUTPUT_FILE`/sentinel and `node_attempts.vars`) separately from required verifier evidence (`MAISTER_ARTIFACT_DIR` and typed evidence associations).

For each read, open with no-follow semantics, validate regular-file/device/inode/size and initial stat, stream the entire representation through SHA-256 while copying only the selected ≤8 MiB response bytes to an exclusive 0600 private spool. Compare total size/hash and final stat before sending success headers. Serve the exact spool descriptor, unlinking its path while open where supported; do not verify then reopen the original path. This adds bounded disk I/O to catch same-size tampering and avoids a hash-then-mutate race on returned bytes. Cap scans/spools; use typed busy/retry responses. Large multipart historical representations hash ordered sealed chunks; no whole-file RAM buffer.

A segmented log/history is exposed as **one ordinary catalog object and existing execution-object locator**, with the full logical size and SHA-256 of concatenated original bytes. Segment order/offset/length/hash descriptors are host-private. Range reads cross segments transparently; Repr-Digest hashes original file bytes, never the descriptor or concatenated segment hashes. No new unresolved manifest locator leaks to artifact/attachment consumers.

On ENOENT return a typed missing outcome; on nonregular/symlink/identity/digest mismatch return corrupt. Persist host state/outbox evidence before claiming that transition; if host persistence fails, return storage-unavailable and record service degradation, not a falsely durable missing/corrupt state. DB application follows canonical evidence without blocking the HTTP error response on projection. Manager validates representation identity and hashes actual response bytes in its bounded spool before forwarding success; a corrupt peer stream is never labeled verified solely because its headers agree.

**Download policy (Implemented — AB-12, S3.4):** untrusted arbitrary object content is `application/octet-stream`, `Content-Disposition: attachment` with sanitized ASCII filename and RFC 8187 encoded filename, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: private, no-store`. One shared policy module (`runtime/safe-download.ts`) is applied to 200/206 on the host content route (`GET /runtime-objects/{id}/content`), the manager proxy (`GET /api/runs/{runId}/runtime-objects/{objectId}/content`) and the artifact payload route for `execution-object` locators; server-derived text/JSON artifact payloads keep their passive type but travel under the same disposition, nosniff, CSP and cache headers. The catalogued MIME (caller-supplied at upload) is metadata only and is never reflected into a response type; the attachment filename is the manager's `logicalName`, sanitized. Both routes that expose an execution object's bytes require the same `readRepoFiles` grant (the payload route previously served them under `readBoard`); diff/log/git/inline artifact payloads stay board evidence at `readBoard`. Never inline HTML, SVG, XML, script, PDF or supplied MIME. The evidence-graph payload preview fetches and renders escaped text, so it is unaffected. Proven by AT-12: `web/e2e/execution-ab-content.spec.ts` (real Chromium against a real supervisor — an uploaded HTML/SVG document with an authenticated side effect is downloaded, never executed; anonymous/non-member/foreign access refused) plus the route unit tests and the host integration case. Fixing this exposed a seam defect: the host's prompt path resolved uploaded attachments without `expectedKind`, so every prompt carrying an upload had been refused since the Stage B lifecycle commit; `resolvePromptRuntimeObjects` now names the prompt-reference kind (`attachment`) explicitly.

**Digest contract (Implemented — AB-15, S3.3):** for 200 the body digest and representation digest agree when bytes are identical; for 206 Content-Digest covers the transferred slice, Repr-Digest the full verified object; a strong ETag binds generation/hash. No compression/transcoding on this route. Invalid/multiple/out-of-range requests return 416 with typed range error, without full-body fallback. See [RFC 9530 §2–3 and Appendix B.3](https://www.rfc-editor.org/rfc/rfc9530.html#appendix-B.3). Tests hash returned bytes independently; header equality is only a metadata check.

**Retention:** expired is eligibility, not deletion authority. Preserve live/checkpointed session input/output, unresolved command requests/results, unapplied owners, pending import proofs, required verifier evidence, artifact/result references, and delivery holds. Use the existing confirmed local-delivery or PR-merge policy and persisted delivery snapshot/confirmation; `Done` or an open/closed-unmerged PR alone is insufficient. Result-only delivery requires its actual acknowledgment policy, not a fabricated merge. When no authoritative delivery confirmation exists, retain with an actionable protected reason. Optional operational diagnostics can follow their explicitly weaker policy; do not reuse it for required evidence.

GC advances a keyset/last-examined marker even for protected rows. New reference creation and delete eligibility use the same object/generation lock so a reference cannot appear after destructive claim. Recheck eligibility/fence before remote effect; store deleting command identity and retry state before dispatch. Fairness applies to deleting/missing/corrupt cleanup queues too. Catalog/tombstones outlive missing/deleted payloads.

## Host descriptor verification (Implemented)

The host stores `sealed_device` and `sealed_inode` as private decimal strings in
SQLite schema 13, alongside the optional private `producer_path`. Uploads flush and close their exclusive temporary file before
rename and directory fsync. Producer output is copied to a distinct inode before
its seal is published; a retained producer descriptor cannot change the sealed
copy. Its producer path is separate from the sealed path, so reopening the
producer filename cannot mutate the sealed representation either. Both retained
files remain charged until object deletion. Captured ACP segments also record
the identity of their distinct inode.
A version-12 object acquires identity only after a bounded copy verifies its
existing sealed size and SHA-256; the temporary copy has its own file reservation.
Object ID, generation and catalog metadata remain unchanged.

The content route permits two active reads through verification and response
completion, each retaining at most 8 MiB, for at most 16 MiB of response spools. Each scan uses a
64 KiB buffer and checks the entire source even for a short range. It opens with
`O_NOFOLLOW | O_NONBLOCK`, validates a regular file and the stored device/inode,
and checks size, SHA-256, mtime and ctime before sending success headers. The
response streams its already-open, unlinked 0600 spool; cancellation and stream
close release the descriptor and temporary accounting row. A saturated reader
returns typed `command_in_progress`; malformed or oversized ranges return 416.

Missing/corrupt state and its canonical outbox event commit together before the
HTTP 409. A failed persistence transaction leaves the prior object state intact
and latches storage degradation with HTTP 503 `runtime_storage_unavailable`.
No manager projector is needed for this refusal. Restart preserves the failure
and its event. Inventory measures a known corrupt symlink itself without following
it, retains and charges the entry, and still refuses a total-capacity overrun.
Unknown nonregular files remain an explicit storage failure.

`runtime-objects.integration.test.ts` executes 18 real HTTP/SQLite/file cases,
including post-seal mutations, producer descriptor and filename reuse, interrupted
seal, a mutation during scanning, an eight-MiB range with corruption outside the
slice, response-slot/cancellation cleanup, outbox rollback and a version-12 upgrade.

## Manager response verification

**Status: Implemented (S3.3, AB-15).** Qualified on the complete package lanes: real host object cases, Postgres/real-supervisor catalogue cases, real binary HTTP transport cases and the Chromium content lane hash returned bytes independently.

`runtime/object-integrity.ts` defines the shared strict SHA-256 digest, strong
`"<generation>-<lowercase SHA-256>"` ETag and single-range grammar. The binary
transport requests identity encoding and refuses compression, unexpected 200/206
status, duplicate or malformed digest fields, weak/invalid ETags and inconsistent
length/range metadata. Chunked bodies remain bounded by their actual byte count.

The manager compares Repr-Digest, ETag, total size and the exact requested range
with its Postgres catalogue. `runtime-object-response.ts` hashes received bytes
into a private 0600 temporary descriptor before exposing success. Its pathname
is unlinked before the scan; the returned stream reads that same descriptor in
64 KiB blocks. Two active responses cap retained spool bytes at 16 MiB. EOF,
cancellation, request abort and failure close the descriptor and release the
slot. A busy manager returns typed `command_in_progress`; local storage failure
returns `runtime_storage_unavailable`. A peer integrity failure refuses the read
without inventing a durable host corruption event or changing the catalogue.

The filesystem inventory classifies these specific operations as
`manager-response-spool`: they copy received HTTP bytes into manager-owned temp
storage and accept no host path or caller-selected filesystem location. Both
content proxy routes retain the shared attachment policy and forward the verified
Content-Digest, Repr-Digest and ETag. Postgres/real-supervisor lifecycle cases,
real-HTTP binary transport cases and the Chromium content lane independently
hash full and nonzero-range bytes; they also check refusal and resource cleanup.

## Expectations

- **OBJ-01:** Manager contracts/catalogs expose opaque object IDs and typed metadata, never a host filesystem path.
- **OBJ-02:** The web authorizes URL-selected resources then derives host/run/assignment/epoch/object association from Postgres.
- **OBJ-03:** Reserve, upload, and delete reuse Stage A commands, receipts, retry state, and fences without a second ledger.
- **OBJ-04:** A sealed object has immutable binding, generation, MIME, size, and SHA-256, and differing retries conflict.
- **OBJ-05:** Upload bytes use private temporary files, verify declared integrity, and atomically rename before available evidence.
- **OBJ-06:** Reads return a manager-authorized stream only after catalogue identity and actual response-byte verification. Content-Digest hashes the selected bytes; Repr-Digest and the generation/hash ETag identify the complete object. Invalid ranges return typed errors without a full-body substitute.
- **OBJ-07 (Designed correction):** Unknown/cross-boundary, tombstoned, corrupt, and oversized objects have distinct typed outcomes; expiry is an internal deletion eligibility check.
- **OBJ-08:** Object content, host paths, prompts, and secrets are prohibited from logs and event payloads.
- **OBJ-09:** Events/messages/cost/catalog metadata remain manager-owned while raw diagnostics and large host content remain host-owned.
- **OBJ-10:** Structured result transport remains separate from verifier evidence payload storage and required evidence fails explicitly.
- **OBJ-11 (Designed correction):** Delete commits a durable host tombstone before unlink and repeated delete is idempotent.
- **OBJ-12 (Designed correction):** Manager metadata outlives missing/deleted bytes and deletion follows existing run/artifact delivery retention.

## Edge cases

- **EDGE-OBJ-01:** A client-selected foreign binding is not found before project authorization, while host-private path traversal is impossible because no path is accepted (`IT-OBJ-02-PATH`).
- **EDGE-OBJ-02:** Multi-range, malformed, or out-of-content range returns `PRECONDITION {reason: runtime_object_range_invalid}` with no full-body fallback (`IT-OBJ-06`).
- **EDGE-OBJ-03:** A retry with different size, hash, MIME, or generation preserves the original and returns manager `CONFLICT {reason: command_invariant_conflict}` or host `PRECONDITION {reason: command_invariant_conflict}` (`IT-OBJ-04-CONFLICT`).
- An interrupted upload discards private temporary bytes and retries from zero with its original command ID; a sealed registry row can synthesize the missing receipt/event after restart.

## Linked artifacts

- [ADR-167](../decisions/adr-167.md) records object ownership and retained Stage C repository boundary.
- [Artifacts](artifacts.md) owns artifact validity and manager-owned locator metadata.
- [Supervisor OpenAPI](../api/supervisor.openapi.yaml) defines reserve/upload/metadata/range/delete operations.
- [Host event AsyncAPI](../api/async/execution-host-events.asyncapi.yaml) defines catalog events, and [database schema](../database-schema.md) defines retention records.
- `IT-*` and `CT-*` labels are specification scenario IDs, not collected-test evidence. AB-09/12–15 require the [stabilization acceptance matrix](../../.ai-factory/plans/stage-ab-stabilization.md#final-acceptance-matrix).
