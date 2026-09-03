import type { Logger } from "pino";
import type { HostState } from "./host-state";
import type { PendingPermissionRegistry } from "./pending-permissions";
import type { RegistryEntry, SessionRegistry } from "./registry";
import type { CommandFence } from "./types";

import { pendingPermissions as defaultPendingPermissions } from "./pending-permissions";
import { SupervisorError } from "./types";

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
// that run under a LOWER epoch is evicted before the command executes. Legacy
// sessions (no epoch on the record) are never evicted by fence advancement.
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
    if (entry.record.status !== "live") return;
    if (entry.record.assignmentEpoch === undefined) return;
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
      "session-evicted-by-fence",
    );

    entry.record.fencedByEpoch = args.epoch;

    for (const requestId of pending.requestIds(sessionId)) {
      pending.cancel(sessionId, requestId, "fenced");
    }

    args.registry.markIntentionalShutdown(sessionId, "fenced");
    entry.child.kill("SIGTERM");

    const exited = await waitForChildExit(entry, args.killGraceMs);

    if (!exited) {
      args.logger.warn(
        { sessionId, killGraceMs: args.killGraceMs },
        "fence-eviction-sigterm-grace-expired-sigkill",
      );
      entry.child.kill("SIGKILL");
      await waitForChildExit(entry, args.killGraceMs);
    }
  }

  return victims.map((entry) => entry.record.sessionId);
}

function waitForChildExit(
  entry: RegistryEntry,
  timeoutMs: number,
): Promise<boolean> {
  if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolveP) => {
    const timer = setTimeout(() => resolveP(false), timeoutMs);

    entry.child.once("exit", () => {
      clearTimeout(timer);
      resolveP(true);
    });
  });
}
