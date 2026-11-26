import "server-only";

import type {
  CreateSessionInput,
  SupervisorDiagnosticsStatus,
} from "@/lib/execution-host";

import pino from "pino";

import { getAdapterSupportById } from "@/lib/acp-runners/adapter-support";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "agents:runner-readonly-evidence",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function assertReadOnlySessionCreateEvidence(
  payload: CreateSessionInput,
  checkDiagnostics: () => Promise<SupervisorDiagnosticsStatus>,
): Promise<void> {
  if (!payload.readOnlySession) return;
  const adapterId = payload.runner?.adapter ?? payload.executor.agent;

  await assertReadOnlySessionEvidence({
    checkDiagnostics,
    adapterId,
    runnerId: payload.runner?.runnerId ?? adapterId,
    workspace: "read-only",
  });
}

export async function assertReadOnlySessionEvidence(args: {
  readonly checkDiagnostics: () => Promise<SupervisorDiagnosticsStatus>;
  readonly adapterId: string;
  readonly runnerId: string;
  readonly workspace: "none" | "repo_read" | "worktree" | "read-only";
}): Promise<void> {
  if (args.workspace === "worktree") return;

  const support = getAdapterSupportById(args.adapterId);

  if (support?.readOnlySessionSmoke !== "required") return;

  log.debug(
    {
      runnerId: args.runnerId,
      adapterId: args.adapterId,
      workspace: args.workspace,
    },
    "evaluating agent runner read-only-session evidence",
  );

  const diagnostics = await args.checkDiagnostics();

  if (diagnostics.kind !== "ready") {
    log.warn(
      {
        runnerId: args.runnerId,
        adapterId: args.adapterId,
        workspace: args.workspace,
        evidenceStatus: "unavailable",
        evidenceReason: diagnostics.reason,
      },
      "agent runner read-only-session evidence refused",
    );
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `agent runner ${args.runnerId} (adapter ${args.adapterId}) cannot host a ${args.workspace} agent — read-only-session diagnostics are unavailable: ${diagnostics.message}`,
    );
  }

  const adapter = diagnostics.diagnostics.adapters.find(
    (item) => item.id === args.adapterId,
  );
  const genericSmoke = adapter?.smoke;
  const readOnlySession = adapter?.smoke.readOnlySession;

  if (
    !genericSmoke ||
    genericSmoke.status !== "ok" ||
    !readOnlySession ||
    readOnlySession.status !== "ok"
  ) {
    log.warn(
      {
        runnerId: args.runnerId,
        adapterId: args.adapterId,
        workspace: args.workspace,
        genericEvidenceStatus: genericSmoke?.status ?? "missing",
        genericEvidenceReason:
          genericSmoke?.reason ?? "missing_adapter_diagnostics",
        evidenceStatus: readOnlySession?.status ?? "missing",
        evidenceReason:
          readOnlySession?.reason ?? "missing_adapter_diagnostics",
        evidenceCheckedAt: readOnlySession?.checkedAt ?? null,
        evidenceProbeVersion: readOnlySession?.probeVersion ?? null,
      },
      "agent runner read-only-session evidence refused",
    );
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `agent runner ${args.runnerId} (adapter ${args.adapterId}) cannot host a ${args.workspace} agent — generic smoke is ${genericSmoke?.status ?? "missing"}; read-only-session smoke is ${readOnlySession?.status ?? "missing"}: ${readOnlySession?.reason ?? genericSmoke?.reason ?? "missing adapter diagnostics"}`,
    );
  }

  log.info(
    {
      runnerId: args.runnerId,
      adapterId: args.adapterId,
      workspace: args.workspace,
      evidenceStatus: readOnlySession.status,
      evidenceCheckedAt: readOnlySession.checkedAt,
      evidenceProbeVersion: readOnlySession.probeVersion,
    },
    "agent runner read-only-session evidence accepted",
  );
}
