import type { ChildProcess } from "node:child_process";
import type { HostState, SessionProcessObligation } from "./host-state";
import type { SessionRegistry } from "./registry";
import type { SessionRecord } from "./types";

import { fileURLToPath } from "node:url";

import { z } from "zod";

import { inspectProcessGroup } from "../../runtime/process-group";

import { waitForChildExit } from "./execution-fence";
import {
  readHostProcessContext,
  type HostProcessContext,
} from "./session-process-context";
import { SupervisorError } from "./types";

export const SESSION_PROCESS_GATE_PATH = fileURLToPath(
  new URL("./session-process-gate.mjs", import.meta.url),
);
const SAFE_CAUSE_TOKEN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const gateFailureSchema = z
  .object({
    version: z.literal(1),
    stage: z.literal("spawn"),
    causeChain: z
      .array(
        z
          .object({
            name: z.string().regex(SAFE_CAUSE_TOKEN),
            code: z
              .union([
                z.number().int().safe(),
                z
                  .string()
                  .regex(/^(?:[A-Za-z_][A-Za-z0-9_]{0,63}|[0-9A-Z]{5})$/),
              ])
              .optional(),
            syscall: z.string().regex(SAFE_CAUSE_TOKEN).optional(),
            signal: z.string().regex(SAFE_CAUSE_TOKEN).optional(),
          })
          .strict(),
      )
      .max(4),
  })
  .strict();

/** Trusted bootstrap cannot execute adapter-supplied Node preload hooks before registration. */
export function sessionGateEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "TZ",
      "MAISTER_TEST_WORKTREE_INVOCATION_ID",
      "MAISTER_TEST_PROCESS_LEDGER",
      "MAISTER_TEST_PROCESS_OWNER",
      "MAISTER_TEST_PROCESS_PARENT",
    ].flatMap((key) =>
      typeof process.env[key] === "string" ? [[key, process.env[key]]] : [],
    ),
  );
}

/** Register the exact native group durably before the gate may become an adapter. */
export function startGatedSessionProcess(
  input: Readonly<{
    child: ChildProcess;
    record: SessionRecord;
    state: HostState;
    registry: SessionRegistry;
    binary: string;
    arguments: readonly string[];
    environment: NodeJS.ProcessEnv;
  }>,
): Promise<void> {
  const { child, record, state, registry } = input;

  if (!child.pid || record.processGroup !== child.pid)
    throw new SupervisorError(
      "SPAWN",
      "The session gate has no registered native process group",
    );
  state.registerSessionProcess({
    commandId: record.createdByCommandId,
    runId: record.runId,
    assignmentId: record.assignmentId,
    epoch: record.assignmentEpoch,
    hostSessionId: record.sessionId,
    processGroup: child.pid,
  });

  return new Promise<void>((resolve, reject) => {
    let authorized = false;
    const finish = (error?: unknown): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("disconnect", onDisconnect);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onDisconnect = (): void =>
      finish(
        new SupervisorError(
          "SPAWN",
          "Session gate disconnected before confirmed adapter startup",
        ),
      );
    const onExit = (): void =>
      finish(
        new SupervisorError(
          "SPAWN",
          "Session gate exited before adapter startup",
        ),
      );
    const onMessage = (message: unknown): void => {
      if (!message || typeof message !== "object" || !("kind" in message))
        return;
      if (message.kind === "execution_failed") {
        const parsed = gateFailureSchema.safeParse(
          "failure" in message ? message.failure : null,
        );

        return finish(
          new SupervisorError(
            "SPAWN",
            "Adapter executable failed before its ACP handshake; inspect safe spawn diagnostics",
            {
              details: parsed.success
                ? { sessionCreateFailure: parsed.data }
                : undefined,
            },
          ),
        );
      }
      if (
        message.kind === "execution_started" &&
        authorized &&
        "adapterPid" in message &&
        Number.isSafeInteger(message.adapterPid) &&
        Number(message.adapterPid) > 0
      ) {
        record.adapterPid = Number(message.adapterPid);

        return finish();
      }
      if (message.kind !== "ready" || authorized) return;
      const current = state.getFence(record.runId);
      const owner = registry.get(record.sessionId);

      if (
        current?.epoch !== record.assignmentEpoch ||
        current.assignmentId !== record.assignmentId ||
        owner?.child !== child ||
        owner.intentionalShutdown ||
        record.outputTeardownStarted
      ) {
        return finish(
          new SupervisorError(
            "FENCED",
            "Session gate belongs to a superseded or released owner",
            {
              details: {
                reason: "assignment_fenced",
                runId: record.runId,
                commandEpoch: record.assignmentEpoch,
              },
            },
          ),
        );
      }
      authorized = true;
      child.send(
        {
          kind: "execute",
          binary: input.binary,
          arguments: input.arguments,
          environment: Object.fromEntries(
            Object.entries(input.environment).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          ),
        },
        (error) => {
          if (error) finish(error);
        },
      );
    };
    const timer = setTimeout(
      () =>
        finish(
          new SupervisorError(
            "EXECUTOR_UNAVAILABLE",
            "Session gate did not complete its bounded startup handoff",
          ),
        ),
      5_000,
    );

    child.on("message", onMessage);
    child.once("disconnect", onDisconnect);
    child.once("exit", onExit);
  });
}

