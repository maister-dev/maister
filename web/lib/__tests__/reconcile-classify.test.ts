// M19 Phase 2 (T2.1): pure classifier `classifyRunReconcile` in
// `web/lib/reconcile.ts`. Exhaustive coverage of the §0.3 decision table
// (plan lines 57-68), asserted in the EXACT decision order:
//
//   1. status !== "Running"          -> {skip, "not-running"}   (allow-list)
//   2. !worktreeExists               -> {crash, "worktree-gone"}
//   3. liveSession                   -> {reattach, "live-session"}
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

describe("classifyRunReconcile — step 4c (linear): gate/human orphan → crash", () => {
  // M17 (ADR-056) window-(c): a flat steps[] run reparked onto an on_reject
  // goto target (or otherwise parked on a session-less gate/human node) has NO
  // graph mid-flow resume. Bare runFlow would restart at step 0 and re-run
  // prior agent/cli side-effects, so reconcile must CRASH it — crashRunningRun
  // retains the node in resume_target_step_id and operator Recover resumes from
  // it via crashResume.
  const LINEAR_KINDS: Array<ReconcileInput["currentNodeKind"]> = [
    "check",
    "judge",
    "guard",
    "human",
    null,
  ];

  for (const kind of LINEAR_KINDS) {
    it(`linear + no live session + ${String(kind)} node → crash / linear-gate-orphan`, () => {
      expect(
        classifyRunReconcile(
          input({ currentNodeKind: kind, isLinearFlow: true }),
        ),
      ).toEqual({ action: "crash", reason: "linear-gate-orphan" });
    });
  }

  it("linear flag does NOT affect cli (still cli-not-retry-safe)", () => {
    expect(
      classifyRunReconcile(
        input({ currentNodeKind: "cli", isLinearFlow: true }),
      ),
    ).toEqual({ action: "crash", reason: "cli-not-retry-safe" });
  });

  it("linear flag does NOT affect agent within grace (still skip)", () => {
    expect(
      classifyRunReconcile(
        input({
          currentNodeKind: "ai_coding",
          isLinearFlow: true,
          resumeStartedAt: ago(GRACE - 1),
        }),
      ),
    ).toEqual({ action: "skip", reason: "grace-window" });
  });

  it("graph (isLinearFlow false/omitted) keeps gate-redispatch", () => {
    expect(classifyRunReconcile(input({ currentNodeKind: "human" }))).toEqual({
      action: "redispatch",
      reason: "gate-redispatch",
    });
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

  it("scratch + live session → reattach / live-session", () => {
    expect(
      classifyRunReconcile(
        input({ runKind: "scratch", currentNodeKind: null, liveSession: true }),
      ),
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
