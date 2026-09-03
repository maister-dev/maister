// M19 Phase 2 (T2.1): pure classifier `classifyRunReconcile` in
// `web/lib/reconcile.ts`. Exhaustive coverage of the §0.3 decision table
// (plan lines 57-68), asserted in the EXACT decision order:
//
//   1. status !== "Running"          -> {skip, "not-running"}   (allow-list)
//   2. !worktreeExists               -> {crash, "worktree-gone"}
//   3. liveSession                   -> flow: {reattach, "live-session"};
//                                       scratch: {skip, "live-scratch-session"}
//   4. no live session, by node kind (scratch behaves as an agent node):
//      - cli                         -> {crash, "cli-not-retry-safe"}
//      - agent (ai_coding / scratch): grace anchor = MORE RECENT of
//        resumeStartedAt / latestAttemptStartedAt; within grace ->
//        {skip, "grace-window"}; past grace (or both-null) ->
//        {crash, "agent-session-gone"}
//      - retry-safe gate (check/judge/guard/human/null):
//        - GRAPH (nodes[]) run        -> {redispatch, "gate-redispatch"}
//        - LINEAR (isLinearFlow) run  -> {crash, "linear-gate-orphan"}  (M17
//          ADR-056: a flat steps[] run has no graph mid-flow resume, so bare
//          re-dispatch would restart at step 0 and re-run prior side-effects)
//
// The classifier is PURE — nowMs/graceSeconds are inputs, no clock/db access.

import type { ReconcileInput } from "@/lib/reconcile";

import { describe, expect, it } from "vitest";

import { classifyRunReconcile } from "@/lib/reconcile";

const NOW = 1_700_000_000_000;
const GRACE = 90;

// A baseline healthy-agent input: Running flow run, agent node, worktree
// present, NO live session, anchors absent. Each test overrides exactly the
// fields under examination so the decision-order is unambiguous.
function input(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    runStatus: "Running",
    runKind: "flow",
    acpSessionId: "acp-1",
    currentStepId: "implement",
    currentNodeKind: "ai_coding",
    worktreeExists: true,
    liveSession: false,
    resumeStartedAt: null,
    latestAttemptStartedAt: null,
    nowMs: NOW,
    graceSeconds: GRACE,
    ...overrides,
  };
}

// Helper: a Date `seconds` before NOW.
function ago(seconds: number): Date {
  return new Date(NOW - seconds * 1000);
}

describe("classifyRunReconcile — step 1: allow-list Running-only", () => {
  const NON_RUNNING = [
    "Pending",
    "NeedsInput",
    "NeedsInputIdle",
    "HumanWorking",
    "Review",
    "Done",
    "Abandoned",
    "Crashed",
    "Failed",
  ];

  for (const status of NON_RUNNING) {
    it(`status='${status}' → skip / not-running (even with worktree gone + no session)`, () => {
      // Worktree-gone + no-live-session would CRASH a Running row; the
      // allow-list short-circuits BEFORE those checks for any non-Running row.
      expect(
        classifyRunReconcile(
          input({
            runStatus: status,
            worktreeExists: false,
            liveSession: false,
          }),
        ),
      ).toEqual({ action: "skip", reason: "not-running" });
    });
  }
});

describe("classifyRunReconcile — step 2: worktree gone → crash", () => {
  it("Running + worktree MISSING → crash / worktree-gone (wins over live session)", () => {
    // worktree-gone is checked BEFORE liveSession: a missing worktree can't
    // continue even if a session is somehow still live.
    expect(
      classifyRunReconcile(input({ worktreeExists: false, liveSession: true })),
    ).toEqual({ action: "crash", reason: "worktree-gone" });
  });

  it("Running + worktree MISSING + cli node → crash / worktree-gone (wins over node kind)", () => {
    expect(
      classifyRunReconcile(
        input({ worktreeExists: false, currentNodeKind: "cli" }),
      ),
    ).toEqual({ action: "crash", reason: "worktree-gone" });
  });
});

describe("classifyRunReconcile — step 3: live session → reattach", () => {
  it("Running + worktree present + live session → reattach / live-session", () => {
    expect(classifyRunReconcile(input({ liveSession: true }))).toEqual({
      action: "reattach",
      reason: "live-session",
    });
  });

  it("live session wins over node kind (cli) and over grace anchors", () => {
    expect(
      classifyRunReconcile(
        input({
          liveSession: true,
          currentNodeKind: "cli",
          resumeStartedAt: ago(1),
        }),
      ),
    ).toEqual({ action: "reattach", reason: "live-session" });
  });
});

