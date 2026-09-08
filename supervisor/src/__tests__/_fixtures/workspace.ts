// ADR-166: spawn-level unit tests feed `spawnSession` a resolved workspace
// without booting the HTTP host. This is the test-side statement of the run-dir
// layout the host derives from an adopted handle
// (`<runtimeRoot>/.maister/<slug>/runs/<runId>/`).
import type { ContextMount } from "../../types";
import type { WorkspaceResolution } from "../../workspace-registry";

import { join, resolve } from "node:path";

export const HANDLE = "ws_5f3a8a2b7e344f6d9d2c1d4e5f6a7b8c";

export function directoryWorkspace(opts: {
  runtimeRoot: string;
  cwd: string;
  runId?: string;
  projectSlug?: string;
  stepId?: string;
  repoPath?: string;
  confineRoot?: string;
  contextMounts?: ContextMount[];
}): WorkspaceResolution {
  const runId = opts.runId ?? "run-1";
  const projectSlug = opts.projectSlug ?? "demo";
  const stepId = opts.stepId ?? "step-1";
  const runDir = resolve(
    opts.runtimeRoot,
    ".maister",
    projectSlug,
    "runs",
    runId,
  );

  return {
    executionWorkspaceId: HANDLE,
    runId,
    projectSlug,
    cwd: opts.cwd,
    repoPath: opts.repoPath,
    confineRoot: opts.confineRoot,
    runDir,
    logPath: join(runDir, `${stepId}.log`),
    contextMounts: opts.contextMounts,
  };
}
