import "server-only";

import type { FlowContext, StepResult } from "./types";
import type { GuardConfig } from "./guards";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import pino from "pino";

import { appendGuardMetric, evaluateGuards } from "./guards";
import { renderStrict } from "./templating";

const execFileAsync = promisify(execFile);

const log = pino({
  name: "flow-runner",
  level: process.env.LOG_LEVEL ?? "info",
});

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_BUFFER = 4 * 1024 * 1024;
const COMMAND_PREVIEW_LEN = 200;

export type CliStepLike = {
  id: string;
  type: "cli";
  command: string;
  pre_guards?: GuardConfig[];
  post_guards?: GuardConfig[];
};

export type RunCliStepCtx = {
  runtimeRoot: string;
  projectSlug: string;
  runId: string;
  stepId: string;
  worktreePath: string;
  context: FlowContext;
  timeoutMs?: number;
};

function previewCommand(s: string): string {
  if (s.length <= COMMAND_PREVIEW_LEN) return s;

  return `${s.slice(0, COMMAND_PREVIEW_LEN)}…`;
}

export async function runCliStep(
  step: CliStepLike,
  ctx: RunCliStepCtx,
): Promise<StepResult> {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const resolved = renderStrict(
    step.command,
    ctx.context as unknown as Record<string, unknown>,
    { traceLog: log },
  );

  log.info(
    {
      runId: ctx.runId,
      stepId: ctx.stepId,
      cwd: ctx.worktreePath,
      command: previewCommand(resolved),
      timeoutMs,
    },
    "cli step start",
  );

  await appendGuardMetric({
    runtimeRoot: ctx.runtimeRoot,
    projectSlug: ctx.projectSlug,
    runId: ctx.runId,
    stepId: ctx.stepId,
    kind: "pre",
    metrics: evaluateGuards(step.pre_guards, {
      durationMs: 0,
      stdout: "",
      costTokens: 0,
    }),
  });

  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let aborted = false;

  try {
    const result = await execFileAsync("bash", ["-c", resolved], {
      cwd: ctx.worktreePath,
      signal: AbortSignal.timeout(timeoutMs),
      maxBuffer: MAX_BUFFER,
    });

    stdout = String(result.stdout ?? "");
    stderr = String(result.stderr ?? "");
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | string;
      killed?: boolean;
    };

    stdout = String(e.stdout ?? "");
    stderr = String(e.stderr ?? e.message ?? "");

    if (e.name === "AbortError" || e.code === "ABORT_ERR" || e.killed) {
      aborted = true;
      exitCode = -1;
    } else if (typeof e.code === "number") {
      exitCode = e.code;
    } else {
      exitCode = -1;
    }
  }

  const durationMs = Date.now() - startedAt;
  const ok = !aborted && exitCode === 0;

  await appendGuardMetric({
    runtimeRoot: ctx.runtimeRoot,
    projectSlug: ctx.projectSlug,
    runId: ctx.runId,
    stepId: ctx.stepId,
    kind: "post",
    metrics: evaluateGuards(step.post_guards, {
      durationMs,
      stdout,
      costTokens: 0,
    }),
  });

  log.info(
    {
      runId: ctx.runId,
      stepId: ctx.stepId,
      ok,
      exitCode,
      durationMs,
      aborted,
    },
    "cli step end",
  );

  return {
    ok,
    stdout,
    stderr,
    exitCode,
    durationMs,
    errorCode: ok ? undefined : "PRECONDITION",
    vars: {},
  };
}
