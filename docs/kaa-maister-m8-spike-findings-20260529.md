# M8 spike findings (T1) — cancel→checkpoint→resume→re-issue

**Date**: 2026-05-29
**Branch**: `feature/m8-worker-lifecycle`
**Scope**: T1 of the M8 task plan (`.ai-factory/plans/feature-m8-worker-lifecycle.md`).
**Outcome**: PASS. The resume strategy locked in `D4` of the plan is viable. T4–T19 may proceed.

> **Mechanism correction (2026-06-08, first dogfooding).** This spike modelled
> resume as a `--resume <id>` CLI flag. That is wrong for the ACP adapters:
> `claude-agent-acp` / `codex-acp` ignore `--resume` on argv. Resume is a
> **protocol** call — `session/resume` (restores context, no history replay;
> both adapters advertise `sessionCapabilities.resume`). The mock fixture and
> `supervisor/src/acp-client.ts` now use `session/resume`; read every
> "`--resume`" below as "the `session/resume` protocol call". Calling
> `session/new` on resume silently starts an EMPTY session — the bug this
> corrects.

## Goal

Prove the M8 design assumption that under the chosen graceful-checkpoint
strategy (`pendingPermissions.cancel(sessionId, requestId, "checkpoint")`
followed by `SIGTERM`), a fresh adapter process spawned with
`--resume <acpSessionId>` will re-issue `session.permission_request` for
the cancelled tool call. If this assumption did not hold, the whole
plan (T4 graceful checkpoint, T11 runner-agent auto-deliver) would
need to fall back to either (b) SIGTERM-while-pending or (c) synthetic
nudge-prompt injection on resume.

## Decision (locked 2026-05-29 before spike)

- **Spike target**: mock-acp-adapter only. No paid round-trip against
  the real `claude-agent-acp` (~$0.28 per cross-process resume per the
  M0 spike). Cost-benefit: the wire-level invariant is identical in
  both cases; the only divergence risk is the agent's own
  cancel-record semantics. That divergence is documented as a deferred
  risk (see §Risk surface) and a pre-M13 smoke test.

## Method

