import "server-only";

import type {
  RunnerSidecarSnapshot,
  RunnerSnapshot,
} from "@/lib/acp-runners/resolve";
import type { RunAgentStepCtx } from "@/lib/flows/runner-agent";
import type { Db, LoadedRun } from "../runner-core";

import { eq } from "drizzle-orm";

import { resolveAgentLaunchRuntime } from "@/lib/agents/launch";
import {
  mergeRunnerAdapterLaunch,
  runnerSupervisorInput,
} from "@/lib/acp-runners/spawn-intent";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const { platformAcpRunners, platformRouterSidecars } =
  schemaModule as unknown as Record<string, any>;

export type ConsensusRoleRef = {
  id?: string;
  agent?: string;
  runner?: string;
};

export type ConsensusRoleRuntime = {
  roleKind: "agent" | "runner";
  roleRef: string;
  executor: LoadedRun["executor"];
  runner?: RunAgentStepCtx["runner"];
  adapterLaunch?: RunAgentStepCtx["adapterLaunch"];
  agentBinding?: { id: string };
};

function sidecarKind(row: Record<string, any>): RunnerSidecarSnapshot["kind"] {
  if (row.kind !== "ccr") {
    throw new MaisterError(
      "CONFIG",
      `consensus runner sidecar "${row.id}" has unsupported kind "${String(row.kind)}"`,
    );
  }

  return row.kind;
}

function sidecarSnapshot(row: Record<string, any>): RunnerSidecarSnapshot {
  return {
    id: row.id,
    kind: sidecarKind(row),
    lifecycle: row.lifecycle,
    configPath: row.configPath ?? null,
    baseUrl: row.baseUrl ?? null,
    healthcheckUrl: row.healthcheckUrl ?? null,
    authTokenRef: row.authTokenRef ?? null,
  };
}

function runnerSnapshotFromRow(
  row: Record<string, any>,
  sidecar: RunnerSidecarSnapshot | null,
): RunnerSnapshot {
  return {
    id: row.id,
    adapter: row.adapter,
    capabilityAgent: row.capabilityAgent,
    model: row.model,
    env: row.env,
    provider: row.provider,
    providerKind: row.provider?.kind ?? "agent_native",
    permissionPolicy: row.permissionPolicy,
    sidecar,
    sidecarId: row.sidecarId ?? null,
  };
}

export function executorFromRunnerSnapshot(
  snapshot: RunnerSnapshot,
): LoadedRun["executor"] {
  return {
    id: snapshot.id,
    executorRefId: snapshot.id,
    agent: snapshot.capabilityAgent as LoadedRun["executor"]["agent"],
    model: snapshot.model,
    env: snapshot.env ?? null,
    router: snapshot.sidecarId ? "ccr" : null,
  };
}

export async function resolveConsensusRunnerSnapshot(args: {
  db: Db;
  runnerId: string;
  roleLabel: string;
}): Promise<RunnerSnapshot> {
  const rows = await args.db
    .select()
    .from(platformAcpRunners)
    .where(eq(platformAcpRunners.id, args.runnerId));
  const row = rows[0];

  if (!row) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `${args.roleLabel} runner "${args.runnerId}" is missing`,
    );
  }
  if (!row.enabled) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `${args.roleLabel} runner "${args.runnerId}" is disabled`,
    );
  }
  if (row.readinessStatus !== "Ready") {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `${args.roleLabel} runner "${args.runnerId}" is not Ready`,
    );
  }

  let sidecar: RunnerSidecarSnapshot | null = null;

  if (row.sidecarId) {
    const sidecarRows = await args.db
      .select()
      .from(platformRouterSidecars)
      .where(eq(platformRouterSidecars.id, row.sidecarId));

    if (!sidecarRows[0]) {
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        `${args.roleLabel} runner "${args.runnerId}" references missing router sidecar "${row.sidecarId}"`,
      );
    }

    sidecar = sidecarSnapshot(sidecarRows[0]);
  }

  return runnerSnapshotFromRow(row, sidecar);
}

function roleRuntimeFromSnapshot(
  snapshot: RunnerSnapshot,
  roleKind: "agent" | "runner",
  roleRef: string,
): ConsensusRoleRuntime {
  const adapterLaunch = mergeRunnerAdapterLaunch(snapshot);

  return {
    roleKind,
    roleRef,
    executor: executorFromRunnerSnapshot(snapshot),
    runner: runnerSupervisorInput({ snapshot }),
    ...(adapterLaunch ? { adapterLaunch } : {}),
  };
}

export async function resolveConsensusRoleRuntime(args: {
  db: Db;
  projectId: string;
  taskId: string | null;
  role: ConsensusRoleRef;
  roleLabel: string;
}): Promise<ConsensusRoleRuntime> {
  if (args.role.agent) {
    const runtime = await resolveAgentLaunchRuntime({
      agentId: args.role.agent,
      projectId: args.projectId,
      taskId: args.taskId,
      trigger: { source: "flow" },
      db: args.db,
    });

    return {
      ...roleRuntimeFromSnapshot(
        runtime.resolution.runnerSnapshot,
        "agent",
        args.role.agent,
      ),
      agentBinding: { id: args.role.agent },
    };
  }

  if (args.role.runner) {
    const snapshot = await resolveConsensusRunnerSnapshot({
      db: args.db,
      runnerId: args.role.runner,
      roleLabel: args.roleLabel,
    });

    return roleRuntimeFromSnapshot(snapshot, "runner", args.role.runner);
  }

  throw new MaisterError(
    "CONFIG",
    `${args.roleLabel} must declare agent or runner`,
  );
}
