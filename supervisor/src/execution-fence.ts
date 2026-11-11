import type { Logger } from "pino";
import type { HostState } from "./host-state";
import type { PendingPermissionRegistry } from "./pending-permissions";
import type { RegistryEntry, SessionRegistry } from "./registry";
import type { CommandFence, SupervisorErrorDetails } from "./types";
import type { SessionRecord } from "./types";
import type { ChildProcess } from "node:child_process";
import type { ProcessGroupObservation } from "../../runtime/process-group";

import { setTimeout as delay } from "node:timers/promises";

import { inspectProcessGroup } from "../../runtime/process-group";
import { safeErrorCauseChain } from "../../runtime/safe-error-cause";

import { pendingPermissions as defaultPendingPermissions } from "./pending-permissions";
import { isSupervisorError, SupervisorError } from "./types";
import { readHostProcessContext } from "./session-process-context";

// ADR-166 D3: fence enforcement at the execution boundary. Rules run in order —
// host key, run binding, epoch high-water, assignment identity — and the
// high-water is persisted BEFORE the command executes, so it survives a
// restart.

export type FenceOutcome = {
  advanced: boolean;
  previousEpoch: number | null;
};

export function applyFence(args: {
  state: HostState;
  fence: CommandFence;
  expectedRunId?: string;
  logger: Logger;
}): FenceOutcome {
  const { state, fence, logger } = args;

  if (fence.hostKey !== state.hostKey) {
    throw new SupervisorError(
      "PRECONDITION",
      "command fence names a different execution host",
      { details: { reason: "host_mismatch", runId: fence.runId } },
    );
  }

  if (args.expectedRunId !== undefined && fence.runId !== args.expectedRunId) {
    throw new SupervisorError(
      "PRECONDITION",
      "command fence names a different run than the target",
      { details: { reason: "run_mismatch", runId: fence.runId } },
    );
  }

  const stored = state.getFence(fence.runId);

  logger.debug(
    {
      runId: fence.runId,
      commandEpoch: fence.assignmentEpoch,
      hostEpoch: stored?.epoch ?? null,
      assignmentId: fence.assignmentId,
    },
    "fence-compare",
  );

  if (stored && fence.assignmentEpoch < stored.epoch) {
    throw new SupervisorError(
      "FENCED",
      `command epoch ${fence.assignmentEpoch} is below the host high-water ${stored.epoch} for run ${fence.runId}`,
      {
        details: {
          reason: "assignment_fenced",
          runId: fence.runId,
          commandEpoch: fence.assignmentEpoch,
          hostEpoch: stored.epoch,
        },
      },
    );
  }

  if (
    stored &&
    fence.assignmentEpoch === stored.epoch &&
    fence.assignmentId !== stored.assignmentId
  ) {
    throw new SupervisorError(
      "PRECONDITION",
      `command names assignment ${fence.assignmentId} but the host high-water epoch ${stored.epoch} belongs to ${stored.assignmentId}`,
      {
        details: {
          reason: "assignment_mismatch",
          runId: fence.runId,
          commandEpoch: fence.assignmentEpoch,
          hostEpoch: stored.epoch,
        },
      },
    );
  }

  if (!stored || fence.assignmentEpoch > stored.epoch) {
    state.setFence(fence.runId, fence.assignmentId, fence.assignmentEpoch);

    return { advanced: true, previousEpoch: stored?.epoch ?? null };
  }

  return { advanced: false, previousEpoch: stored.epoch };
}

