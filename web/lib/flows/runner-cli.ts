import "server-only";

import type { FlowContext, StepResult } from "./types";
import type { FlowDriverClaim } from "./graph/driver-claim";

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import pino from "pino";

import { childProcessEnv } from "./child-env";
import { cliOutputFilePath } from "./graph/node-output";
import { FlowDriverClaimLost } from "./graph/driver-claim";
import { renderStrict } from "./templating";

const log = pino({
  name: "flow-runner",
  level: process.env.LOG_LEVEL ?? "info",
});

const DEFAULT_TIMEOUT_MS = 300_000;
// Host-wide ceiling for a node-declared `settings.timeoutMs` — one manifest
// must not be able to hold a run's slot open for hours. Requests above the
// ceiling clamp (warn-logged), they do not fail.
const DEFAULT_MAX_TIMEOUT_MS = 3_600_000;
// After the timeout SIGTERM, how long a trapped cleanup (e.g. a compose
// teardown) may run before the whole group is SIGKILLed.
const TIMEOUT_SIGKILL_GRACE_MS = 30_000;
const MAX_BUFFER = 4 * 1024 * 1024;
const COMMAND_PREVIEW_LEN = 200;

function maxTimeoutMs(): number {
  const raw = process.env.MAISTER_MAX_CLI_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_MAX_TIMEOUT_MS;

  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_TIMEOUT_MS;

  return parsed;
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;

  try {
    // `detached: true` made the child a group leader — the negative pid
    // signals the whole tree (bash plus its grandchildren).
    process.kill(-child.pid, signal);
  } catch (err) {
    // ESRCH: the group exited between the timer firing and the kill.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      log.warn(
        { pid: child.pid, signal, err: (err as Error).message },
        "process group kill failed",
      );
    }
  }
}

type DetachedExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  // Force-killed: our timeout fired or the output cap was exceeded.
  aborted: boolean;
};

// `execFile` cannot create a process group (it forwards an explicit option
// allowlist to `spawn` that drops `detached`), so the command is spawned by
// hand: detached group leader, SIGTERM on timeout with a SIGKILL escalation
// after the trap grace, and a final group sweep once bash itself exits.
function execDetachedGroup(opts: {
  command: string;
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<DetachedExecResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", opts.command], {
      cwd: opts.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    });

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdoutText = "";
    let stderrText = "";
    let bufferedBytes = 0;
    let timedOut = false;
    let overflowed = false;
    let driverAborted = false;
    let spawnError: Error | undefined;
    let escalation: NodeJS.Timeout | undefined;

    const collect =
      (decoder: StringDecoder, append: (s: string) => void) =>
      (chunk: Buffer) => {
        bufferedBytes += chunk.length;

        if (bufferedBytes > MAX_BUFFER) {
          if (!overflowed) {
            overflowed = true;
            killProcessGroup(child, "SIGKILL");
          }

          return;
        }

        append(decoder.write(chunk));
      };

    child.stdout?.on(
      "data",
      collect(stdoutDecoder, (s) => {
        stdoutText += s;
      }),
    );
    child.stderr?.on(
      "data",
      collect(stderrDecoder, (s) => {
        stderrText += s;
      }),
    );

    const killTimer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, "SIGTERM");
      escalation = setTimeout(
        () => killProcessGroup(child, "SIGKILL"),
        TIMEOUT_SIGKILL_GRACE_MS,
      );
    }, opts.timeoutMs);

    const onDriverAbort = (): void => {
      driverAborted = true;
      clearTimeout(killTimer);
      if (escalation !== undefined) clearTimeout(escalation);
      // Lost ownership cannot grant a grace period for further side effects.
      killProcessGroup(child, "SIGKILL");
    };

    opts.signal?.addEventListener("abort", onDriverAbort, { once: true });
    if (opts.signal?.aborted) onDriverAbort();

    child.on("error", (err) => {
      spawnError = err;
    });

    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onDriverAbort);
      clearTimeout(killTimer);
      if (escalation !== undefined) clearTimeout(escalation);
      // A timed-out group may still hold members that ignored the TERM or
      // that bash orphaned by exiting first — sweep them before reporting.
      if (timedOut || driverAborted) killProcessGroup(child, "SIGKILL");

      const aborted = timedOut || overflowed || driverAborted;

      stdoutText += stdoutDecoder.end();
      stderrText += stderrDecoder.end();

      resolve({
        stdout: stdoutText,
        stderr:
          stderrText === "" && spawnError !== undefined
            ? spawnError.message
            : stderrText,
        exitCode: aborted ? -1 : (code ?? -1),
        aborted,
      });
    });
  });
}

