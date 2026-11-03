import "server-only";

import type {
  ResolvedRunnerSlot,
  RunnerResolution,
  RunnerSnapshot,
} from "@/lib/acp-runners/resolve";
import type { FlowRunnerConfig, RunnerSlot } from "@/lib/config.schema";
import type { RunAgentStepCtx } from "@/lib/flows/runner-agent";
import type { Db, LoadedRun } from "../runner-core";
import type { TaskLaunchSettingsV2Snapshot } from "@/lib/tasks/launch-types";

import { and, eq } from "drizzle-orm";

import {
  loadFlowRunnerBindings,
  loadProjectPlatformRunnerDefaults,
  loadRunnerCatalog,
} from "@/lib/acp-runners/catalog";
import {
  resolveConsensusRunner,
  snapshotRunner,
} from "@/lib/acp-runners/resolve";
import {
  mergeRunnerAdapterLaunch,
  runnerSupervisorInput,
} from "@/lib/acp-runners/spawn-intent";
import { resolveAgentLaunchRuntime } from "@/lib/agents/launch";
import { MaisterError } from "@/lib/errors";
import { runs, taskLaunchIntents } from "@/lib/db/schema";
import { retryDigest } from "@/lib/agents/retry-guards";
import { taskLaunchInputForRun } from "@/lib/tasks/launch-execution-input";
import { launchRefusal } from "@/lib/tasks/launch-resolution";

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

type ParentRunnerSlotInput = Parameters<
  typeof resolveConsensusRunnerSlot
>[0] & {
  parentRunId: string;
};

async function parentConsensusSettings(
  args: ParentRunnerSlotInput,
): Promise<TaskLaunchSettingsV2Snapshot | null> {
  const [parent] = await args.db
    .select()
    .from(runs)
    .where(
      and(eq(runs.id, args.parentRunId), eq(runs.projectId, args.projectId)),
    );

  if (!parent)
    throw launchRefusal("consensus_parent_scope_changed", "PRECONDITION");
  if (!parent.taskLaunchIntentId) {
    const admission = parent.taskAdmissionSnapshot;

    if (admission?.version === 2)
      throw launchRefusal("launch_input_snapshot_incomplete", "PRECONDITION");
    if (admission?.version !== 3) {
      if (parent.flowRevisionId !== args.flowRevisionId)
        throw launchRefusal("consensus_parent_scope_changed", "PRECONDITION");

      // Legacy runs and taskless carriers have no accepted role settings.
      // Their existing portable resolution is explicitly a separate class.
      return null;
    }
    const [origin] = await args.db
      .select()
      .from(runs)
      .where(eq(runs.id, admission.parent.parentRunId));

    if (
      !origin ||
      origin.id === parent.id ||
      origin.projectId !== parent.projectId ||
      origin.taskId !== parent.taskId ||
      parent.parentRunId !== origin.id ||
      admission.parent.parentTaskId !== origin.taskId ||
      admission.parent.rootRunId !== (origin.rootRunId ?? origin.id) ||
      parent.rootRunId !== admission.parent.rootRunId ||
      !origin.taskLaunchIntentId ||
      !origin.taskAdmissionSnapshot ||
      retryDigest(origin.taskAdmissionSnapshot) !==
        admission.parent.parentAdmissionDigest
    )
      throw launchRefusal("launch_input_snapshot_incomplete", "PRECONDITION");

    return parentConsensusSettings({ ...args, parentRunId: origin.id });
  }
  const [intent] = await args.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, parent.taskLaunchIntentId));

  if (
    !intent ||
    intent.originalRunId !== parent.id ||
    intent.projectId !== parent.projectId ||
    intent.taskId !== parent.taskId ||
    parent.flowRevisionId !== args.flowRevisionId ||
    parent.taskAdmissionSnapshot?.version !== 2 ||
    parent.taskAdmissionSnapshot.intentId !== intent.id ||
    intent.settingsSnapshot.version !== 2 ||
    intent.settingsSnapshot.kind !== "flow" ||
    intent.settingsSnapshot.flowRevisionId !== parent.flowRevisionId ||
    retryDigest(intent.settingsSnapshot) !== intent.settingsDigest ||
    !(await taskLaunchInputForRun(args.db, parent))
  )
    throw launchRefusal("launch_input_snapshot_incomplete", "PRECONDITION");

  return intent.settingsSnapshot;
}

/** Accepted roles use their original settings; live bindings only resolve legacy runs. */
export async function resolveConsensusRunnerForParent(
  args: ParentRunnerSlotInput,
): Promise<ResolvedRunnerSlot> {
  const settings = await parentConsensusSettings(args);

  if (!settings) return resolveConsensusRunnerSlot(args);
  const slots = settings.sessions.filter(
    (candidate) => candidate.sessionName === args.slotKey,
  );
  const slot = slots[0];

  if (
    slots.length !== 1 ||
    !slot.runnerResolutionTier ||
    slot.runnerId !== slot.runnerSnapshot.id
  )
    throw launchRefusal("launch_runner_snapshot_incomplete", "PRECONDITION");
  const catalog = await loadRunnerCatalog(args.db);
  const runner = catalog.find((candidate) => candidate.id === slot.runnerId);

  if (!runner?.enabled)
    throw launchRefusal("launch_runner_disabled", "PRECONDITION");
  if (!runner.ready)
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Accepted consensus role waits for its selected runner",
      { details: { reason: "launch_runner_unavailable" } },
    );
  const snapshot = snapshotRunner(runner);
  const { env: _env, provider: _provider, ...publicSnapshot } = snapshot;

  if (
    retryDigest(snapshot) !== slot.runnerConfigDigest ||
    retryDigest(publicSnapshot) !== retryDigest(slot.runnerSnapshot)
  )
    throw launchRefusal("launch_runner_changed");

  return {
    runnerId: slot.runnerId,
    runnerResolutionTier: slot.runnerResolutionTier,
    capabilityAgent: slot.runnerSnapshot.capabilityAgent,
    runnerSnapshot: snapshot,
    resolutionSource: `accepted:${args.slotKey}`,
  };
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
  parentRunId: string;
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
    const resolved = await resolveConsensusRunnerForParent({
      db: args.db,
      parentRunId: args.parentRunId,
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
