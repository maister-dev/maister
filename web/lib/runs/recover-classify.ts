// Pure recovery-plan classifier (no "server-only", no db/clock). Shared by the
// backend recovery driver (`resumeCrashedRun`/`driveResume` in recover.ts) AND
// the run-detail recoverability projection (`isRunRecoverable` in
// queries/run.ts) so the UI affordance can NEVER drift from the backend's
// actual recovery capability (Codex M19c finding #1).

export type NodeKind =
  | "ai_coding"
  | "cli"
  | "check"
  | "judge"
  | "guard"
  | "human"
  | "form"
  | "orchestrator"
  | "consensus"
  | null;

export type RecoverPlan = "resume-agent" | "redispatch" | "discard-only";

// The node kinds that run an ACP session and therefore recover by RESUMING it
// rather than by re-running. Identical to the set `admitNodePrompt` admits as
// an agent node, which is the point: a kind the prompt owner treats as an agent
// but the recover classifier treats as session-less is a run nobody can rescue.
//
// M37 (ADR-098): an orchestrator node is a long-lived agent session.
// ADR-175: `judge` joins them. It always ran an ACP session, but fell through
// to the session-less branch, where `retry_safe: false` (the default) made a
// crashed judge `discard-only`. This is an observable behavior change, not a
// refactor — a crashed `judge` with a retained handle now answers `200 resumed`
// where it used to answer `409 discard-only`.
const AGENT_NODE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  "ai_coding",
  "judge",
  "orchestrator",
]);

// The recovery-plan analogue of classifyRunReconcile. PURE (no clock/db):
//   - agent node + acpSessionId present      -> "resume-agent" (graph re-entry,
//                                               resuming the node's own session)
//   - agent node + acpSessionId null         -> "discard-only" (no session handle)
//   - session-less + retry_safe              -> "redispatch"   (re-run the node)
//   - session-less + NOT retry_safe (or null
//     node kind = no resolvable target)      -> "discard-only"
// M19 crash-recover (ADR-034, Codex round-3): a session-less node has NO
// resume handle, so re-dispatch RE-RUNS it and repeats its side effects. That is
// offered ONLY when the Flow author marked the node `retry_safe: true`;
// otherwise the crashed node is discard-only. An agent node ignores `retrySafe`
// (it recovers by resuming its session, not by re-running).
export function classifyRecover(
  run: { acpSessionId: string | null },
  currentNodeKind: NodeKind,
  retrySafe: boolean,
  consensusEvidence: {
    incompleteSynthesis: boolean;
    quarantined: boolean;
  } = { incompleteSynthesis: false, quarantined: false },
): RecoverPlan {
  if (currentNodeKind === "consensus") {
    if (consensusEvidence.quarantined) return "discard-only";

    return consensusEvidence.incompleteSynthesis
      ? "redispatch"
      : "discard-only";
  }
  if (AGENT_NODE_KINDS.has(currentNodeKind)) {
    return run.acpSessionId ? "resume-agent" : "discard-only";
  }

  return retrySafe ? "redispatch" : "discard-only";
}