describe("classifyRunReconcile — step 3.5: live (runId,stepId) session, acp unmatched → skip", () => {
  // The crash bug: a long in-flight ai_coding node has acp_session_id = null on
  // the run row (it is persisted only AFTER the prompt returns), so the
  // acp-keyed `liveSession` is false. The supervisor DOES have a live session
  // for (runId, stepId). Past the grace window the OLD code crashed it
  // ("agent-session-gone"); the node is genuinely running, so it must skip.
  it("agent past grace + acp-unmatched but live run/step session → skip / live-session-by-step", () => {
    expect(
      classifyRunReconcile(
        input({
          currentNodeKind: "ai_coding",
          liveSession: false,
          liveRunStepSession: true,
          resumeStartedAt: ago(GRACE + 1000),
          latestAttemptStartedAt: ago(GRACE + 1000),
        }),
      ),
    ).toEqual({ action: "skip", reason: "live-session-by-step" });
  });

  it("acp-matched live session (reattach) wins over liveRunStepSession", () => {
    expect(
      classifyRunReconcile(
        input({ liveSession: true, liveRunStepSession: true }),
      ),
    ).toEqual({ action: "reattach", reason: "live-session" });
  });

  it("worktree-gone wins over liveRunStepSession", () => {
    expect(
      classifyRunReconcile(
        input({ worktreeExists: false, liveRunStepSession: true }),
      ),
    ).toEqual({ action: "crash", reason: "worktree-gone" });
  });

  it("a live run/step session skips regardless of node kind (still alive)", () => {
    expect(
      classifyRunReconcile(
        input({ currentNodeKind: "cli", liveRunStepSession: true }),
      ),
    ).toEqual({ action: "skip", reason: "live-session-by-step" });
  });
});

describe("classifyRunReconcile — step 4a: cli node, no live session → crash", () => {
  it("Running + no live session + cli node → crash / cli-not-retry-safe", () => {
    expect(classifyRunReconcile(input({ currentNodeKind: "cli" }))).toEqual({
      action: "crash",
      reason: "cli-not-retry-safe",
    });
  });

  it("cli crash is independent of grace anchors (cli is never retry-safe)", () => {
    // Even a freshly-started cli node (within grace) is crashed — the grace
    // window only protects agent nodes.
    expect(
      classifyRunReconcile(
        input({ currentNodeKind: "cli", resumeStartedAt: ago(1) }),
      ),
    ).toEqual({ action: "crash", reason: "cli-not-retry-safe" });
  });
});

describe("classifyRunReconcile — step 4b: agent node grace window", () => {
  it("agent + within grace via resumeStartedAt → skip / grace-window", () => {
    expect(
      classifyRunReconcile(
        input({
          currentNodeKind: "ai_coding",
          resumeStartedAt: ago(GRACE - 1),
          latestAttemptStartedAt: null,
        }),
      ),
    ).toEqual({ action: "skip", reason: "grace-window" });
  });

  it("agent + within grace via fresh latestAttemptStartedAt → skip / grace-window", () => {
    expect(
      classifyRunReconcile(
        input({
          currentNodeKind: "ai_coding",
          resumeStartedAt: null,
          latestAttemptStartedAt: ago(GRACE - 1),
        }),
      ),
    ).toEqual({ action: "skip", reason: "grace-window" });
  });

  it("agent + grace anchor = MORE RECENT of the two (stale resume, fresh attempt) → skip", () => {
    // resumeStartedAt is past grace, but the latest attempt is fresh; the
    // anchor is the MORE RECENT timestamp, so the run is still in grace.
    expect(
      classifyRunReconcile(
        input({
          currentNodeKind: "ai_coding",
          resumeStartedAt: ago(GRACE + 100),
          latestAttemptStartedAt: ago(GRACE - 1),
        }),
      ),
    ).toEqual({ action: "skip", reason: "grace-window" });
  });

  it("agent + grace anchor = MORE RECENT (fresh resume, stale attempt) → skip", () => {
    expect(
      classifyRunReconcile(
        input({
          currentNodeKind: "ai_coding",
          resumeStartedAt: ago(GRACE - 1),
          latestAttemptStartedAt: ago(GRACE + 100),
        }),
      ),
    ).toEqual({ action: "skip", reason: "grace-window" });
  });

  it("agent + past grace (both anchors older) → crash / agent-session-gone", () => {
    expect(
      classifyRunReconcile(
        input({
          currentNodeKind: "ai_coding",
          resumeStartedAt: ago(GRACE + 10),
          latestAttemptStartedAt: ago(GRACE + 50),
        }),
      ),
    ).toEqual({ action: "crash", reason: "agent-session-gone" });
  });

  it("agent + both anchors null ⇒ past grace ⇒ crash / agent-session-gone", () => {
    expect(
      classifyRunReconcile(
        input({
          currentNodeKind: "ai_coding",
          resumeStartedAt: null,
          latestAttemptStartedAt: null,
        }),
      ),
    ).toEqual({ action: "crash", reason: "agent-session-gone" });
  });

  it("agent exactly AT grace boundary (elapsed == graceSeconds) → crash (strict <)", () => {
    // The contract is `(nowMs - anchor)/1000 < graceSeconds` → skip; an anchor
    // exactly graceSeconds old is NOT within grace.
    expect(
      classifyRunReconcile(
        input({
          currentNodeKind: "ai_coding",
          resumeStartedAt: ago(GRACE),
        }),
      ),
    ).toEqual({ action: "crash", reason: "agent-session-gone" });
  });
});

