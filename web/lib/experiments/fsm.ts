import type {
  ExperimentMemberRunProgress,
  ExperimentMemberRunStatus,
  ExperimentStatus,
} from "@/lib/experiments/types";

import { MaisterError } from "@/lib/errors-core";

const TERMINAL_EXPERIMENT_STATUSES = new Set<ExperimentStatus>([
  "concluded",
  "abandoned",
]);

const SETTLED_MEMBER_RUN_STATUSES = new Set<ExperimentMemberRunStatus>([
  "Review",
  "Crashed",
  "Done",
  "Abandoned",
  "Failed",
]);

const ALLOWED_TRANSITIONS = new Set<string>([
  "draft->running",
  "running->comparable",
  "comparable->running",
  "draft->abandoned",
  "running->abandoned",
  "comparable->abandoned",
  "comparable->concluded",
]);

export function isTerminalExperimentStatus(status: ExperimentStatus): boolean {
  return TERMINAL_EXPERIMENT_STATUSES.has(status);
}

export function isSettledExperimentMemberRun(
  status: ExperimentMemberRunStatus,
): boolean {
  return SETTLED_MEMBER_RUN_STATUSES.has(status);
}

export function isExperimentTransitionAllowed(
  fromStatus: ExperimentStatus,
  toStatus: ExperimentStatus,
): boolean {
  if (fromStatus === toStatus) return true;

  return ALLOWED_TRANSITIONS.has(`${fromStatus}->${toStatus}`);
}

export function assertExperimentTransition(
  fromStatus: ExperimentStatus,
  toStatus: ExperimentStatus,
): void {
  if (isExperimentTransitionAllowed(fromStatus, toStatus)) return;

  throw new MaisterError(
    "PRECONDITION",
    `invalid experiment status transition: ${fromStatus} -> ${toStatus}`,
    { details: { fromStatus, toStatus } },
  );
}

export function deriveExperimentProgressStatus(args: {
  currentStatus: ExperimentStatus;
  memberRuns: ExperimentMemberRunProgress[];
}): ExperimentStatus {
  if (isTerminalExperimentStatus(args.currentStatus)) {
    return args.currentStatus;
  }

  if (args.memberRuns.length === 0) {
    return args.currentStatus === "draft" ? "draft" : "running";
  }

  const representedVariants = new Set(
    args.memberRuns.map((run) => run.variantKey),
  );
  const allMembersSettled = args.memberRuns.every((run) =>
    isSettledExperimentMemberRun(run.status),
  );

  if (allMembersSettled && representedVariants.size >= 2) {
    return "comparable";
  }

  return "running";
}
