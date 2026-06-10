// Pure readiness classifier — no DB, no IO, no server-only imports.
// Single source of truth shared by assertEvidenceReady, getRunReadiness,
// board queries, and portfolio queries. (ADR-048, M15)

import type { GateKind, GateResultStatus } from "@/lib/db/schema";

// An external_check gate blocks review/merge unless its latest live report is
// `passed` or human-`overridden`. `pending`/`failed`/`stale`/`skipped` all
// block — an allow-list (not a deny-list), so a future gate status can never
// silently read as ready. These pure helpers live here (not in
// external-gate-readiness) so the SSOT classifier carries no server-only marker;
// external-gate-readiness re-exports them for existing callers.
export const EXTERNAL_GATE_READY_STATUSES: ReadonlySet<string> = new Set([
  "passed",
  "overridden",
]);

export function isExternalGateReady(status: string): boolean {
  return EXTERNAL_GATE_READY_STATUSES.has(status);
}

// Collapse external_check gate rows to one representative per key: the row with
// the max `createdAt`, tiebreak `id` descending. Supersede-on-new-commit
// re-stales the prior `passed` row and appends a fresh row on the same
// (gateId, attempt), so only the latest report governs — a leftover `stale` row
// must never skew the verdict. `keyOf` is the grouping key: `gateId` within a
// single run, `${runId}:${gateId}` across runs. Callers pass rows already
// filtered to live (latest-attempt) external_check rows; the live-attempt filter
// stays caller-side because it differs per surface (single-run vs multi-run).
export function collapseLatestExternalPerGate<
  T extends { id: string; createdAt: Date },
>(rows: readonly T[], keyOf: (row: T) => string): T[] {
  const latest = new Map<string, T>();

  for (const row of rows) {
    const key = keyOf(row);
    const prev = latest.get(key);
    const newer =
      !prev ||
      row.createdAt.getTime() > prev.createdAt.getTime() ||
      (row.createdAt.getTime() === prev.createdAt.getTime() &&
        row.id > prev.id);

    if (newer) latest.set(key, row);
  }

  return [...latest.values()];
}

export type ReadinessState =
  | "ready"
  | "blocked"
  | "stale"
  | "failed"
  | "waiting"
  | "overridden";

export type ReadinessContribution =
  | "clear"
  | "overridden"
  | "waiting"
  | "blocked"
  | "stale"
  | "failed";

// Priority: highest-severity first. The first element present in a contribution
// set wins. "clear" is not listed — it maps to "ready" and never beats others.
export const READINESS_PRIORITY = [
  "failed",
  "stale",
  "blocked",
  "waiting",
  "overridden",
  "ready",
] as const;

// Map a gate_results.status to the readiness contribution it produces.
// passed → clear (no contribution), overridden → overridden, failed → failed,
// stale → stale, skipped → blocked, pending|running → waiting.
export function gateStatusContribution(
  status: GateResultStatus,
): ReadinessContribution {
  switch (status) {
    case "passed":
      return "clear";
    case "overridden":
      return "overridden";
    case "failed":
      return "failed";
    case "stale":
      return "stale";
    case "skipped":
      return "blocked";
    case "pending":
    case "running":
      return "waiting";
  }
}

// True when a gate verdict carries the M29 mutation-assertion failure marker
// (`payload.assertionFailed: true`, ADR-073). `verdict` is open jsonb — narrow
// structurally so callers can pass rows typed `any`/`unknown`.
function hasAssertionFailedVerdict(verdict: unknown): boolean {
  if (verdict === null || typeof verdict !== "object") return false;

  const payload = (verdict as { payload?: unknown }).payload;

  if (payload === null || typeof payload !== "object") return false;

  return (payload as { assertionFailed?: unknown }).assertionFailed === true;
}

