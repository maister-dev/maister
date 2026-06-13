import "server-only";

import type { FlowRequirement } from "@/lib/config.schema";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import pino from "pino";

import { MaisterError } from "@/lib/errors";

const execFileAsync = promisify(execFile);

const log = pino({
  name: "flow-requirements",
  level: process.env.LOG_LEVEL ?? "info",
});

// Bounded so a hanging probe (e.g. a network call) cannot wedge the launch
// path. Probes are meant to be fast presence/version checks.
const PROBE_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 1024 * 1024;

export type RequirementFailure = {
  name: string;
  reason: string;
  hint?: string;
};

/**
 * ADR-091. Run each flow `requirement` probe in `cwd` (the project repo) BEFORE
 * any worktree/session is created. A non-zero exit or a timeout marks the
 * requirement unmet; if any are unmet the launch is refused with a single
 * `PRECONDITION` listing every failure (+ its hint). Check-only — MAIster never
 * auto-installs (trust); the hint points to remediation.
 *
 * No-op (returns immediately) when `requirements` is absent/empty, so existing
 * flows are unaffected.
 */
export async function checkFlowRequirements(
  requirements: readonly FlowRequirement[] | undefined,
  cwd: string,
): Promise<void> {
  if (!requirements || requirements.length === 0) {
    return;
  }

  const failures: RequirementFailure[] = [];

  for (const req of requirements) {
    try {
      await execFileAsync("bash", ["-c", req.probe], {
        cwd,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        maxBuffer: MAX_BUFFER,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      const timedOut =
        e.name === "AbortError" || e.code === "ABORT_ERR" || e.killed === true;

      failures.push({
        name: req.name,
        reason: timedOut
          ? `probe timed out after ${PROBE_TIMEOUT_MS}ms`
          : "probe exited non-zero",
        ...(req.hint ? { hint: req.hint } : {}),
      });
    }
  }

  if (failures.length === 0) {
    return;
  }

  log.warn(
    { cwd, failures: failures.map((f) => f.name) },
    "flow requirements unmet — refusing launch",
  );

  const detail = failures
    .map((f) => `- ${f.name}: ${f.reason}${f.hint ? ` — ${f.hint}` : ""}`)
    .join("\n");

  throw new MaisterError(
    "PRECONDITION",
    `flow requirements not met:\n${detail}`,
  );
}
