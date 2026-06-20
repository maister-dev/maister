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
  | null;

export type RecoverPlan = "resume-agent" | "redispatch" | "discard-only";

// The recovery-plan analogue of classifyRunReconcile. PURE (no clock/db):
//   - ai_coding + acpSessionId present       -> "resume-agent" (--resume)
//   - ai_coding + acpSessionId null          -> "discard-only" (no session handle)
//   - session-less + retry_safe              -> "redispatch"   (re-run the node)
//   - session-less + NOT retry_safe (or null
//     node kind = no resolvable target)      -> "discard-only"
// M19 crash-recover (ADR-034, Codex round-3): a session-less node has NO
// `--resume` handle, so re-dispatch RE-RUNS it and repeats its side effects.
// That is offered ONLY when the Flow author marked the node `retry_safe: true`;
// otherwise the crashed node is discard-only. `ai_coding` ignores `retrySafe`
// (it recovers via `--resume`, not re-dispatch).
export function classifyRecover(
  run: { acpSessionId: string | null },
  currentNodeKind: NodeKind,
  retrySafe: boolean,
): RecoverPlan {
  // M37 (ADR-098): an orchestrator node is a long-lived agent session — it
  // recovers via session/resume exactly like ai_coding, never re-dispatch.
  if (currentNodeKind === "ai_coding" || currentNodeKind === "orchestrator") {
    return run.acpSessionId ? "resume-agent" : "discard-only";
  }

  return retrySafe ? "redispatch" : "discard-only";
}
