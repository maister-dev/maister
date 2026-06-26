import "server-only";

import type {
  ResolvedRunnerSlot,
  RunnerSnapshot,
} from "@/lib/acp-runners/resolve";
import type { FlowRunnerConfig, RunnerSlot } from "@/lib/config.schema";
import type { RunAgentStepCtx } from "@/lib/flows/runner-agent";
import type { Db, LoadedRun } from "../runner-core";

import {
  loadFlowRunnerBindings,
  loadRunnerCatalog,
} from "@/lib/acp-runners/catalog";
import { resolveRunnerSlot } from "@/lib/acp-runners/resolve";
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
    router: snapshot.sidecarId ? "ccr" : null,
  };
}

// M42 (ADR-114): resolve a consensus runner slot portably. The slot's declared
// runner intent is bound to a concrete host runner via the per-project binding
// (`consensus:<nodeId>:<participantId>` / `:synthesizer`) or a unique intent
// auto-match — never a direct `platform_acp_runners.id` lookup baked in the
// manifest.
export async function resolveConsensusRunnerSlot(args: {
  db: Db;
  slot: RunnerSlot;
  slotKey: string;
  projectId: string;
  flowRevisionId: string | null;
  runnerProfiles: Record<string, FlowRunnerConfig> | undefined;
  roleLabel: string;
}): Promise<ResolvedRunnerSlot> {
  const [runners, bindings] = await Promise.all([
    loadRunnerCatalog(args.db),
    args.flowRevisionId
      ? loadFlowRunnerBindings(args.db, args.projectId, args.flowRevisionId)
      : Promise.resolve([]),
  ]);
  const resolved = resolveRunnerSlot({
    slotKey: args.slotKey,
    slot: args.slot,
    runnerProfiles: args.runnerProfiles,
    binding: bindings.find((binding) => binding.slotKey === args.slotKey),
    runners,
  });

  if (!resolved) {
    throw new MaisterError("CONFIG", `${args.roleLabel} must declare a runner`);
  }

  return resolved;
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
  flowRevisionId: string | null;
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
      ...roleRuntimeFromSnapshot(
        runtime.resolution.runnerSnapshot,
        "agent",
        args.role.agent,
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
      runnerProfiles: args.runnerProfiles,
      roleLabel: args.roleLabel,
    });

    return roleRuntimeFromSnapshot(
      resolved.runnerSnapshot,
      "runner",
      resolved.runnerId,
    );
  }

  throw new MaisterError(
    "CONFIG",
    `${args.roleLabel} must declare agent or runner`,
  );
}