function processOwnershipRefusal(
  obligation: SessionProcessObligation,
  context: HostProcessContext,
): SupervisorError {
  return new SupervisorError(
    "EXECUTOR_UNAVAILABLE",
    obligation.processGroup === null
      ? "This Run has pre-upgrade or interrupted unproven process ownership; reboot the host OS after upgrade, then retry reconciliation"
      : obligation.pidNamespace !== context.pidNamespace
        ? "This Run belongs to another PID namespace; restore the original namespace for reconciliation or reboot the host OS before retrying"
        : "This Run still has an unconfirmed process group from its original owner; wait for that group to retire before retrying",
    {
      details: {
        reason: "session_process_owner_unconfirmed",
        runId: obligation.runId,
        ...(obligation.hostSessionId
          ? { sessionId: obligation.hostSessionId }
          : {}),
        commandEpoch: obligation.epoch,
        stage: "process_exit",
      },
    },
  );
}

/** Live registry owners remain inspectable; missing owners require positive group or OS-boot retirement. */
export async function reconcileRunSessionProcesses(
  state: HostState,
  registry: SessionRegistry,
  runId: string,
): Promise<void> {
  state.releaseSessionProcessesFromPriorBoot();
  const context = readHostProcessContext();

  for (const obligation of state.sessionProcessesForRun(runId)) {
    if (obligation.phase === "released") {
      state.recoverReleasedSessionProcess(obligation.commandId);
      continue;
    }
    if (
      obligation.processGroup === null ||
      obligation.osBootIdentity !== context.osBootIdentity ||
      obligation.pidNamespace !== context.pidNamespace
    )
      throw processOwnershipRefusal(obligation, context);
    const entry = obligation.hostSessionId
      ? registry.get(obligation.hostSessionId)
      : undefined;
    const exact =
      entry &&
      entry.record.createdByCommandId === obligation.commandId &&
      entry.record.runId === runId &&
      entry.record.assignmentId === obligation.assignmentId &&
      entry.record.assignmentEpoch === obligation.epoch &&
      entry.record.processGroup === obligation.processGroup;

    if (
      exact &&
      entry.child.exitCode === null &&
      entry.child.signalCode === null
    )
      continue;
    if (exact && !(await waitForChildExit(entry, 0)))
      throw processOwnershipRefusal(obligation, context);
    const observed = await inspectProcessGroup(obligation.processGroup);

    if (observed.state !== "retired")
      throw processOwnershipRefusal(obligation, context);
    state.releaseSessionProcess(obligation.commandId, new Date().toISOString());
    state.recoverReleasedSessionProcess(obligation.commandId);
  }
}

/** Startup observations are bounded; unproven owners remain scoped obligations, not global admission failures. */
export async function recoverSessionProcessesOnBoot(
  state: HostState,
  registry: SessionRegistry,
): Promise<void> {
  state.releaseSessionProcessesFromPriorBoot();
  const runs = [
    ...new Set(
      state
        .pendingSessionProcesses()
        .slice(0, 32)
        .map((obligation) => obligation.runId),
    ),
  ];

  for (let index = 0; index < runs.length; index += 4) {
    const results = await Promise.allSettled(
      runs
        .slice(index, index + 4)
        .map((runId) => reconcileRunSessionProcesses(state, registry, runId)),
    );

    for (const result of results) {
      if (
        result.status === "rejected" &&
        !(
          result.reason instanceof SupervisorError &&
          result.reason.details?.reason === "session_process_owner_unconfirmed"
        )
      )
        throw result.reason;
    }
  }
}
