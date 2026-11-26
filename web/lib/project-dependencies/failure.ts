import "server-only";

import { classifyGitError } from "@/lib/repo-source";

export function dependencyCloneFailure(error: unknown): string {
  if (!(error instanceof Error)) return "clone_failed";
  if (error.name === "AbortError" || error.name === "TimeoutError")
    return "source_unavailable";
  const stderr =
    "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  const reason = classifyGitError(stderr);

  if (reason === "NETWORK") return "source_unavailable";
  if (reason === "UNKNOWN") return "clone_failed";

  return "source_" + reason.toLowerCase();
}