// ADR-166 D3 / E-EH-04: when a higher epoch arrives, every live session of
// that run under a LOWER epoch is evicted before the command executes.
export async function evictLowerEpochSessions(args: {
  registry: SessionRegistry;
  runId: string;
  epoch: number;
  killGraceMs: number;
  logger: Logger;
  pendingPermissions?: PendingPermissionRegistry;
}): Promise<string[]> {
  const pending = args.pendingPermissions ?? defaultPendingPermissions;
  const victims: RegistryEntry[] = [];

  args.registry.forEach((entry) => {
    if (entry.record.runId !== args.runId) return;
    if (
      entry.record.status !== "live" &&
      (entry.child.exitCode !== null || entry.child.signalCode !== null) &&
      entry.record.terminalPublished
    )
      return;
    if (entry.record.assignmentEpoch >= args.epoch) return;

    victims.push(entry);
  });

  for (const entry of victims) {
    const sessionId = entry.record.sessionId;

    args.logger.info(
      {
        sessionId,
        runId: args.runId,
        sessionEpoch: entry.record.assignmentEpoch,
        commandEpoch: args.epoch,
      },
      "session-fence-eviction-started",
    );

    entry.record.fencedByEpoch = args.epoch;

    for (const requestId of pending.requestIds(sessionId)) {
      pending.cancel(sessionId, requestId, "fenced");
    }

    args.registry.markIntentionalShutdown(sessionId, "fenced");
    const termination = await terminateSessionProcess(
      entry,
      args.killGraceMs,
      args.logger,
    );

    if (termination !== "confirmed") {
      throw new SupervisorError(
        "EXECUTOR_UNAVAILABLE",
        "The previous assignment still has unconfirmed process retirement; reconcile its host session before dispatching the current epoch",
        {
          details: {
            reason: "session_eviction_exit_unconfirmed",
            runId: args.runId,
            sessionId,
            commandEpoch: args.epoch,
            stage: termination,
            killGraceMs: args.killGraceMs,
          },
        },
      );
    }
    args.logger.info(
      { sessionId, runId: args.runId, commandEpoch: args.epoch },
      "session-evicted-by-fence",
    );
  }

  return victims.map((entry) => entry.record.sessionId);
}

export function waitForChildExit(
  entry: RegistryEntry,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolveP) => {
    const finish = (exited: boolean): void => {
      clearTimeout(timer);
      entry.child.off("exit", onExit);
      resolveP(exited);
    };
    const onExit = (): void => {
      void Promise.resolve(entry.record.outputTerminal).then(
        () => finish(true),
        () => finish(false),
      );
    };
    const timer = setTimeout(() => finish(false), timeoutMs);

    if (entry.child.exitCode !== null || entry.child.signalCode !== null)
      onExit();
    else entry.child.once("exit", onExit);
  });
}

/** Only this live native child authorizes signalling its captured group; recovered group IDs never do. */
export function signalOwnedSessionProcess(
  owner: Readonly<{ child: ChildProcess; record: SessionRecord }>,
  signal: "SIGTERM" | "SIGKILL",
): void {
  if (owner.child.exitCode !== null || owner.child.signalCode !== null) return;
  const group = owner.record.processGroup;

  if (!group) {
    owner.child.kill(signal);

    return;
  }
  const context = readHostProcessContext();

  if (
    owner.child.pid !== group ||
    !owner.record.processContext ||
    owner.record.processContext.osBootIdentity !== context.osBootIdentity ||
    owner.record.processContext.pidNamespace !== context.pidNamespace
  ) {
    throw new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      "The live session's physical owner cannot be verified; no process group was signalled",
      {
        details: {
          reason: "process_identity_unavailable",
          runId: owner.record.runId,
          sessionId: owner.record.sessionId,
        },
      },
    );
  }
  try {
    process.kill(-group, signal);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH")
      throw new SupervisorError(
        "EXECUTOR_UNAVAILABLE",
        "The owned session group could not be signalled; retain its workspace for reconciliation",
        {
          cause,
          details: {
            reason: "session_process_owner_unconfirmed",
            runId: owner.record.runId,
            sessionId: owner.record.sessionId,
            processGroup: group,
          },
        },
      );
  }
}

/** Signal delivery is not retirement: confirm both process exit and its terminal output. */
export async function terminateSessionProcess(
  entry: RegistryEntry,
  killGraceMs: number,
  logger: Logger,
): Promise<"confirmed" | NonNullable<SupervisorErrorDetails["stage"]>> {
  const termDeadline = performance.now() + killGraceMs;

  if (entry.child.exitCode === null && entry.child.signalCode === null)
    entry.record.stopOutputForTeardown?.();
  else entry.record.drainSessionOutput?.();
  requestOwnedSessionTermination(entry, "SIGTERM", logger);
  if (
    await waitForChildExit(entry, Math.max(0, termDeadline - performance.now()))
  )
    return waitForOwnedSessionProcessGroup(entry, termDeadline, logger);
  logger.warn(
    { sessionId: entry.record.sessionId, killGraceMs },
    "sigterm-grace-expired-sigkill",
  );
  requestOwnedSessionTermination(entry, "SIGKILL", logger);
  const killDeadline = performance.now() + killGraceMs;

  if (await waitForChildExit(entry, killGraceMs)) {
    return waitForOwnedSessionProcessGroup(entry, killDeadline, logger);
  }

  return entry.child.exitCode !== null || entry.child.signalCode !== null
    ? "terminal_output"
    : "process_exit";
}

