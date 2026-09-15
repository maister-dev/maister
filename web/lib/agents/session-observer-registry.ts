import "server-only";

// The in-process registry of agent-session observers.
//
// `consumeAgentSession` is the ONLY reader of an agent run's canonical event
// stream, and it lives in the web process. When that process dies — or the
// observer's supervisor exhausts its retry budget — nothing replaced it:
// reconcile saw a live session, classified `reattach`, and then REFUSED it
// (`refusing reattach for non-flow run`), so the run held a live session nobody
// read until the session itself died and the sweep crashed it as
// `agent-session-gone`.
//
// Membership is the discriminant reconcile keys on, exactly as `hasSyncDriver`
// is for branch sync (`@/lib/runs/sync-driver-registry`): a live agent session
// WITH an observer in this process is healthy → skip; WITHOUT one it needs a
// replacement → re-observe. It is also the mutual exclusion that keeps ONE
// observer per session — two readers of the same stream double every side
// effect on that path (a permission HITL row, an input delivery).
//
// Process-scoped by design and intentionally NOT durable: a restart clears it,
// which is precisely how a post-restart orphan is detected. Held on a global
// symbol so a duplicated module instance (server/edge bundles) shares one
// registry.

const REGISTRY_KEY = Symbol.for("maister.agent-session-observers.v1");

/** Why an observer stopped watching a session it never handed back. */
export type AgentObserverFailure = {
  sessionId: string;
  attempts: number;
  // The run sequence the last attempt got to, or null when it never read one.
  lastEventId: number | null;
  // The house `errorRecord` shape — an `error.name` is not a diagnosis.
  code: string;
  message: string;
  details?: unknown;
  at: string;
};

type ObserverRegistry = {
  sessions: Set<string>;
  failures: Map<string, AgentObserverFailure>;
};

// The failure ledger is read by the sweep that crashes the run, so an entry
// normally lives for one sweep interval. A run whose observer gave up but which
// nothing ever terminalizes here would keep its entry forever, so the map is
// bounded and evicts oldest-first (insertion order) rather than growing with
// process uptime.
const MAX_RECORDED_FAILURES = 256;

function registry(): ObserverRegistry {
  const g = globalThis as unknown as Record<
    symbol,
    ObserverRegistry | undefined
  >;

  if (!g[REGISTRY_KEY]) {
    g[REGISTRY_KEY] = { sessions: new Set(), failures: new Map() };
  }

  return g[REGISTRY_KEY]!;
}

/**
 * Take ownership of `sessionId` for this process. Returns false when this
 * process already observes it — the caller must NOT start a second observer.
 * Claiming for a run also clears that run's recorded give-up: a live observer
 * supersedes the reason the previous one stopped.
 */
export function claimAgentSessionObserver(
  runId: string,
  sessionId: string,
): boolean {
  const state = registry();

  if (state.sessions.has(sessionId)) return false;
  state.sessions.add(sessionId);
  state.failures.delete(runId);

  return true;
}

export function releaseAgentSessionObserver(sessionId: string): void {
  registry().sessions.delete(sessionId);
}

/** True iff a live in-process observer owns `sessionId` in THIS process. */
export function hasAgentSessionObserver(sessionId: string): boolean {
  return registry().sessions.has(sessionId);
}

/**
 * Record why this run lost its observer, so the terminal status the sweep
 * eventually writes names the refusal instead of only its own classification.
 */
export function recordAgentObserverFailure(
  runId: string,
  failure: AgentObserverFailure,
): void {
  const { failures } = registry();

  failures.delete(runId);
  failures.set(runId, failure);
  while (failures.size > MAX_RECORDED_FAILURES) {
    const oldest = failures.keys().next();

    if (oldest.done) break;
    failures.delete(oldest.value);
  }
}

/** Reads and clears the recorded give-up — one terminal status consumes it. */
export function takeAgentObserverFailure(
  runId: string,
): AgentObserverFailure | null {
  const { failures } = registry();
  const failure = failures.get(runId) ?? null;

  failures.delete(runId);

  return failure;
}

export function resetAgentSessionObserversForTests(): void {
  const state = registry();

  state.sessions.clear();
  state.failures.clear();
}
