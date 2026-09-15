import "server-only";

import type {
  ResolvedRunnerSlot,
  RunnerResolution,
  RunnerSnapshot,
} from "@/lib/acp-runners/resolve";
import type { FlowRunnerConfig, RunnerSlot } from "@/lib/config.schema";
import type { RunAgentStepCtx } from "@/lib/flows/runner-agent";
import type { Db, LoadedRun } from "../runner-core";

import {
  loadFlowRunnerBindings,
  loadProjectPlatformRunnerDefaults,
  loadRunnerCatalog,
} from "@/lib/acp-runners/catalog";
import { resolveConsensusRunner } from "@/lib/acp-runners/resolve";
import {
  mergeRunnerAdapterLaunch,
  runnerSupervisorInput,
} from "@/lib/acp-runners/spawn-intent";
import { resolveAgentLaunchRuntime } from "@/lib/agents/launch";
import { MaisterError } from "@/lib/errors";

export type ConsensusRoleRef = {
  id?: string;
  agent?: string;
  // M42 (ADR-114): a runner slot (profile-ref string OR inline unified config),
  // resolved portably via the per-project slot binding + intent auto-match.
  runner?: RunnerSlot;
};

export type ConsensusRoleRuntime = {
  roleKind: "agent" | "runner";
  roleRef: string;
  executor: LoadedRun["executor"];
  runner?: RunAgentStepCtx["runner"];
  adapterLaunch?: RunAgentStepCtx["adapterLaunch"];
  agentBinding?: { id: string };
  // M42 (ADR-114): the resolved runner behind this role, kept so the substep's
  // own `run_sessions` row can record the runner it actually spawned with. A
  // consensus role deliberately runs a DIFFERENT runner from the node's, which
  // is precisely the fact a snapshot-less row loses.
  resolution: RunnerResolution;
  resolutionSource: string;
};

export function executorFromRunnerSnapshot(
  snapshot: RunnerSnapshot,
): LoadedRun["executor"] {
  return {
    id: snapshot.id,
    executorRefId: snapshot.id,
    agent: snapshot.capabilityAgent as LoadedRun["executor"]["agent"],
    model: snapshot.model,
    env: snapshot.env ?? null,
  };
}

// M42 (ADR-114): resolve a consensus runner slot portably. The slot's declared
// runner intent resolves through its per-project binding
// (`consensus:<nodeId>:<participantId>` / `:synthesizer`), a compatible configured
// runner preference, or a unique intent match.
export async function resolveConsensusRunnerSlot(args: {
  db: Db;
  slot: RunnerSlot;
  slotKey: string;
  projectId: string;
  flowRevisionId: string | null;
  runDefaultRunnerId: string | null;
  runnerProfiles: Record<string, FlowRunnerConfig> | undefined;
  roleLabel: string;
}): Promise<ResolvedRunnerSlot> {
  const [runners, bindings, defaults] = await Promise.all([
    loadRunnerCatalog(args.db),
    args.flowRevisionId
      ? loadFlowRunnerBindings(args.db, args.projectId, args.flowRevisionId)
      : Promise.resolve([]),
    loadProjectPlatformRunnerDefaults(args.db, args.projectId),
  ]);

  return resolveConsensusRunner({
    slotKey: args.slotKey,
    slot: args.slot,
    runnerProfiles: args.runnerProfiles,
    binding: bindings.find((binding) => binding.slotKey === args.slotKey),
    runDefaultRunnerId: args.runDefaultRunnerId,
    project: defaults.project,
    platform: defaults.platform,
    runners,
  });
}

function roleRuntimeFromResolution(
  resolution: RunnerResolution,
  roleKind: "agent" | "runner",
  roleRef: string,
  resolutionSource: string,
): ConsensusRoleRuntime {
  const snapshot = resolution.runnerSnapshot;
  const adapterLaunch = mergeRunnerAdapterLaunch(snapshot);

  return {
    roleKind,
    roleRef,
    executor: executorFromRunnerSnapshot(snapshot),
    runner: runnerSupervisorInput({ snapshot }),
    resolution,
    resolutionSource,
    ...(adapterLaunch ? { adapterLaunch } : {}),
  };
}

export async function resolveConsensusRoleRuntime(args: {
  db: Db;
  projectId: string;
  taskId: string | null;
  flowRevisionId: string | null;
  runDefaultRunnerId: string | null;
  runnerProfiles: Record<string, FlowRunnerConfig> | undefined;
  // The slot key for this role — `consensus:<nodeId>:<participantId>` or
  // `consensus:<nodeId>:synthesizer`. Ignored for agent-bound roles.
  slotKey: string;
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
      ...roleRuntimeFromResolution(
        runtime.resolution,
        "agent",
        args.role.agent,
        `agent:${args.role.agent}`,
      ),
      agentBinding: { id: args.role.agent },
    };
  }

  if (args.role.runner !== undefined) {
    const resolved = await resolveConsensusRunnerSlot({
      db: args.db,
      slot: args.role.runner,
      slotKey: args.slotKey,
      projectId: args.projectId,
      flowRevisionId: args.flowRevisionId,
      runDefaultRunnerId: args.runDefaultRunnerId,
      runnerProfiles: args.runnerProfiles,
      roleLabel: args.roleLabel,
    });

    return roleRuntimeFromResolution(
      resolved,
      "runner",
      resolved.runnerId,
      resolved.resolutionSource,
    );
  }

  throw new MaisterError(
    "CONFIG",
    `${args.roleLabel} must declare agent or runner`,
  );
}