/** A local exit cannot prove group retirement in a different OS boot or PID namespace. */
export async function ownedSessionProcessGroupRetired(
  owner: Readonly<{ child: ChildProcess; record: SessionRecord }>,
): Promise<boolean> {
  if (owner.child.exitCode === null && owner.child.signalCode === null)
    return false;

  return (
    (await observeOwnedSessionProcessGroup(owner, 5_000)).state === "retired"
  );
}

async function observeOwnedSessionProcessGroup(
  owner: Readonly<{ record: SessionRecord }>,
  timeoutMs: number,
): Promise<ProcessGroupObservation> {
  if (!owner.record.processGroup) return { state: "retired" };
  const context = readHostProcessContext();

  if (
    !owner.record.processContext ||
    owner.record.processContext.osBootIdentity !== context.osBootIdentity ||
    owner.record.processContext.pidNamespace !== context.pidNamespace
  )
    return { state: "unavailable" };

  return inspectProcessGroup(owner.record.processGroup, timeoutMs);
}

/** The leader's exit is only the start of descendant retirement. Retry the
 * OS proof within the remaining grace, without signalling a now-unowned PGID. */
async function waitForOwnedSessionProcessGroup(
  entry: RegistryEntry,
  deadline: number,
  logger: Logger,
): Promise<"confirmed" | "process_group_active" | "process_group_unavailable"> {
  let observation: ProcessGroupObservation = { state: "unavailable" };

  while (performance.now() < deadline) {
    observation = await observeOwnedSessionProcessGroup(
      entry,
      Math.max(1, Math.ceil(deadline - performance.now())),
    );

    if (observation.state === "retired") return "confirmed";
    const remainingMs = deadline - performance.now();

    if (remainingMs <= 25) {
      if (remainingMs > 0) await delay(Math.ceil(remainingMs));
      break;
    }
    await delay(25);
  }
  // The group can disappear during the final delay or while a probe uses
  // the remaining budget. Recheck absence without launching another process.
  if ((await observeOwnedSessionProcessGroup(entry, 0)).state === "retired")
    return "confirmed";
  logger.warn(
    {
      runId: entry.record.runId,
      sessionId: entry.record.sessionId,
      processGroup: entry.record.processGroup,
      observation,
      exitCode: entry.child.exitCode,
      signalCode: entry.child.signalCode,
    },
    "session-process-group-retirement-unconfirmed",
  );

  return observation.state === "active"
    ? "process_group_active"
    : "process_group_unavailable";
}

/** Darwin may refuse signals to an already-exiting owned group; only the subsequent positive lifetime proof can settle it. */
export function requestOwnedSessionTermination(
  entry: Readonly<{ child: ChildProcess; record: SessionRecord }>,
  signal: "SIGTERM" | "SIGKILL",
  logger: Logger,
): SupervisorError | null {
  try {
    signalOwnedSessionProcess(entry, signal);

    return null;
  } catch (error) {
    if (
      !isSupervisorError(error) ||
      error.code !== "EXECUTOR_UNAVAILABLE" ||
      ![
        "session_process_owner_unconfirmed",
        "process_identity_unavailable",
      ].includes(error.details?.reason ?? "")
    )
      throw error;
    logger.warn(
      {
        runId: entry.record.runId,
        assignmentId: entry.record.assignmentId,
        assignmentEpoch: entry.record.assignmentEpoch,
        sessionId: entry.record.sessionId,
        processGroup: entry.record.processGroup,
        signal,
        causeChain: safeErrorCauseChain(error),
      },
      "owned-session-signal-unconfirmed-awaiting-lifetime-proof",
    );

    return error;
  }
}