export type CliStepLike = {
  id: string;
  type: "cli";
  command: string;
};

export type RunCliStepCtx = {
  runtimeRoot: string;
  projectSlug: string;
  runId: string;
  stepId: string;
  worktreePath: string;
  context: FlowContext;
  timeoutMs?: number;
  driver?: Readonly<{ claim: FlowDriverClaim; signal: AbortSignal }>;
  // M26 P1 (ADR-063): set only when the node declares `output.result` — arms
  // the MAISTER_OUTPUT_FILE transport with the per-attempt filename. Absent =
  // no transport provisioning (no MAISTER_OUTPUT_FILE in the child env).
  attempt?: number;
  // ADR-154: set only by NODE-ACTION dispatch (executeNodeAction) — injects
  // MAISTER_FLOW_DIR (the SHA-pinned installed-revision dir) so a package can
  // execute the script files it ships. Gates (gates-exec) and requirement
  // probes never set it: scope v1 is node actions only.
  flowInstallPath?: string;
};

function previewCommand(s: string): string {
  if (s.length <= COMMAND_PREVIEW_LEN) return s;

  return `${s.slice(0, COMMAND_PREVIEW_LEN)}…`;
}

function assertCliDriver(ctx: RunCliStepCtx): void {
  if (!ctx.driver?.signal.aborted) return;
  log.warn(
    {
      runId: ctx.runId,
      stepId: ctx.stepId,
      assignmentId: ctx.driver.claim.assignmentId,
    },
    "cli driver yielded after cancellation",
  );
  throw new FlowDriverClaimLost(ctx.driver.claim);
}

export async function runCliStep(
  step: CliStepLike,
  ctx: RunCliStepCtx,
): Promise<StepResult> {
  assertCliDriver(ctx);
  const requestedTimeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(requestedTimeoutMs, maxTimeoutMs());

  if (timeoutMs < requestedTimeoutMs) {
    log.warn(
      { runId: ctx.runId, stepId: ctx.stepId, requestedTimeoutMs, timeoutMs },
      "cli timeout clamped to the MAISTER_MAX_CLI_TIMEOUT_MS ceiling",
    );
  }

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

  let outputFile: string | undefined;

  if (ctx.attempt !== undefined) {
    try {
      outputFile = cliOutputFilePath({
        runtimeRoot: ctx.runtimeRoot,
        projectSlug: ctx.projectSlug,
        runId: ctx.runId,
        nodeId: ctx.stepId,
        attempt: ctx.attempt,
      });
    } catch (err) {
      // Invalid node id segment: do not arm the transport — the validate seam
      // fails the attempt with CONFIG after the action.
      log.warn(
        { nodeId: ctx.stepId, err: (err as Error).message },
        "cli output transport NOT armed — invalid node id",
      );
    }
  }

  if (outputFile !== undefined) {
    await mkdir(path.dirname(outputFile), { recursive: true });
    log.debug(
      { nodeId: ctx.stepId, attempt: ctx.attempt, outputFile },
      "cli output transport armed",
    );
  }

  const startedAt = Date.now();

  // Per-step transport vars, single-sourced: MAISTER_OUTPUT_FILE (ADR-063,
  // armed per-attempt) + MAISTER_FLOW_DIR (ADR-154, node actions only).
  const extraEnv: Record<string, string> = {
    ...(outputFile !== undefined ? { MAISTER_OUTPUT_FILE: outputFile } : {}),
    ...(ctx.flowInstallPath !== undefined
      ? { MAISTER_FLOW_DIR: ctx.flowInstallPath }
      : {}),
  };

  assertCliDriver(ctx);
  const { stdout, stderr, exitCode, aborted } = await execDetachedGroup({
    command: resolved,
    cwd: ctx.worktreePath,
    timeoutMs,
    signal: ctx.driver?.signal,
    // ADR-153: allow-listed env only — flow commands never see web-tier
    // secrets. Serves cli/check nodes AND command_check gates (gates-exec).
    env: childProcessEnv(
      Object.keys(extraEnv).length > 0 ? extraEnv : undefined,
    ),
  });

  assertCliDriver(ctx);

  const durationMs = Date.now() - startedAt;
  const ok = !aborted && exitCode === 0;

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
