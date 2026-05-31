import "server-only";

import type { PromptPolicy } from "@/lib/scratch-runs/types";

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

export function decoratePromptForPlanMode(args: PromptPolicy): string {
  if (args.planMode === "off") return args.prompt;

  return [
    "Start in plan-first mode. Inspect the workspace, write a concise plan, and wait for operator confirmation before code edits.",
    "",
    args.prompt,
  ].join("\n");
}

export function scratchStepId(): string {
  return "dialog";
}
