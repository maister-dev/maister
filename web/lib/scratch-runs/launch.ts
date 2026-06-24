import "server-only";

import type { PromptPolicy } from "@/lib/scratch-runs/types";
import type {
  ScratchPlanMode,
  ScratchReasoningEffort,
  ScratchWorkMode,
} from "@/lib/db/schema";

export function scratchNameFallback(prompt: string): string {
  const firstLine = prompt.trim().split("\n")[0]?.trim() ?? "";
  const compact = firstLine.replace(/\s+/g, " ");

  return compact.length > 0 ? compact.slice(0, 80) : "Scratch workspace";
}

export function deriveScratchBranchName(args: {
  branchPrefix: string;
  projectSlug: string;
  requestedName?: string;
  runId: string;
}): string {
  const source = args.requestedName?.trim() || args.runId;
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  const suffix = slug.length > 0 ? slug : args.runId.slice(0, 8);

  return `${args.branchPrefix}${args.projectSlug}/scratch/${suffix}`;
}

export function workModeToPlanMode(workMode: ScratchWorkMode): ScratchPlanMode {
  return workMode === "plan_first" ? "plan-first" : "off";
}

export function planModeToWorkMode(planMode: ScratchPlanMode): ScratchWorkMode {
  return planMode === "plan-first" ? "plan_first" : "auto";
}

function workModeInstruction(workMode: ScratchWorkMode): string | null {
  if (workMode === "plan_first") {
    return "Start in plan-first mode. Inspect the workspace, write a concise plan, and wait for operator confirmation before code edits.";
  }
  if (workMode === "manual_approval") {
    return "Manual approval policy: ask the operator before making code edits or running potentially destructive commands.";
  }

  return null;
}

function reasoningInstruction(
  reasoningEffort: ScratchReasoningEffort,
): string | null {
  if (reasoningEffort === "high") return null;

  return `Reasoning effort policy: ${reasoningEffort}. Treat this as run guidance unless the selected ACP runner enforces it natively.`;
}

const explicitCommandPrefixPattern =
  /^(?:@(skill|agent):[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?|\/[A-Za-z0-9][A-Za-z0-9._:-]*|\$[A-Za-z0-9][A-Za-z0-9._:-]*)(?:\s|$)/;

function startsWithExplicitCommand(prompt: string): boolean {
  return explicitCommandPrefixPattern.test(prompt.trimStart());
}

export function decoratePromptForPlanMode(args: PromptPolicy): string {
  const workMode = args.workMode ?? planModeToWorkMode(args.planMode);
  const reasoningEffort = args.reasoningEffort ?? "high";
  const instruction = workModeInstruction(workMode);
  const policyLines = [
    instruction,
    reasoningInstruction(reasoningEffort),
  ].filter((line): line is string => line !== null);

  if (policyLines.length === 0 && args.planMode === "off") return args.prompt;
  if (startsWithExplicitCommand(args.prompt)) {
    return [args.prompt.trimStart(), "", ...policyLines].join("\n");
  }

  return [...policyLines, "", args.prompt].join("\n");
}

export function scratchStepId(): string {
  return "dialog";
}