describe("classifyRunReconcile — step 4c: retry-safe gate → redispatch", () => {
  const GATE_KINDS: Array<ReconcileInput["currentNodeKind"]> = [
    "check",
    "judge",
    "guard",
    "human",
    null,
  ];

  for (const kind of GATE_KINDS) {
    it(`no live session + ${String(kind)} node → redispatch / gate-redispatch`, () => {
      expect(classifyRunReconcile(input({ currentNodeKind: kind }))).toEqual({
        action: "redispatch",
        reason: "gate-redispatch",
      });
    });
  }

  it("gate redispatch ignores grace anchors (only agents observe grace)", () => {
    expect(
      classifyRunReconcile(
        input({ currentNodeKind: "check", resumeStartedAt: ago(1) }),
      ),
    ).toEqual({ action: "redispatch", reason: "gate-redispatch" });
  });
});

describe("classifyRunReconcile — scratch runs behave as an agent node", () => {
  it("scratch + no live session + past grace (currentNodeKind null) → crash / agent-session-gone", () => {
    // runKind='scratch' takes the AGENT branch regardless of currentNodeKind
    // (scratch carries no compiled graph node).
    expect(
      classifyRunReconcile(
        input({
          runKind: "scratch",
          currentNodeKind: null,
          resumeStartedAt: null,
          latestAttemptStartedAt: null,
        }),
      ),
    ).toEqual({ action: "crash", reason: "agent-session-gone" });
  });

  it("scratch + within grace (currentNodeKind null) → skip / grace-window", () => {
    expect(
      classifyRunReconcile(
        input({
          runKind: "scratch",
          currentNodeKind: null,
          resumeStartedAt: ago(GRACE - 1),
        }),
      ),
    ).toEqual({ action: "skip", reason: "grace-window" });
  });

  it("scratch + live session → skip / live-scratch-session (NOT reattach)", () => {
    // A live `Running` scratch dialog has finished a turn and is waiting for the
    // next user message — it must NOT be driven by the resume driver (whose
    // continuation prompt + permission replay only fit flow HITL recovery).
    // Reattaching here falsely crashes it (`resume-prompt-no-permission`).
    expect(
      classifyRunReconcile(
        input({ runKind: "scratch", currentNodeKind: null, liveSession: true }),
      ),
    ).toEqual({ action: "skip", reason: "live-scratch-session" });
  });

  it("flow + live session still → reattach / live-session (regression guard)", () => {
    // The scratch carve-out must NOT regress flow HITL-recovery reattach.
    expect(
      classifyRunReconcile(input({ runKind: "flow", liveSession: true })),
    ).toEqual({ action: "reattach", reason: "live-session" });
  });

  it("scratch + worktree gone → crash / worktree-gone", () => {
    expect(
      classifyRunReconcile(
        input({
          runKind: "scratch",
          currentNodeKind: null,
          worktreeExists: false,
        }),
      ),
    ).toEqual({ action: "crash", reason: "worktree-gone" });
  });

  it("scratch does NOT fall into the cli crash branch even if node kind is somehow 'cli'", () => {
    // The contract says scratch ALWAYS uses the agent branch. A within-grace
    // scratch must skip, not crash on a spurious cli kind.
    expect(
      classifyRunReconcile(
        input({
          runKind: "scratch",
          currentNodeKind: "cli",
          resumeStartedAt: ago(GRACE - 1),
        }),
      ),
    ).toEqual({ action: "skip", reason: "grace-window" });
  });
});

