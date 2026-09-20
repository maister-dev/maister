/**
 * ADR-176 D1 — the ONE recover-vs-reattach decision for a committed recover
 * intent (`runs.resume_started_at` set on a `Running` flow run with a
 * `current_step_id`).
 *
 * Two callers reach this state: the reconcile sweep on its <= 60 s tick, and
 * the flow continuation worker on its ~1 s idle wake. They must not each carry
 * their own copy, and not because a copy might drift — because a copy built on
 * the SQL predicate alone would be wrong on day one. The predicate identifies a
 * candidate; it does not authorize `driveResume`. On a LIVE session,
 * `driveResume`'s `closeCrashedNodeAttempts` would close an attempt the session
 * is still producing and the re-prompt would double-spend that turn.
 *
 * Deliberately pure and import-free: liveness is a PROBE the caller performs
 * (`hosts.local().listSessions()`), never a column, and a caller whose probe
 * throws must yield the candidate rather than pass a guessed value here.
 */
export type CrashRecoverRoute = "recover" | "reattach" | "wait";

export type CrashRecoverRouteInput = Readonly<{
  /** Resolved by probe. A caller that could not probe MUST NOT call this. */
  liveSession: boolean;
  resumeStartedAt: Date | null;
  latestAttemptStartedAt: Date | null;
  nowMs: number;
  graceSeconds: number;
}>;

function mostRecentMs(a: Date | null, b: Date | null): number | null {
  const am = a?.getTime() ?? null;
  const bm = b?.getTime() ?? null;

  if (am === null) return bm;
  if (bm === null) return am;

  return Math.max(am, bm);
}

export function routeCrashRecover(
  input: CrashRecoverRouteInput,
): CrashRecoverRoute {
  // A live session is re-entered through `runFlow(runId, {crashResume})` and
  // NEVER through `driveResume` — this is the whole reason the decision is
  // shared. Ordered first: liveness outranks the grace window, exactly as the
  // sweep's classifier orders them.
  if (input.liveSession) return "reattach";

  // Inside grace a dispatch may still be in flight; yield rather than race it.
  // Anchor = the MORE RECENT non-null of resume / latest-attempt, strict `<`,
  // and both-null means past grace.
  const anchorMs = mostRecentMs(
    input.resumeStartedAt,
    input.latestAttemptStartedAt,
  );

  if (anchorMs !== null && (input.nowMs - anchorMs) / 1000 < input.graceSeconds)
    return "wait";

  return "recover";
}
