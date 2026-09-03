// ADR-166: a `@/lib/execution-host` module stand-in for unit suites that drive
// production code over a hand-rolled fake db (no execution_* tables). The
// bound client routes every host-bound call to legacy-shaped spies
// (`createSession(payload)`, `sendPrompt(sessionId, input)`,
// `deliverPermission(sessionId, requestId, optionId)`,
// `cancelPermission(sessionId, requestId, reason)`, `cancelPrompt(sessionId)`,
// `deleteSession(sessionId)`, `checkpointSession(sessionId)`,
// `listSessions()`, `streamSession(sessionId, opts)`), so a suite keeps its
// wire-level assertions while the service under test speaks the new seam.
//
//   vi.mock("@/lib/execution-host", async () =>
//     (await import("@/test-support/execution-host-module-mock"))
//       .executionHostModuleMock(spies),
//   );

import type { MaisterError } from "@/lib/errors";
import type { ScratchExecution } from "@/lib/scratch-runs/events";

type AnyFn = (...args: never[]) => unknown;

export type ExecutionHostSpies = Partial<{
  createSession: AnyFn;
  sendPrompt: AnyFn;
  deliverPermission: AnyFn;
  cancelPermission: AnyFn;
  cancelPrompt: AnyFn;
  deleteSession: AnyFn;
  checkpointSession: AnyFn;
  listSessions: AnyFn;
  streamSession: AnyFn;
}>;

function call(spies: ExecutionHostSpies, name: keyof ExecutionHostSpies) {
  return (...args: unknown[]) => {
    const fn = spies[name] as ((...a: unknown[]) => unknown) | undefined;

    if (!fn) throw new Error(`execution-host mock: ${name} not stubbed`);

    return fn(...args);
  };
}

// The wire's own rule: a 404 on DELETE /sessions/:id is the `gone` outcome.
function isGoneError(err: unknown): boolean {
  const e = err as Partial<MaisterError> | null;

  return (
    !!e &&
    typeof e === "object" &&
    (e.details as { httpStatus?: unknown } | undefined)?.httpStatus === 404
  );
}

