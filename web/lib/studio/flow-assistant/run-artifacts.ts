import "server-only";

import path from "node:path";

import { runtimeRoot } from "@/lib/runtime-root";

export function localPackageRunDir(args: {
  localPackageSlug: string;
  runId: string;
}): string {
  return path.join(
    runtimeRoot(),
    ".maister",
    args.localPackageSlug,
    "runs",
    args.runId,
  );
}

export function flowAssistantActionLogPath(args: {
  localPackageSlug: string;
  runId: string;
}): string {
  return path.join(localPackageRunDir(args), "flow-assistant-actions.jsonl");
}
