# Bound operational integrity and preservation buffer allocation

**Date:** 2026-11-02
**Files:** operational-integrity.ts, operational-evidence.ts and existing integrity integration coverage.
**Severity:** high

## Problem and evidence boundary

The authorized Firefox recovery imported GitHub issues #2/#4/#5/#6 into
MAI-21/22/23/24. Run `2b451722-4894-456a-86f0-8f56f1bafafc` returned a valid
success result (scanned 18, attempted/completed/created 4, failed 0, skipped 14)
and confirmed GitHub receipts, but its independent final integrity check refused
completion with `operational_integrity_limit`. Evidence preservation remains
requested; terminal status is Failed. Empty changedPaths under indeterminate
integrity does not establish a clean tree.

The old diagnostic combines elapsed time, bytes, entry count and Git worktree
configuration size. The precise production limit axis cannot be reconstructed
from that receipt. A subsequent MAI-24 qualifier also failed before model output
with `operational_baseline_missing`; this alone does not establish its cause.

## Root cause and fix

The source scanner allocated a zeroed 1 MiB buffer for every regular file and
copied each read before hashing. A real filesystem regression reproduced 384 MiB
of allocation for 128 tiny files across three scans. Reuse one lazily allocated
buffer per capture invocation, and hash its slice synchronously. Concurrent
invocations retain independent buffers. Apply the same correction to diagnostic
archiving, which had the identical allocation/copy pattern.

Keep full source/ignored/untracked/materialization coverage, 100k-entry/256-MiB/
30-second caps, symlink/race/ref checks and fail-closed completion. No integrity
bypass, outcome reclassification, public contract or database migration. Add
numeric limit-axis/counter details and structured capture/verify warnings;
workspace paths, contents and raw provider errors are excluded from these logs.

## Validation

- Existing real-filesystem regression extended to four concurrent independent
  probes: distinct multiblock/tail, empty, short and 128 tiny files; exact hashes,
  clean generation/final verification and 12 MiB aggregate buffer budget across
  twelve probes. Original allocation regression was RED, fixed version GREEN.
- Integrity suite: 16/16. Existing disposition suite: 26/26, including actual
  evidence archives, cleanup and retention. Full web typecheck and focused ESLint
  passed. Adversarial review found no weakened integrity invariant.
- MCP stdio suite: 7/7. One complete qualification wire scenario checks advertised
  fields and exact nested HTTP forwarding, including the nullable expected
  qualification revision. Its fixture response proves transport, not admission.
  A separate freshly built bundle tools/list probe confirms the four fields;
  neither local check proves the deployed facade revision.

## Executed sibling sweep

`rg -n 'Buffer.alloc|new Uint8Array\(buffer.subarray|captureOperationalBaseline|verifyOperationalIntegrity'`
over integrity, operational-context, launch and operational-evidence returned:

```text
operational-context.ts:168,268: verifyOperationalIntegrity
operational-context.ts:198: captureOperationalBaseline
launch.ts:3855: captureOperationalBaseline
operational-evidence.ts:37: captureOperationalBaseline
operational-evidence.ts:112: Buffer.alloc(CHUNK_BYTES)
operational-evidence.ts:118: hash.update(new Uint8Array(buffer.subarray(...)))
operational-integrity.ts:193,289: Buffer.alloc(1024 * 1024)
```

Classification: scanner allocations now share one invocation-local buffer;
evidence allocation/copy fixed at the sibling archive boundary. Context mounts,
launch and preservation all reuse the corrected scanner. Git config shares the
same serial scanner buffer; existing independent config-size cap remains.

## Live recovery disposition

GitHub pending-marker edits retain their original comment IDs and edit history.
Fresh imported receipts confirm all four tasks; no uncertain effect was silently
deleted or replayed. Triager's temporary `auto_enqueue=off` was restored to its
original `when_confident` and verified by reopening settings. Intake keeps its
original `*/30 * * * *` UTC expression with the cron binding paused until the
platform repair is deployed and a fresh run passes final integrity. Agent
attachment, runner and permission settings remain unchanged. Local source/test
success is not hosted qualification; historical Failed receipts remain immutable.

## Related triager investigation

Run `0c903a4b-35d0-43d6-bd8e-40e8fb9212c7` assessed MAI-22 but failed to submit
qualification. Firefox showed its first call contained 95,862 bytes of malformed
JSON with repeated `baseBranch`; a later exact payload carried only legacy
routing fields and the server refused it with `qualification_required`. The
agent's claim that its exposed schema was stale is not proven by those payloads.
The local source advertises all four qualification fields and a real freshly
built MCP stdio tools/list probe confirms them. Production's actual spawned
facade/schema revision still needs verification; do not label prose as a schema
receipt or bypass required qualification. This run also hit the independent
integrity limit on finalization. Its assessment was not published.

## Prevention

Budget allocation independently of file count, cover concurrent/multiblock reads,
and retain safe limit-axis diagnostics before attempting another production scan.
Rebuild the deployed MCP bundle with the web revision; verify actual tools/list
before attributing missing structured arguments to the facade.
