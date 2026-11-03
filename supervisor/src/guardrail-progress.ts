import type { NoProgressDiagnostics } from "./types";

import { createHash } from "node:crypto";

import { noProgressTick, WRITE_KINDS } from "./guardrail-hooks";

type ToolEvidence = {
  kind: string;
  request?: string;
  result?: string;
};

export type ProgressState = {
  pending: ReadonlyMap<string, ToolEvidence>;
  settled: ReadonlySet<string>;
  thresholdCohort?: ReadonlySet<string>;
  evidence: ReadonlySet<string>;
  countedOperations: number;
  turnsSinceProgress: number;
  progressResets: number;
  ignoredUpdates: number;
  recentOperations: NoProgressDiagnostics["recentOperations"];
};

export function initialProgressState(): ProgressState {
  return {
    pending: new Map(),
    settled: new Set(),
    evidence: new Set(),
    countedOperations: 0,
    turnsSinceProgress: 0,
    progressResets: 0,
    ignoredUpdates: 0,
    recentOperations: [],
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = object(value);

  if (obj)
    return `{${Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`)
      .join(",")}}`;

  return JSON.stringify(value) ?? "null";
}

function digest(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value) && value.length === 0) return undefined;
  if (object(value) && Object.keys(value as object).length === 0)
    return undefined;

  return createHash("sha256").update(canonical(value)).digest("hex");
}

function mergeEvidence(
  previous: ToolEvidence | undefined,
  update: Record<string, unknown>,
): ToolEvidence {
  return {
    kind:
      typeof update.kind === "string"
        ? update.kind
        : (previous?.kind ?? "unknown"),
    request:
      digest(update.rawInput) ?? digest(update.locations) ?? previous?.request,
    result:
      digest(update.rawOutput) ?? digest(update.content) ?? previous?.result,
  };
}

/**
 * Work is a settled tool ID, never a notification or a tool start. Successful
 * mutations establish a new request; investigation (including read-only
 * roles) must reveal a new result from a new request, so output timestamps
 * from the same resource or command cannot keep resetting. Display titles and
 * IDs are not evidence. Novelty memory is capped at 4096 hashes per session.
 * Unchanged results, failures, unsolicited cancellation and sparse completions
 * consume the budget. The caller excludes intentional stop notifications.
 * At threshold, the current pending cohort gets up to maxTurns further settled
 * operations to supply evidence. New starts cannot extend this grace. Duration
 * guards own hangs without terminal notifications.
 */
export function accountProgress(
  previous: ProgressState,
  notification: unknown,
  maxTurns: number,
): { state: ProgressState; tripped: boolean } {
  const update = object(notification);

  if (
    !update ||
    !["tool_call", "tool_call_update"].includes(String(update.sessionUpdate))
  ) {
    return { state: previous, tripped: false };
  }
  const id =
    typeof update.toolCallId === "string" && update.toolCallId
      ? update.toolCallId
      : null;

  if (!id || previous.settled.has(id)) {
    return {
      state: { ...previous, ignoredUpdates: previous.ignoredUpdates + 1 },
      tripped: false,
    };
  }
  const tool = mergeEvidence(previous.pending.get(id), update);
  const pending = new Map(previous.pending);
  const status = String(update.status ?? "pending");

  if (!["completed", "failed", "cancelled"].includes(status)) {
    pending.set(id, tool);

    return { state: { ...previous, pending }, tripped: false };
  }
  pending.delete(id);
  const settled = new Set(previous.settled).add(id);

  // Keep only hashes, never raw inputs/results, and bound novelty memory. Once
  // full, unseen evidence is unproven work; eviction would credit old loops anew.
  const fingerprint = WRITE_KINDS.has(tool.kind)
    ? tool.request && `mutation:${tool.request}`
    : ["read", "search", "fetch", "execute", "other", "think"].includes(
          tool.kind,
        ) && tool.result
      ? `result:${tool.result}`
      : undefined;
  const investigationRequest =
    !WRITE_KINDS.has(tool.kind) && tool.request
      ? `request:${tool.kind}:${tool.request}`
      : undefined;
  const progress =
    status === "completed" &&
    fingerprint !== undefined &&
    !previous.evidence.has(fingerprint) &&
    previous.evidence.size < 4096 &&
    (WRITE_KINDS.has(tool.kind) ||
      (investigationRequest !== undefined &&
        !previous.evidence.has(investigationRequest)));
  const evidence = new Set(previous.evidence);

  if (progress && fingerprint) {
    evidence.add(fingerprint);
    if (investigationRequest) evidence.add(investigationRequest);
  }
  const tick = noProgressTick(previous, progress, maxTurns);
  const thresholdCohort = progress
    ? undefined
    : previous.thresholdCohort !== undefined
      ? new Set(previous.thresholdCohort)
      : tick.tripped
        ? new Set(pending.keys())
        : undefined;

  thresholdCohort?.delete(id);
  const reason =
    status !== "completed"
      ? status
      : progress
        ? "new_evidence"
        : !fingerprint
          ? "missing_evidence"
          : "unchanged_evidence";
  const state: ProgressState = {
    ...previous,
    pending,
    settled,
    thresholdCohort,
    evidence,
    countedOperations: previous.countedOperations + 1,
    turnsSinceProgress: tick.turnsSinceProgress,
    progressResets: previous.progressResets + Number(progress),
    recentOperations: [
      ...previous.recentOperations,
      { toolCallId: id, kind: tool.kind, status, progress, reason },
    ].slice(-10),
  };

  return {
    state,
    tripped:
      tick.tripped &&
      (thresholdCohort?.size === 0 || tick.turnsSinceProgress >= maxTurns * 2),
  };
}

/** Close incomplete notifications at the prompt boundary without inventing work. */
export function finishProgressTurn(state: ProgressState): ProgressState {
  return {
    ...state,
    pending: new Map(),
    thresholdCohort: undefined,
    settled: new Set([...state.settled, ...state.pending.keys()]),
  };
}

export function progressDiagnostics(
  state: ProgressState,
  threshold: number,
  mode: NoProgressDiagnostics["progressMode"],
): NoProgressDiagnostics {
  return {
    threshold,
    countedOperations: state.countedOperations,
    turnsSinceProgress: state.turnsSinceProgress,
    progressResets: state.progressResets,
    pendingOperations: state.pending.size,
    ignoredUpdates: state.ignoredUpdates,
    progressMode: mode,
    stopReason: "no_progress",
    recentOperations: state.recentOperations,
  };
}