export function executionHostModuleMock(spies: ExecutionHostSpies) {
  const boundClient = (runId: string) => ({
    assignment: { id: `assignment-${runId}`, runId, epoch: 1, state: "active" },
    host: { id: "host-1", hostKey: "eh_test" },
    async ensureWorkspace() {
      return "ws_" + "0".repeat(32);
    },
    async createSession(payload: unknown) {
      const result = (await call(spies, "createSession")(payload)) as {
        sessionId: string;
      };

      return { ...result, hostSessionId: result.sessionId };
    },
    async prompt(sessionId: string, input: unknown, opts?: unknown) {
      return {
        commandId: `cmd-${runId}`,
        completion: Promise.resolve(
          call(spies, "sendPrompt")(sessionId, input, opts),
        ),
      };
    },
    async deliverInput(
      sessionId: string,
      payload: {
        action: "select" | "cancel";
        requestId: string;
        optionId?: string;
        reason?: string;
      },
    ) {
      if (payload.action === "select") {
        await call(spies, "deliverPermission")(
          sessionId,
          payload.requestId,
          payload.optionId,
        );
      } else {
        await call(spies, "cancelPermission")(
          sessionId,
          payload.requestId,
          payload.reason,
        );
      }

      return { ok: true as const, replayed: false };
    },
    async prepareInput(
      _tx: unknown,
      sessionId: string,
      payload: {
        action: "select" | "cancel";
        requestId: string;
        optionId?: string;
        reason?: string;
      },
    ) {
      return {
        commandId: `cmd-${runId}`,
        payload,
        deliver: async (o?: {
          onAck?: (
            tx: unknown,
            result: { ok: true; replayed: boolean },
          ) => Promise<void>;
        }) => {
          const result = await boundClient(runId).deliverInput(
            sessionId,
            payload,
          );

          await o?.onAck?.(null, result);

          return result;
        },
      };
    },
    async cancelPrompt(sessionId: string) {
      const result = (await call(spies, "cancelPrompt")(sessionId)) as
        | { cancelled: boolean }
        | undefined;

      return result ?? { cancelled: false };
    },
    async checkpoint(sessionId: string) {
      const result = (await call(spies, "checkpointSession")(sessionId)) as
        | {
            alreadyCheckpointed: boolean;
            sessionId: string;
            monotonicId: number;
          }
        | undefined;

      return (
        result ?? { alreadyCheckpointed: false, sessionId, monotonicId: 1 }
      );
    },
    async deleteSession(sessionId: string) {
      try {
        const result = await call(spies, "deleteSession")(sessionId);

        return { outcome: result === "gone" ? "gone" : "terminated" } as const;
      } catch (err) {
        if (isGoneError(err)) return { outcome: "gone" } as const;
        throw err;
      }
    },
    async sessionsForRun() {
      const records = (await call(spies, "listSessions")()) as Array<{
        runId: string;
      }>;

      return records.filter((record) => record.runId === runId);
    },
  });
  const hosts = {
    transport: undefined,
    forRun: async (runId: string) => boundClient(runId),
    forAssignment: async (assignment: { id: string; runId?: string }) =>
      boundClient(assignment.runId ?? assignment.id),
    local: () => ({
      health: async () => ({ kind: "ready" }),
      listSessions: () => call(spies, "listSessions")(),
      streamSession: (...args: unknown[]) =>
        call(spies, "streamSession")(...args),
      getCommandReceipt: async () => null,
      getWorkspace: async () => null,
    }),
  };

  return {
    createExecutionHosts: () => hosts,
    executionHosts: hosts,
    // Honors a suite's `checkSupervisorHealth` stub so an "unavailable"
    // supervisor still refuses at the placement gate (EXECUTOR_UNAVAILABLE).
    localHost: async () => {
      const health = (spies as { checkSupervisorHealth?: () => unknown })
        .checkSupervisorHealth;
      const status = health
        ? ((await health()) as {
            kind?: string;
            reason?: string;
            message?: string;
          })
        : null;

      if (status?.kind === "unavailable") {
        const { MaisterError: Err } = await import("@/lib/errors");

        throw new Err(
          "EXECUTOR_UNAVAILABLE",
          `supervisor unavailable (${status.reason}): ${status.message}`,
        );
      }

      return { id: "host-1", hostKey: "eh_test" };
    },
    mintPlacement: async (_tx: unknown, input: { runId: string }) => ({
      id: `assignment-${input.runId}`,
      runId: input.runId,
      epoch: 1,
      state: "active",
    }),
    ensureAssignment: async (_db: unknown, runId: string) => ({
      id: `assignment-${runId}`,
      runId,
      epoch: 1,
      state: "active",
    }),
    releaseAssignmentForRun: async () => null,
    isFencedError: (err: unknown) =>
      (err as { details?: { reason?: string } } | null)?.details?.reason ===
      "assignment_fenced",
    isUnknownOutcome: () => false,
  };
}

// The pre-ADR-166 scratch turn seam (`{cancelPermission, sendPrompt,
// streamSession}`) as a `ScratchExecution` for suites that script turns.
export function legacyScratchApiToExecution(api: {
  cancelPermission: (
    sessionId: string,
    requestId: string,
    reason: string,
  ) => Promise<unknown>;
  sendPrompt: (
    sessionId: string,
    input: unknown,
    opts?: unknown,
  ) => Promise<unknown>;
  streamSession: (sessionId: string, opts?: unknown) => AsyncIterable<unknown>;
}): ScratchExecution {
  return {
    client: {
      async prompt(sessionId: string, input: unknown, opts?: unknown) {
        return {
          commandId: "cmd-legacy",
          completion: api.sendPrompt(sessionId, input, opts),
        };
      },
      async deliverInput(
        sessionId: string,
        payload: { requestId: string; reason?: string },
      ) {
        await api.cancelPermission(
          sessionId,
          payload.requestId,
          payload.reason ?? "",
        );

        return { ok: true as const, replayed: false };
      },
    },
    admin: {
      streamSession: (sessionId: string, opts?: unknown) =>
        api.streamSession(sessionId, opts),
    },
  } as unknown as ScratchExecution;
}