// A blocking gate's readiness contribution, accounting for the
// `artifact_required` failed re-evaluation: a `failed` artifact_required gate
// whose `inputArtifactRefs` are ALL currently present (a validity="current"
// row exists for each) reads as `clear` — the recorded failure is stale, the
// artifacts having since been re-produced. Every other gate maps straight
// through gateStatusContribution. `currentDefIds` is the set of artifact def
// ids with a current row for the run. This is the SSOT for the re-eval rule:
// the merge guard (assertEvidenceReady), the readiness DTO (getRunReadiness),
// and the board/portfolio batch classifier all call it, so a `failed`
// artifact_required gate can never read `ready` on the merge path while showing
// `failed` on a badge. (M15, Task 21)
//
// M29 exception (ADR-073, D-C7): a failed gate whose verdict carries
// `payload.assertionFailed: true` HAS its inputs present — inputs-present is
// no longer sufficient to clear it. It stays `failed` until a rework attempt
// re-runs the gate and passes (the latest-attempt filter then drops this row).
export function blockingGateContribution(
  gate: {
    kind: GateKind | string;
    status: GateResultStatus;
    inputArtifactRefs?: readonly string[] | null;
    verdict?: unknown;
  },
  currentDefIds: ReadonlySet<string>,
): ReadinessContribution {
  if (gate.kind === "artifact_required" && gate.status === "failed") {
    if (hasAssertionFailedVerdict(gate.verdict)) return "failed";

    const refs = gate.inputArtifactRefs ?? [];

    return refs.length > 0 && refs.every((r) => currentDefIds.has(r))
      ? "clear"
      : "failed";
  }

  return gateStatusContribution(gate.status);
}

// Collapse contributions to the highest-priority ReadinessState.
// [] → ready; all "clear" → ready; "clear" maps to "ready" and is lowest.
export function rollupReadiness(
  contributions: readonly ReadinessContribution[],
): ReadinessState {
  // Map contribution → state (clear → ready; rest are identity).
  const toState = (c: ReadinessContribution): ReadinessState =>
    c === "clear" ? "ready" : c;

  let best: ReadinessState = "ready";

  for (const c of contributions) {
    const s = toState(c);
    const si = READINESS_PRIORITY.indexOf(s);
    const bi = READINESS_PRIORITY.indexOf(best);

    if (si < bi) best = s;
  }

  return best;
}

// A run may promote when its readiness is "ready" or "overridden".
export function isPhaseReady(state: ReadinessState): boolean {
  return state === "ready" || state === "overridden";
}

// Compute the set of attempt IDs that are the latest attempt per nodeId.
// Used to filter gate_results to live (non-stale) attempts.
export function latestAttemptIdsByNode(
  attempts: { id: string; nodeId: string; attempt: number }[],
): Set<string> {
  const latest = new Map<string, { id: string; attempt: number }>();

  for (const a of attempts) {
    const cur = latest.get(a.nodeId);

    if (!cur || a.attempt > cur.attempt) latest.set(a.nodeId, a);
  }

  const ids = new Set<string>();

  for (const v of latest.values()) ids.add(v.id);

  return ids;
}

// Filter gate rows to the blocking gates on live (latest) attempts.
// external_check rows are collapsed to latest-per-gateId via
// collapseLatestExternalPerGate; all other kinds pass through as-is.
// The result is the set of gate rows that the readiness classifier evaluates.
// `kind` accepts string to allow test rows typed as `GateKind | string`.
export function liveBlockingGates<
  T extends {
    id: string;
    gateId: string;
    kind: GateKind | string;
    mode: string;
    status: GateResultStatus;
    nodeAttemptId: string;
    createdAt: Date;
  },
>(gateRows: T[], liveAttemptIds: Set<string>): T[] {
  const liveBlocking = gateRows.filter(
    (g) => g.mode === "blocking" && liveAttemptIds.has(g.nodeAttemptId),
  );

  const nonExternal = liveBlocking.filter((g) => g.kind !== "external_check");
  const external = liveBlocking.filter((g) => g.kind === "external_check");
  const collapsedExternal = collapseLatestExternalPerGate(
    external,
    (g) => g.gateId,
  );

  return [...nonExternal, ...collapsedExternal];
}