describe("classifyRunReconcile — M37 T7.1: orphaned child (parent gone)", () => {
  // A Running child whose delegator parent is Crashed/Abandoned/missing can no
  // longer be coordinated → crash. Caught BEFORE the session/grace checks, so an
  // orphan is crashed even while its OWN session still looks live or fresh.
  // Every TERMINAL parent status counts as gone, plus a missing row. Failed was
  // the live hole: a Running orchestrator tripping its own run-scope budget, or
  // failing at a node, goes Failed WITHOUT cascading — its children were never
  // recovered because only Crashed/Abandoned were treated as coordinator death.
  for (const parentStatus of [
    "Crashed",
    "Abandoned",
    "Failed",
    "Done",
    null,
  ] as const) {
    it(`Running child + parent ${String(parentStatus)} → crash / orphaned-child`, () => {
      expect(
        classifyRunReconcile(
          input({
            parentRunId: "parent-1",
            parentStatus,
          }),
        ),
      ).toEqual({ action: "crash", reason: "orphaned-child" });
    });
  }

  it("orphan crash wins over a live session and fresh grace anchors", () => {
    expect(
      classifyRunReconcile(
        input({
          parentRunId: "parent-1",
          parentStatus: "Crashed",
          liveSession: true,
          resumeStartedAt: ago(1),
        }),
      ),
    ).toEqual({ action: "crash", reason: "orphaned-child" });
  });

  it("worktree-gone still wins over orphan (checked first)", () => {
    expect(
      classifyRunReconcile(
        input({
          parentRunId: "parent-1",
          parentStatus: "Crashed",
          worktreeExists: false,
        }),
      ),
    ).toEqual({ action: "crash", reason: "worktree-gone" });
  });

  for (const parentStatus of [
    "Running",
    "WaitingOnChildren",
    "NeedsInput",
  ] as const) {
    it(`child with a HEALTHY parent (${parentStatus}) is NOT orphaned → normal classification`, () => {
      // A live session on a healthy-parent child reattaches as usual.
      expect(
        classifyRunReconcile(
          input({
            parentRunId: "parent-1",
            parentStatus,
            liveSession: true,
          }),
        ),
      ).toEqual({ action: "reattach", reason: "live-session" });
    });
  }

  it("a top-level run (no parentRunId) is never orphaned even if parentStatus is null", () => {
    expect(
      classifyRunReconcile(
        input({ parentRunId: null, parentStatus: null, liveSession: true }),
      ),
    ).toEqual({ action: "reattach", reason: "live-session" });
  });
});

describe("classifyRunReconcile — orphans in a NON-Running status (per-status recovery)", () => {
  // The Running-only allow-list used to hide every other orphan forever. The
  // outcome is by status: a queued child never started (abandon); a paused or
  // reviewing child waits on a decision its coordinator can no longer make
  // (crash — recoverable); a HumanWorking child is a person's worktree (skip,
  // loudly); a parked sub-orchestrator must cascade its own children first.
  it("Pending child + parent gone → abandon / orphaned-child", () => {
    expect(
      classifyRunReconcile(
        input({
          runStatus: "Pending",
          parentRunId: "parent-1",
          parentStatus: "Abandoned",
        }),
      ),
    ).toEqual({ action: "abandon", reason: "orphaned-child" });
  });

  for (const runStatus of ["NeedsInput", "NeedsInputIdle", "Review"] as const) {
    it(`${runStatus} child + parent gone → crash / orphaned-child`, () => {
      expect(
        classifyRunReconcile(
          input({
            runStatus,
            parentRunId: "parent-1",
            parentStatus: "Crashed",
          }),
        ),
      ).toEqual({ action: "crash", reason: "orphaned-child" });
    });
  }

  it("HumanWorking child + parent gone → skip / orphaned-human-working (never terminalized)", () => {
    expect(
      classifyRunReconcile(
        input({
          runStatus: "HumanWorking",
          parentRunId: "parent-1",
          parentStatus: "Abandoned",
        }),
      ),
    ).toEqual({ action: "skip", reason: "orphaned-human-working" });
  });

  it("parked sub-orchestrator + parent gone → crash / orphaned-orchestrator, even with a live session and pending children", () => {
    // Liveness and pending children only say it COULD still be woken — by a
    // parent that no longer exists. Checked first.
    expect(
      classifyRunReconcile(
        input({
          runStatus: "WaitingOnChildren",
          parentRunId: "parent-1",
          parentStatus: "Crashed",
          liveSession: true,
          hasPendingChildren: true,
        }),
      ),
    ).toEqual({ action: "crash", reason: "orphaned-orchestrator" });
  });

  it("a NeedsInput child of a HEALTHY parent is still not-running (the arm fires only for orphans)", () => {
    expect(
      classifyRunReconcile(
        input({
          runStatus: "NeedsInput",
          parentRunId: "parent-1",
          parentStatus: "WaitingOnChildren",
        }),
      ),
    ).toEqual({ action: "skip", reason: "not-running" });
  });
});

