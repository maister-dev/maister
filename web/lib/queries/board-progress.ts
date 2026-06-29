import type { FlowYamlV1 } from "@/lib/config.schema";
import type { NodeAttempt, RunStatus, StepRun } from "@/lib/db/schema";
import type {
  ActiveNodeState,
  ActiveNodeStatus,
  SpineSegment,
} from "@/lib/queries/board";

import { compileManifest } from "@/lib/flows/graph/compile";

const LEGACY_SPINE_LENGTH = 7;

export type ProgressNodeAttempt = Pick<
  NodeAttempt,
  "attempt" | "nodeId" | "startedAt" | "status"
>;

export type ProgressStepRun = Pick<StepRun, "startedAt" | "status" | "stepId">;

export interface FlightProgressInput {
  currentStepId: string | null;
  manifest: unknown;
  nodeAttempts: ProgressNodeAttempt[];
  runStatus: RunStatus;
  stepRuns: ProgressStepRun[];
}

export interface FlightProgress {
  activeNode: ActiveNodeStatus | null;
  spine: SpineSegment[];
  stepLabel: string;
}

function hasRunnableManifest(manifest: unknown): manifest is FlowYamlV1 {
  if (typeof manifest !== "object" || manifest === null) return false;

  const candidate = manifest as { nodes?: unknown; steps?: unknown };

  return (
    (Array.isArray(candidate.nodes) && candidate.nodes.length > 0) ||
    (Array.isArray(candidate.steps) && candidate.steps.length > 0)
  );
}

function isLaterAttempt(
  candidate: ProgressNodeAttempt,
  current: ProgressNodeAttempt,
): boolean {
  if (candidate.attempt !== current.attempt) {
    return candidate.attempt > current.attempt;
  }

  return candidate.startedAt.getTime() > current.startedAt.getTime();
}

function latestAttemptByNode(
  attempts: ProgressNodeAttempt[],
): Map<string, ProgressNodeAttempt> {
  const latest = new Map<string, ProgressNodeAttempt>();

  for (const attempt of attempts) {
    const current = latest.get(attempt.nodeId);

    if (!current || isLaterAttempt(attempt, current)) {
      latest.set(attempt.nodeId, attempt);
    }
  }

  return latest;
}

function latestAttemptWithStatus(
  attempts: ProgressNodeAttempt[],
  statuses: readonly ProgressNodeAttempt["status"][],
): ProgressNodeAttempt | null {
  const eligible = attempts.filter((attempt) =>
    statuses.includes(attempt.status),
  );

  return eligible.reduce<ProgressNodeAttempt | null>(
    (latest, attempt) =>
      latest === null || isLaterAttempt(attempt, latest) ? attempt : latest,
    null,
  );
}

function activeStateFor(
  runStatus: RunStatus,
  attemptStatus?: ProgressNodeAttempt["status"],
): ActiveNodeState | null {
  if (runStatus === "WaitingOnChildren") return "waiting";
  if (attemptStatus === "Failed" || runStatus === "Crashed") return "failed";
  if (
    attemptStatus === "NeedsInput" ||
    runStatus === "NeedsInput" ||
    runStatus === "NeedsInputIdle"
  ) {
    return "needs";
  }
  if (
    attemptStatus === "Running" ||
    runStatus === "Running" ||
    runStatus === "HumanWorking"
  ) {
    return "running";
  }

  return null;
}

function inferredActiveNodeId(input: FlightProgressInput): string | null {
  if (input.currentStepId) return input.currentStepId;

  if (input.runStatus === "Crashed" || input.runStatus === "Failed") {
    return (
      latestAttemptWithStatus(input.nodeAttempts, ["Failed"])?.nodeId ?? null
    );
  }

  if (
    input.runStatus === "NeedsInput" ||
    input.runStatus === "NeedsInputIdle"
  ) {
    return (
      latestAttemptWithStatus(input.nodeAttempts, ["NeedsInput"])?.nodeId ??
      null
    );
  }

  if (input.runStatus === "Running" || input.runStatus === "HumanWorking") {
    return (
      latestAttemptWithStatus(input.nodeAttempts, ["Running"])?.nodeId ?? null
    );
  }

  return null;
}

function activeNodeStatus(
  input: FlightProgressInput,
  latestByNode: Map<string, ProgressNodeAttempt>,
): ActiveNodeStatus | null {
  const nodeId = inferredActiveNodeId(input);

  if (nodeId === null) return null;

  const state = activeStateFor(
    input.runStatus,
    latestByNode.get(nodeId)?.status,
  );

  if (state === null) return null;

  return { label: nodeId, state };
}

function nodeAttemptDone(status?: ProgressNodeAttempt["status"]): boolean {
  return status === "Succeeded" || status === "Reworked";
}

function graphSpine(input: FlightProgressInput): FlightProgress | null {
  if (!hasRunnableManifest(input.manifest)) return null;

  const graph = compileManifest(input.manifest);
  const latestByNode = latestAttemptByNode(input.nodeAttempts);
  const activeNode = activeNodeStatus(input, latestByNode);
  const nodeIds = graph.order.slice(0, LEGACY_SPINE_LENGTH);
  const spine = nodeIds.map<SpineSegment>((nodeId) => {
    const latest = latestByNode.get(nodeId);

    if (activeNode?.label === nodeId) {
      return { state: "active", tone: activeNode.state };
    }

    if (nodeAttemptDone(latest?.status)) return { state: "done" };

    return { state: "todo" };
  });

  return {
    activeNode,
    spine,
    stepLabel:
      activeNode?.label ?? input.currentStepId ?? input.runStatus.toLowerCase(),
  };
}

function stepRunTone(status: ProgressStepRun["status"]): ActiveNodeState {
  return status === "NeedsInput" ? "needs" : "running";
}

function legacyStepSegment(step: ProgressStepRun): SpineSegment {
  if (step.status === "Succeeded") return { state: "done" };
  if (step.status === "Skipped") return { state: "skip" };
  if (step.status === "Running" || step.status === "NeedsInput") {
    return { state: "active", tone: stepRunTone(step.status) };
  }

  return { state: "todo" };
}

function legacyActiveNode(
  input: FlightProgressInput,
  ordered: ProgressStepRun[],
): ActiveNodeStatus | null {
  const activeStep = ordered.find(
    (step) => step.status === "Running" || step.status === "NeedsInput",
  );

  if (!activeStep) return null;

  return {
    label: activeStep.stepId,
    state: stepRunTone(activeStep.status),
  };
}

function legacyStepProgress(input: FlightProgressInput): FlightProgress {
  const ordered = [...input.stepRuns].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
  );
  const activeNode = legacyActiveNode(input, ordered);
  const spine = ordered
    .slice(0, LEGACY_SPINE_LENGTH)
    .map((step) => legacyStepSegment(step));

  while (spine.length < LEGACY_SPINE_LENGTH) {
    spine.push({ state: "todo" });
  }

  return {
    activeNode,
    spine,
    stepLabel:
      activeNode?.label ?? input.currentStepId ?? input.runStatus.toLowerCase(),
  };
}

export function buildFlightProgress(
  input: FlightProgressInput,
): FlightProgress {
  return graphSpine(input) ?? legacyStepProgress(input);
}