1. Forked `supervisor/test/fixtures/fake-acp.mjs` into a new
   ACP-speaking adapter at
   `supervisor/test/fixtures/mock-acp-adapter-resumable.mjs`. The
   fixture models the assumed claude-agent-acp behaviour:
   - On `requestPermission`, write the pending toolCall to a per-session
     journal at `${MOCK_ACP_STATE_DIR}/<acpSessionId>.json` BEFORE the
     await. (Models claude-agent-acp's append-on-emit JSONL session
     store — verified for the agent's own format in the M0 spike.)
   - On startup with `--resume <id>` AND a journal file whose
     `acpSessionId === id`, hydrate the prior `acpSessionId` and the
     `pendingPermission` marker.
   - In `newSession()`, return the hydrated `acpSessionId` instead of
     minting a new one. (Protocol invariant the real adapter also
     preserves — verified M0.)
   - On the first `prompt()` after a resume, re-issue
     `requestPermission` with the journaled toolCall/options BEFORE
     the normal echo, exactly modelling the claude-agent-acp replay
     contract this spike is testing.

2. Wrote
   `supervisor/src/__tests__/m8-resume-spike.integration.test.ts`
   that drives the full round-trip through the **real supervisor**
   (Fastify routes, `pendingPermissions` registry, `attachHeartbeat`,
   ACP client, registry SSE bus). The test:
   1. `POST /sessions` → captures `sessionId1`, `acpSessionId1`.
   2. `POST /sessions/:sessionId1/prompt` in the background. Mock parks
      on `requestPermission`.
   3. Awaits the `session.permission_request` event on the registry
      emitter → captures `requestId`.
   4. Calls `pendingPermissions.cancel(sessionId1, requestId, "checkpoint")`
      directly — this is the exact call T4 will issue from the new
      `POST /sessions/:id/checkpoint` endpoint.
   5. Awaits prompt HTTP completion (the cancelled outcome unparks the
      mock; the mock returns `end_turn`).
   6. `DELETE /sessions/:sessionId1` → SIGTERM the worker → waits for
      child exit.
   7. Reads the journal on disk and asserts `pendingPermission` is
      still present (the cancel-with-reason DID NOT clear the marker).
   8. `POST /sessions` with `resumeSessionId: acpSessionId1` →
      asserts the new session returns the SAME `acpSessionId` (proves
      cross-process resume preserves the wire-level identifier).
   9. `POST /sessions/:sessionId2/prompt` → asserts a fresh
      `session.permission_request` event arrives, carrying the
      ORIGINAL `toolCall.toolCallId === "tc-1"` AND a fresh
      `requestId !== <original requestId>` (re-correlation surface
      that T11 will rely on).
   10. Resolves the re-issued permission via `POST /sessions/:id/input`
       with `action: "select"` → asserts journal cleared after success.

3. Result: **single integration test passes in ~240ms**:

   ```
   ✓ |integration| src/__tests__/m8-resume-spike.integration.test.ts (1 test) 242ms
   ```

   Mock stderr log shows the round-trip explicitly:

   ```
   [mock-resumable] info {"msg":"new-session","acpSessionId":"mock-da9ab...","resumed":false}
   [mock-resumable] info {"msg":"resumed-from-journal","acpSessionId":"mock-da9ab...","hasPending":true}
   [mock-resumable] info {"msg":"new-session","acpSessionId":"mock-da9ab...","resumed":true}
   [mock-resumable] info {"msg":"replaying-permission","acpSessionId":"mock-da9ab...","toolCallId":"tc-1"}
   ```

## Conclusions

### Strategy locked: permission-cancel + SIGTERM (plan D4)

- The mock-modeled invariant holds end-to-end through the supervisor
  wire: a cancelled-with-reason permission can be persisted by the
  agent, the supervisor can SIGTERM the process, and a fresh
  `--resume`-d process replays the permission on the next prompt.
- T4 (`POST /sessions/:id/checkpoint`) can implement exactly what the
  spike harness simulates manually: call
  `pendingPermissions.cancel(sessionId, requestId, "checkpoint")` for
  every open deferred on the session BEFORE SIGTERM; on SIGTERM
  grace expiry escalate to SIGKILL (5xx — sweeper retries).
- T11 (runner-agent auto-deliver) can rely on the fact that the
  re-issued permission carries a NEW requestId but the SAME toolCall
  identifier. The re-correlation key for matching stored intent is
  `hitl_requests.kind='permission' AND response IS NOT NULL AND
  respondedAt IS NULL` per run+step — exactly what D9 of the plan
  prescribes.
- Cross-process resume preserves `acpSessionId` (verified for the
  real `claude` binary in M0; verified here for the mock). So
  `runs.acp_session_id` continues to be sufficient as the resume
  handle (CLAUDE.md §M0 finding 2 still holds for M8).

### Cancel-record semantics on the mock (and assumed for the real adapter)

The cancel marker carried by the supervisor's `pendingPermissions.cancel`
call is `outcome: "cancelled"` — there is NO `reason` field on the ACP
wire today. The `reason` is supervisor-side metadata used to:

1. Differentiate operator-cancel (M7) from checkpoint-cancel (M8) in
   supervisor logs.
2. Propagate onto the SSE `session.exited` event payload as an
   optional `reason: "checkpoint" | "intentional" | "crash"` field
   (T4 surface — locked for T17 AsyncAPI spec update).

The agent (mock or real) sees only `outcome: "cancelled"` and must
itself decide whether to record the cancellation as "ack the user
denied" or "replay on resume". The mock records ALL cancellations as
replay-on-resume; for the real `claude-agent-acp` this may not be
universally true (see §Risk surface).

### Replay-safety verdict

For the cancel-then-resume path inside the supervisor:

- `pendingPermissions` correctly purges all deferreds on
  `session.exited` (existing M7 wiring at
  `supervisor/src/registry.ts:81`), so the pre-cancel deferred is
  evicted twice harmlessly (cancel → evict; exit → purgeSession is a
  no-op because the entry is already gone).
- The new resumed-process session has a DIFFERENT supervisor-side
  `sessionId` (random UUIDv4) but the SAME `acpSessionId`. This is
  the layered identifier model M3 already established; M8 changes
  nothing here.
- The new requestId minted for the re-issued permission goes through
  the standard supervisor mint path
  (`supervisor/src/acp-client.ts:120 region`). T11's auto-deliver
  has the correlation surface it needs.

## Risk surface vs the real `claude-agent-acp`

Mock-only validation leaves three uncertainties about the real adapter
that the M0 spike did NOT cover:

1. **Cancel-record durability**: does `claude-agent-acp` persist
   cancelled-with-reason permissions to its session JSONL as
   "pending, replay on resume", or as "denied, do not replay"?
   The mock assumes the former; the real adapter MAY treat
   `outcome: "cancelled"` as a terminal user-denial (in which case
   `--resume` would NOT re-issue the permission). M0 verified that
   `claude --resume <uuid>` round-trips conversational context
   ("ALBATROSS-42") across process boundaries, but did not exercise
   a mid-permission cancel.

2. **Replay timing**: the mock replays the permission on the FIRST
   `prompt()` after resume, AFTER calling `newSession()`. The real
   adapter MAY emit the replay synchronously on session-resume,
   BEFORE the supervisor calls `prompt()`. If so, T11 needs to
   ensure the runner-agent's permission_request handler is ready to
   receive an event before the next prompt() rather than only during
   one. (T9 + T10 architecture already tolerates this: the resumed
   session is wired BEFORE the prompt-loop is re-entered.)

3. **Tool-call identifier stability**: the mock re-uses the original
   `toolCallId: "tc-1"`. The real adapter MAY mint a fresh
   `toolCallId` on replay (treating the re-issuance as a new tool
   call). T11's correlation key is `kind='permission' AND response
   IS NOT NULL AND respondedAt IS NULL` per run+step — it does NOT
   depend on `toolCallId` equality. This is robust to either
   adapter behaviour.

**Net assessment**: the M8 design is robust to risk #2 and #3.
Risk #1 is the only one that could invalidate the strategy if the
real adapter behaves differently than the mock.

## Follow-up

- **Pre-M13 manual smoke**: before dogfooding M13, run a single
  manual round-trip against `claude-agent-acp` to confirm cancel-
  with-reason → SIGTERM → `claude --resume <uuid>` re-issues the
  permission. Estimated cost ~$0.28 (M0 finding). If this round-trip
  reveals risk #1 is real, fall back to strategy (c) — synthetic
  nudge-prompt injection on resume (T11 auto-deliver becomes
  "auto-issue a no-op user message to wake the agent's prompt loop,
  then deliver intent on the resulting permission_request"). This
  is a non-trivial T11 rework but does not affect T2–T10 or T12–T19.
- The resumable mock at
  `supervisor/test/fixtures/mock-acp-adapter-resumable.mjs` is
  reusable by T18's E2E lifecycle integration test verbatim.

## Pointer for T4

T4 should:

```ts
app.post("/sessions/:id/checkpoint", async (req, reply) => {
  const entry = registry.get(req.params.id);
  if (!entry) { reply.status(404).send({ code: "PRECONDITION", message: "unknown session" }); return; }

  if (entry.record.status === "exited" || entry.record.status === "crashed") {
    reply.status(200).send({ alreadyCheckpointed: true, sessionId: entry.record.sessionId, monotonicId: entry.record.monotonicId });
    return;
  }

  // 1. cancel every pending permission for this session with reason="checkpoint"
  //    so the agent records "replay on resume" markers in its session journal.
  for (const requestId of pendingPermissions.requestIds(entry.record.sessionId)) {
    pendingPermissions.cancel(entry.record.sessionId, requestId, "checkpoint");
  }
  // 2. mark intentional shutdown so heartbeat reports session.exited (not crashed).
  registry.markIntentionalShutdown(entry.record.sessionId);
  // 3. SIGTERM with grace; SIGKILL on grace expiry → 500 EXECUTOR_UNAVAILABLE (retryable).
  entry.child.kill("SIGTERM");
  const exited = await waitForExit(entry, killGraceMs);
  if (!exited) {
    entry.child.kill("SIGKILL");
    throw new SupervisorError("EXECUTOR_UNAVAILABLE", "checkpoint timed out — SIGKILL escalation");
  }
  // 4. Propagate reason on session.exited (T17 AsyncAPI surface).
  reply.status(200).send({
    alreadyCheckpointed: false,
    sessionId: entry.record.sessionId,
    monotonicId: entry.record.monotonicId,
  });
});
```

Note `pendingPermissions.requestIds(sessionId)` is a new helper T4
will add — current `PendingPermissionRegistry` interface
(`supervisor/src/pending-permissions.ts:14-26`) exposes `size` but
not enumeration. T4 should add the iterator AND the iterator-aware
cancel test cases.