describe("classifyRunReconcile — M37 T7.1: parked orchestrator (WaitingOnChildren)", () => {
  // A parked orchestrator is crashed ONLY when genuinely stuck: no live session,
  // no non-terminal children left, AND past the grace window.
  it("WaitingOnChildren + no session + no pending children + past grace → crash / orchestrator-stuck", () => {
    expect(
      classifyRunReconcile(
        input({
          runStatus: "WaitingOnChildren",
          liveSession: false,
          hasPendingChildren: false,
          resumeStartedAt: ago(GRACE + 10),
          latestAttemptStartedAt: ago(GRACE + 10),
        }),
      ),
    ).toEqual({ action: "crash", reason: "orchestrator-stuck" });
  });

  it("WaitingOnChildren + both anchors null ⇒ past grace ⇒ crash / orchestrator-stuck", () => {
    expect(
      classifyRunReconcile(
        input({
          runStatus: "WaitingOnChildren",
          liveSession: false,
          hasPendingChildren: false,
          resumeStartedAt: null,
          latestAttemptStartedAt: null,
        }),
      ),
    ).toEqual({ action: "crash", reason: "orchestrator-stuck" });
  });

  it("WaitingOnChildren with a pending child → skip / orchestrator-waiting (will be woken)", () => {
    expect(
      classifyRunReconcile(
        input({
          runStatus: "WaitingOnChildren",
          liveSession: false,
          hasPendingChildren: true,
          resumeStartedAt: ago(GRACE + 10),
          latestAttemptStartedAt: ago(GRACE + 10),
        }),
      ),
    ).toEqual({ action: "skip", reason: "orchestrator-waiting" });
  });

  it("WaitingOnChildren with a LIVE session → skip / orchestrator-waiting (came back)", () => {
    expect(
      classifyRunReconcile(
        input({
          runStatus: "WaitingOnChildren",
          liveSession: true,
          hasPendingChildren: false,
        }),
      ),
    ).toEqual({ action: "skip", reason: "orchestrator-waiting" });
  });

  it("WaitingOnChildren + no pending children + WITHIN grace → skip / grace-window", () => {
    expect(
      classifyRunReconcile(
        input({
          runStatus: "WaitingOnChildren",
          liveSession: false,
          hasPendingChildren: false,
          resumeStartedAt: ago(GRACE - 1),
        }),
      ),
    ).toEqual({ action: "skip", reason: "grace-window" });
  });
});

// ADR-141 — the branch-sync arm. The in-process sync-driver REGISTRY is
// the skip-vs-abort discriminant, and it must be consulted INDEPENDENTLY of
// `liveSession`: a resolver's `run_sessions` row carries `acp_session_id: null`
// (the supervisor handle is never persisted for sync), so `liveSession` is always
// FALSE for a live resolver. Nesting the registry check under `liveSession` made
// the skip unreachable and classified every live resolver as an orphan — the
// recovery arm then hard-reset the worktree under the running agent.
describe("classifyRunReconcile — branch sync (ADR-141)", () => {
  it("SKIPS a live in-process sync driver even though a sync session never reports liveSession", () => {
    expect(
      classifyRunReconcile(
        input({
          activeSyncAttempt: true,
          syncDriverActive: true,
          liveSession: false, // the real shape for a sync resolver
        }),
      ),
    ).toEqual({ action: "skip", reason: "sync-driver-live" });
  });

  it("SKIPS a live driver regardless of liveSession (the registry wins outright)", () => {
    expect(
      classifyRunReconcile(
        input({
          activeSyncAttempt: true,
          syncDriverActive: true,
          liveSession: true,
        }),
      ),
    ).toEqual({ action: "skip", reason: "sync-driver-live" });
  });

  it("recovers an orphan with no driver — liveSession only picks W2 vs W3", () => {
    expect(
      classifyRunReconcile(
        input({
          activeSyncAttempt: true,
          syncDriverActive: false,
          liveSession: true,
        }),
      ),
    ).toEqual({ action: "sync-recover", reason: "sync-orphaned-live" });

    expect(
      classifyRunReconcile(
        input({
          activeSyncAttempt: true,
          syncDriverActive: false,
          liveSession: false,
        }),
      ),
    ).toEqual({ action: "sync-recover", reason: "sync-orphaned-idle" });
  });
});
